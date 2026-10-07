import type { Client, Transport } from '@modelcontextprotocol/client'
import { Validator } from '@cfworker/json-schema'
import type { FlexibleSchema, Tool, ToolSet } from 'ai'
import { tool as AITool, asSchema, type JSONSchema7, jsonSchema } from 'ai'
import { classifyBashCommand } from '../security/bash-classifier'
import type { VelaEventListener } from '../agent/events'
import { silentLogger, type VelaLogger } from '../logger'
import type { HookPipeline } from '../security/hooks'
import { canUseTool, type Role } from '../security/roles'
import type { ExecutionMetadata, ResultRecord } from '../session/tool-history'
import { StoredToolResult, ToolResultStore } from '../session/tool-results'

/** Internal tool return envelope: preserve native data separately from model-facing text. */
export class ToolExecutionResult {
  constructor(
    readonly value: unknown,
    readonly text: string,
    readonly execution: ExecutionMetadata = {},
  ) {}
}

export interface ToolDefinition {
  name: string
  description: string
  // 每个工具的入参类型各不相同，注册表只能统一按 any 存放
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool inputs
  inputSchema: FlexibleSchema<any>
  execute: (
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool inputs
    input: any,
    context?: {
      results: ToolResultStore
      toolCallId?: string
      callId?: string
      signal?: AbortSignal
      /** 正在执行这次调用的（会话级）registry */
      registry?: ToolRegistry
    },
  ) => Promise<unknown>

  isConcurrencySafe?: boolean
  isReadOnly?: boolean
  maxResultChars?: number

  shouldDefer?: boolean // 是否延迟加载
  searchHint?: string // 搜索提示词，帮助 ToolSearch 匹配
}

const DEFAULT_MAX_RESULT_CHARS = 3000 // 超出时保存原文，只返回预览

/**
 * 同一个 Vela 里所有会话共享的部分：工具定义、角色、hooks、执行锁、MCP 连接。
 * 已发现的延迟工具、工具结果存储和持久化失败状态是每个会话自己的。
 */
interface SharedToolState {
  tools: Map<string, ToolDefinition>
  role: Role
  hookPipeline?: HookPipeline
  // 当前锁设计的已知缺陷：
  // 1. 锁粒度是整个 ToolRegistry（以及它 fork 出的所有会话）；一个独占工具执行时，不相关的工具也会被阻塞。
  // 2. 没有资源级 lock key，无法表达“同一文件串行、不同文件并行”这类更细的关系。
  // 3. acquireConcurrent 只检查 exclusiveLock，不检查是否已有独占任务在等待，读任务可能插队写任务。
  // 4. drainQueue 会一次性唤醒所有等待者，再由 while 重新竞争，不保证严格 FIFO 公平性。
  exclusiveLock: boolean // 当前是否有独占锁持有者
  concurrentCount: number // 当前共享锁持有数
  waitQueue: Array<() => void> // 阻塞等待中的 resolve 函数
  mcpClients: Client[]
  logger: VelaLogger
}

export interface ToolRegistryForkOptions {
  /** 这个会话的事件回调（例如中等风险 bash 的 security_warning） */
  onEvent?: VelaEventListener
  /** 传给 hooks 的会话 id */
  sessionId?: string
}

export class ToolRegistry {
  private readonly shared: SharedToolState
  private onEvent?: VelaEventListener
  private sessionId?: string

  constructor(
    readonly results = new ToolResultStore(),
    shared?: SharedToolState,
  ) {
    this.shared = shared ?? {
      tools: new Map(),
      role: 'owner',
      exclusiveLock: false,
      concurrentCount: 0,
      waitQueue: [],
      mcpClients: [],
      logger: silentLogger,
    }
  }

  /**
   * 给一个会话用的 registry：和本 registry 共享工具定义、角色、hooks、锁和 MCP，
   * 但有自己的工具结果存储、已发现的延迟工具和持久化状态。
   */
  fork(results: ToolResultStore, options: ToolRegistryForkOptions = {}) {
    const forked = new ToolRegistry(results, this.shared)
    forked.onEvent = options.onEvent
    forked.sessionId = options.sessionId
    return forked
  }

  setLogger(logger: VelaLogger): void {
    this.shared.logger = logger
  }

  private persistenceFailure: Error | undefined
  private readonly active = new Set<Promise<unknown>>()

  private track<T>(run: () => Promise<T>): Promise<T> {
    const job = run()
    this.active.add(job)
    void job.then(
      () => this.active.delete(job),
      () => this.active.delete(job),
    )
    return job
  }

  async waitForIdle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active])
    this.assertHealthy()
  }

  assertHealthy(): void {
    if (this.persistenceFailure) throw this.persistenceFailure
    this.results.history.assertHealthy()
  }

  async recordRejection(
    toolName: string,
    toolCallId: string,
    input: unknown,
    error: unknown,
  ): Promise<void> {
    this.assertHealthy()
    if (this.results.history.hasAttempt(toolCallId)) return
    const call = await this.results.history.begin(toolName, toolCallId, input)
    await this.results.history.append<ResultRecord>({
      type: 'tool_result',
      callId: call.callId,
      status: 'rejected',
      durationMs: 0,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  private get tools(): Map<string, ToolDefinition> {
    return this.shared.tools
  }

  setRole(role: Role): void {
    this.shared.role = role
  }

  getRole(): Role {
    return this.shared.role
  }

  private get currentRole(): Role {
    return this.shared.role
  }

  setHookPipeline(pipeline: HookPipeline): void {
    this.shared.hookPipeline = pipeline
  }

  private discoveredTools = new Set<string>()

  // * 获取共享锁
  private async acquireConcurrent() {
    const shared = this.shared
    while (shared.exclusiveLock) {
      await new Promise<void>((resolve) => shared.waitQueue.push(resolve))
    }
    shared.concurrentCount++
  }

  // 获取独占锁
  // 等待所有共享锁释放且没有独占锁
  private async acquireExclusive() {
    const shared = this.shared
    while (shared.exclusiveLock || shared.concurrentCount > 0) {
      await new Promise<void>((resolve) => shared.waitQueue.push(resolve))
    }
    shared.exclusiveLock = true
  }

  // * 释放 共享锁
  // * 如果当前已经释放了全部，则唤醒等待队列
  private releaseConcurrent() {
    this.shared.concurrentCount--
    if (this.shared.concurrentCount === 0) {
      this.drainQueue()
    }
  }

  // * 释放独占锁，唤醒等待队列
  private releaseExclusive() {
    this.shared.exclusiveLock = false
    this.drainQueue()
  }

  private drainQueue() {
    const waiting = this.shared.waitQueue.splice(0)
    for (const resolve of waiting) {
      resolve()
    }
  }

  register(...tools: ToolDefinition[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(
          `[Tool ToolRegistry] Tool with name "${tool.name}" is already registered.`,
        )
      }
      this.tools.set(tool.name, tool)
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  toAISDKFormat(): ToolSet {
    const result: Record<string, Tool> = {}

    const activeTools = this.getActiveTools()

    for (const tool of activeTools) {
      const maxChar = tool.maxResultChars
      const excuteFn = tool.execute
      const isSafe = tool.isConcurrencySafe === true
      const name = tool.name

      result[name] = AITool({
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: (input: unknown, options) =>
          this.track(async () => {
            if (isSafe) {
              await this.acquireConcurrent()
              this.shared.logger.debug(`[tools] ${name} 获得共享锁`)
            } else {
              await this.acquireExclusive()
              this.shared.logger.debug(`[tools] ${name} 获得独占锁`)
            }
            try {
              this.assertHealthy()
              const reject = async (reason: string) => {
                await this.recordRejection(
                  name,
                  options?.toolCallId ?? crypto.randomUUID(),
                  input,
                  reason,
                )
                return reason
              }
              if (!canUseTool(this.currentRole, name)) {
                return await reject(
                  `[拒绝执行] 角色 ${this.currentRole} 无权使用 ${name}`,
                )
              }
              const pipeline = this.shared.hookPipeline
              const hookContext = {
                sessionId: this.sessionId,
                emit: (event: Parameters<VelaEventListener>[0]) =>
                  this.onEvent?.(event),
              }
              if (pipeline) {
                const pre = await pipeline.runPre(name, input, hookContext)
                if (pre.action === 'block') {
                  return await reject(
                    `[Hook 拦截] ${pre.reason || '操作被阻止'}`,
                  )
                }
                if (
                  pre.action === 'modify' &&
                  pre.modifiedInput !== undefined
                ) {
                  input = pre.modifiedInput
                  try {
                    const schema = asSchema(tool.inputSchema)
                    if (schema.validate) {
                      const validated = await schema.validate(input)
                      if (!validated.success) throw validated.error
                      input = validated.value
                    } else {
                      const validated = new Validator(
                        await schema.jsonSchema,
                      ).validate(input)
                      if (!validated.valid)
                        throw new Error(JSON.stringify(validated.errors))
                    }
                  } catch (error) {
                    return await reject(
                      `[拒绝执行] Hook 修改后的输入无效: ${error instanceof Error ? error.message : String(error)}`,
                    )
                  }
                }
              }
              if (name === 'bash') {
                const command = (input as { command?: unknown } | null)?.command
                if (typeof command !== 'string')
                  return await reject('[拒绝执行] bash command 必须是字符串')
                const risk = classifyBashCommand(command)
                if (risk.level === 'dangerous') {
                  return await reject(
                    `[拒绝执行] 检测到危险操作: ${risk.reason}\n命令: ${command}`,
                  )
                }
                if (risk.level === 'moderate')
                  this.onEvent?.({
                    type: 'security_warning',
                    toolName: name,
                    reason: risk.reason ?? '中等风险命令',
                    command,
                  })
              }
              const history = this.results.history
              const call = await history.begin(
                name,
                options?.toolCallId,
                input,
                this.results.dir,
              )
              const started = performance.now()
              let raw: unknown
              try {
                options?.abortSignal?.throwIfAborted()
                raw = await excuteFn(input, {
                  results: this.results,
                  toolCallId: options?.toolCallId,
                  callId: call.callId,
                  signal: options?.abortSignal,
                  registry: this,
                })
              } catch (error) {
                await history.append<ResultRecord>({
                  type: 'tool_result',
                  callId: call.callId,
                  status: options?.abortSignal?.aborted
                    ? 'cancelled'
                    : 'failed',
                  durationMs: performance.now() - started,
                  error: error instanceof Error ? error.message : String(error),
                })
                throw error
              }
              // Persist native results before formatting/truncating the model response.
              const value = raw instanceof ToolExecutionResult ? raw.value : raw
              const execution =
                raw instanceof ToolExecutionResult ||
                raw instanceof StoredToolResult
                  ? (raw.execution ?? {})
                  : {}
              const maxChars = maxChar ?? DEFAULT_MAX_RESULT_CHARS
              let stored = raw instanceof StoredToolResult ? raw : undefined
              let text: string
              try {
                text =
                  raw instanceof ToolExecutionResult
                    ? raw.text
                    : typeof raw === 'string'
                      ? raw
                      : (JSON.stringify(raw, null, 2) ?? String(raw))
                if (
                  !stored &&
                  (text.length > maxChars ||
                    JSON.stringify(value)?.length > maxChars)
                ) {
                  stored = await this.results.save(
                    typeof value === 'string'
                      ? value
                      : (JSON.stringify(value, null, 2) ?? String(value)),
                    name,
                    truncateResult(text, maxChars),
                    options?.toolCallId,
                    call.callId,
                  )
                }
                const record = await history.append<ResultRecord>({
                  type: 'tool_result',
                  callId: call.callId,
                  status: options?.abortSignal?.aborted
                    ? 'cancelled'
                    : execution.isError
                      ? 'failed'
                      : 'completed',
                  durationMs: performance.now() - started,
                  ...execution,
                  ...(stored
                    ? {
                        outputPath: stored.path,
                        bytes: stored.bytes,
                        format:
                          raw instanceof StoredToolResult ||
                          typeof value === 'string'
                            ? ('text' as const)
                            : ('json' as const),
                      }
                    : { output: value ?? null }),
                })
                if (stored) {
                  stored.callId = call.callId
                  stored.historySeq = record.seq
                  stored.execution = execution
                }
              } catch (error) {
                // Do not invent a terminal result when the result could not be recorded.
                const location = stored
                  ? `已保存原文路径：${stored.path}`
                  : `预留输出路径：${call.plannedOutputPath}（可能不存在或不完整）`
                const status =
                  execution.exitCode === undefined
                    ? ''
                    : ` exitCode=${execution.exitCode}`
                this.persistenceFailure = new Error(
                  `工具 ${name} 已执行，但保存工具调用结果失败；结果未确认，不要自动重跑。callId=${call.callId}${status}；${location}。原文位置也记录在 tool_call.plannedOutputPath，需核实完整性，不能据此认定调用成功。${error}`,
                )
                throw this.persistenceFailure
              }
              let output = stored ? stored.preview : text
              if (pipeline) {
                const post = await pipeline.runPost(
                  name,
                  input,
                  output,
                  hookContext,
                )
                if (post.modifiedOutput !== undefined)
                  output = String(post.modifiedOutput)
              }
              return stored ? { ...stored, preview: output } : output
            } finally {
              // 释放锁
              if (isSafe) {
                this.releaseConcurrent()
              } else {
                this.releaseExclusive()
              }
            }
          }),
      })
    }
    return result
  }

  async registerMCPServer(
    serverName: string,
    client: Client,
    transport: Transport,
  ): Promise<string[]> {
    await client.connect(transport)
    this.shared.mcpClients.push(client)

    const tools = await listAllMCPTools(client)
    const registered: string[] = []

    for (const tool of tools) {
      const prefixedName = `mcp__${serverName}__${tool.name}`
      if (this.tools.has(prefixedName)) continue

      const toolClient = client
      const originalName = tool.name

      this.register({
        name: prefixedName,
        description: `[MCP:${serverName}] ${tool.description ?? ''}`,
        inputSchema: jsonSchema(tool.inputSchema as JSONSchema7),
        // readOnlyHint is only an MCP behavior hint, not a concurrency contract.
        // Treat it as a conservative signal: unknown or mutating MCP tools run exclusively.
        isConcurrencySafe: true,
        isReadOnly: tool.annotations?.readOnlyHint === true,
        shouldDefer: true,
        searchHint: `${serverName} ${tool.name} ${tool.description}`,
        maxResultChars: 3000,
        execute: async (input, context) => {
          const result = await toolClient.callTool(
            {
              name: originalName,
              arguments: input,
            },
            { signal: context?.signal },
          )
          return new ToolExecutionResult(result, formatMCPToolResult(result), {
            isError: result.isError === true,
          })
        },
      })

      registered.push(prefixedName)
    }

    return registered
  }

  async closeAllMCP(): Promise<void> {
    for (const client of this.shared.mcpClients) {
      await client.close()
    }
    this.shared.mcpClients = []
  }

  getActiveTools() {
    return this.getAllTools().filter((tool) => {
      if (!canUseTool(this.currentRole, tool.name)) {
        return false
      }
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        return false
      }
      return true
    })
  }

  getDeferredToolSummary(): string {
    const deferred = this.getAllTools().filter((tool) => {
      return tool.shouldDefer && !this.discoveredTools.has(tool.name)
    })

    if (deferred.length === 0) return ''

    const lines = deferred.map((t) => {
      const hint = t.searchHint ? ` — ${t.searchHint}` : ''
      return `  - ${t.name}${hint}`
    })
    // 以下工具可用，但需要先通过 tool_search 搜索获取完整定义
    return `\nBelow tools can be call, but before you call these tools, you should call too_search tool to get the competed tool schema
    ${lines.join('\n')}`
  }

  searchTools(query: string): ToolDefinition[] {
    const q = query.trim()
    const results: ToolDefinition[] = []

    const names = q.includes(',')
      ? q
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean)
      : [q]

    for (const name of names) {
      const tool = this.tools.get(name)
      if (tool && tool.name !== 'tool_search') {
        results.push(tool)
        this.discoveredTools.add(tool.name)
      }
    }
    return results
  }

  countTokenEstimate(): { active: number; deferred: number; total: number } {
    let active = 0
    let deferred = 0

    for (const tool of this.tools.values()) {
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }).length
      const tokens = Math.ceil(schemaSize / 4)

      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        deferred += tokens
      } else {
        active += tokens
      }
    }

    return { active, deferred, total: active + deferred }
  }

  unregister(name: string): boolean {
    this.discoveredTools.delete(name)
    return this.tools.delete(name)
  }
}

function truncateResult(text: string, maxChars: number) {
  if (text.length <= maxChars) return text

  let headSize = Math.floor(maxChars * 0.6)
  const tailSize = maxChars - headSize
  if (
    text.charCodeAt(headSize - 1) >= 0xd800 &&
    text.charCodeAt(headSize - 1) <= 0xdbff
  )
    headSize--
  let tailStart = text.length - tailSize
  if (
    text.charCodeAt(tailStart) >= 0xdc00 &&
    text.charCodeAt(tailStart) <= 0xdfff
  )
    tailStart++
  const head = text.slice(0, headSize)
  const tail = text.slice(tailStart)
  const dropped = text.length - head.length - tail.length

  return `${head}\n\n[preview: first ${head.length} and last ${tail.length} of ${text.length} UTF-16 code units; ${dropped} omitted here, full output saved]\n\n${tail}`
}

async function listAllMCPTools(client: Client) {
  const tools: Awaited<ReturnType<Client['listTools']>>['tools'] = []
  let cursor: string | undefined

  do {
    const result = await client.listTools(cursor ? { cursor } : undefined)
    tools.push(...result.tools)
    cursor = result.nextCursor
  } while (cursor)

  return tools
}

function formatMCPToolResult(
  result: Awaited<ReturnType<Client['callTool']>>,
): string {
  const content = result.content
    .map((block) => {
      if (block.type === 'text') {
        return block.text
      }
      return JSON.stringify(block, null, 2)
    })
    .filter((text) => text.length > 0)
    .join('\n')
  const structuredContent = result.structuredContent
    ? `\n\nstructuredContent:\n${JSON.stringify(result.structuredContent, null, 2)}`
    : ''
  const errorPrefix = result.isError ? '[MCP tool error]\n' : ''

  return `${errorPrefix}${content}${structuredContent}` || 'empty response'
}
