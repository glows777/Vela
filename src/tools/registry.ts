import { Validator } from '@cfworker/json-schema'
import type { FlexibleSchema, Tool, ToolSet } from 'ai'
import { tool as AITool, asSchema } from 'ai'
import type { VelaEventListener } from '../agent/events.ts'
import { silentLogger, type VelaLogger } from '../logger.ts'
import {
  isToolContent,
  normalizeToolContent,
  toAIToolOutput,
  toolContentText,
} from '../messages.ts'
import { classifyBashCommand } from '../security/bash-classifier.ts'
import type { HookPipeline } from '../security/hooks.ts'
import {
  decidePermission,
  type PermissionDecision,
  type PermissionRules,
} from '../security/permissions.ts'
import type { ResultRecord } from '../session/tool-history.ts'
import { ToolResultStore } from '../session/tool-results.ts'
import { prepareCallResult } from './call-result.ts'
import { createToolSearchDocument, rankTools } from './tool-ranker.ts'
import {
  type ExecuteToolOptions,
  type ToolAnnotations,
  type ToolCallOutcome,
  type ToolExecutionMode,
  ToolExecutionResult,
  type ToolExposure,
  type ToolNamespace,
  type ToolRegistryForkOptions,
  ToolResultError,
} from './types.ts'

/** Context passed to a tool's execute. */
export interface ToolContext {
  toolCallId?: string
  /** Fires when the session is interrupted (abort, close); long-running tools should honor it */
  signal?: AbortSignal
  /**
   * Reports partial output while the tool runs (like pi's `onUpdate`); each call emits a
   * `tool_execution_update` event. Calls after the tool settled are ignored.
   */
  onUpdate?: (partialResult: unknown) => void
  /**
   * Runs another tool through the same permission checks, hooks, confirmation and tool history as
   * a model-issued call (like pi's `ctx.executeTool()`). The call gets the id `<calling id>/<n>`, its
   * `tool_execution_*` events carry `parentToolCallId`, and it does not enter the conversation.
   * Never rejects for tool failures: they come back as `isError: true`.
   */
  executeTool?: (
    name: string,
    args: unknown,
    options?: ExecuteToolOptions,
  ) => Promise<ToolCallOutcome>
  /** @internal The session's tool result store (bash writes large output to files) */
  results: ToolResultStore
  /** @internal This call's id in the tool history */
  callId?: string
  /** @internal The (session-level) registry running this call (used by tool_search) */
  registry?: ToolRegistry
}

export interface ToolDefinition {
  name: string
  description: string
  // Input types differ per tool, so the registry stores them as any
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool inputs
  inputSchema: FlexibleSchema<any>
  execute: (
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool inputs
    input: any,
    context?: ToolContext,
  ) => Promise<unknown>

  /**
   * Same as pi: "sequential" tools run one at a time with the session's other tool calls;
   * "parallel" (default) tools run concurrently. Only calls of the same session wait for each
   * other. write_file / edit_file additionally queue per file across all sessions.
   */
  executionMode?: ToolExecutionMode
  /** Hints about what the tool does (MCP's tool annotations, like pi); not verified, core does not act on them */
  annotations?: ToolAnnotations
  maxResultChars?: number

  /** How the model reaches the tool (like pi). Default `direct`. See {@link ToolExposure}. */
  exposure?: ToolExposure
  /** Group the tool belongs to, for example its MCP server (like pi) */
  namespace?: ToolNamespace
  searchHint?: string // Hint shown next to the name in the deferred tool list
}

const EXPOSURES: readonly ToolExposure[] = [
  'direct',
  'model-only',
  'codemode',
  'deferred',
  'hidden',
]

/** A permission check, hook or the user turned the call down; the model gets `reason` as an error result. */
class ToolRejection {
  constructor(readonly reason: string) {}
}

/** Per call: how the call was issued */
interface CallOptions {
  toolCallId?: string
  abortSignal?: AbortSignal
  /** Set for calls a tool made through ctx.executeTool() */
  parentToolCallId?: string
  onUpdate?: (partialResult: unknown) => void
}

/**
 * State shared by all sessions of one Vela: tool definitions and hooks.
 * Permissions, tool selection, discovered deferred tools, the tool result store,
 * persistence failure state and the execution gate are per session.
 */
interface SharedToolState {
  tools: Map<string, ToolDefinition>
  hookPipeline?: HookPipeline
  logger: VelaLogger
}

/**
 * One session's tool calls: parallel calls run together; a sequential call waits for the calls
 * started before it and holds back the calls started after it (first come, first served).
 */
class ExecutionGate {
  private barrier: Promise<void> = Promise.resolve()
  private readonly running = new Set<Promise<unknown>>()

  async run<T>(mode: ToolExecutionMode, fn: () => Promise<T>): Promise<T> {
    if (mode === 'parallel') {
      await this.barrier
      const job = fn()
      this.running.add(job)
      try {
        return await job
      } finally {
        this.running.delete(job)
      }
    }
    const previous = this.barrier
    let release!: () => void
    this.barrier = new Promise((resolve) => {
      release = resolve
    })
    try {
      await previous
      await Promise.allSettled([...this.running])
      return await fn()
    } finally {
      release()
    }
  }
}

export class ToolRegistry {
  private readonly shared: SharedToolState
  private onEvent?: VelaEventListener
  private sessionId?: string

  constructor(
    readonly results = new ToolResultStore(),
    shared?: SharedToolState,
  ) {
    this.shared = shared ?? { tools: new Map(), logger: silentLogger }
  }

  /**
   * A registry for one session: shares tool definitions and hooks with this registry, but has its
   * own tool result store, discovered deferred tools, persistence state and execution gate.
   */
  fork(results: ToolResultStore, options: ToolRegistryForkOptions = {}) {
    const forked = new ToolRegistry(results, this.shared)
    forked.onEvent = options.onEvent
    forked.sessionId = options.sessionId
    forked.confirm = options.confirm
    return forked
  }

  setLogger(logger: VelaLogger): void {
    this.shared.logger = logger
  }

  private persistenceFailure: Error | undefined
  /** `ToolExecutionResult.value`s by tool call id, until the call's `tool_execution_end` takes them */
  private readonly details = new Map<string, unknown>()
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

  private permissions?: PermissionRules
  /** Tools selected for the session; undefined means no limit */
  private selection?: ReadonlySet<string>
  private confirm?: (toolName: string, input: unknown) => Promise<boolean>

  /** This session's permission rules; without them every tool is allowed */
  setPermissions(rules: PermissionRules | undefined): void {
    this.permissions = rules
  }

  /** Only these tools are visible / callable by the model; undefined removes the limit */
  setSelection(names: Iterable<string> | undefined): void {
    this.selection = names ? new Set(names) : undefined
  }

  /** This session's permission decision for a tool; unselected tools are always deny */
  decide(toolName: string): PermissionDecision {
    if (this.selection && !this.selection.has(toolName)) return 'deny'
    return decidePermission(toolName, this.permissions)
  }

  setHookPipeline(pipeline: HookPipeline): void {
    this.shared.hookPipeline = pipeline
  }

  discoveredTools = new Set<string>() // loaded with tool_search; a resumed session restores it from its history

  private readonly gate = new ExecutionGate()
  /** Sequential nested calls run one at a time (like pi's nested call queue) */
  private nestedTail: Promise<void> = Promise.resolve()
  /** Nested calls running while holding that queue: their own nested calls don't wait for it again */
  private readonly nestedHolders = new Set<string>()

  private async runNested<T>(
    mode: ToolExecutionMode,
    parentToolCallId: string,
    toolCallId: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const holds = this.nestedHolders.has(parentToolCallId)
    const exclusive = mode === 'sequential' && !holds
    let release: (() => void) | undefined
    if (exclusive) {
      const previous = this.nestedTail
      this.nestedTail = new Promise((resolve) => {
        release = resolve
      })
      await previous
    }
    if ((holds || exclusive) && toolCallId) this.nestedHolders.add(toolCallId)
    try {
      return await fn()
    } finally {
      if (toolCallId) this.nestedHolders.delete(toolCallId)
      release?.()
    }
  }

  register(...tools: ToolDefinition[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(
          `[Tool ToolRegistry] Tool with name "${tool.name}" is already registered.`,
        )
      }
      // Removed in favor of executionMode; ignoring it would silently change how the tool runs
      if ('isConcurrencySafe' in tool)
        throw new Error(
          `Tool "${tool.name}": isConcurrencySafe was removed. Drop isConcurrencySafe: true; replace isConcurrencySafe: false with executionMode: 'sequential'.`,
        )
      if ('isReadOnly' in tool)
        throw new Error(
          `Tool "${tool.name}": isReadOnly was removed. Use annotations: { readOnlyHint: true } (same as pi).`,
        )
      if (tool.exposure !== undefined && !EXPOSURES.includes(tool.exposure))
        throw new Error(
          `Tool "${tool.name}": exposure must be one of ${EXPOSURES.join(', ')}, got ${JSON.stringify(tool.exposure)}`,
        )
      if (
        tool.executionMode !== undefined &&
        tool.executionMode !== 'parallel' &&
        tool.executionMode !== 'sequential'
      )
        throw new Error(
          `Tool "${tool.name}": executionMode must be 'parallel' or 'sequential', got ${JSON.stringify(tool.executionMode)}`,
        )
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
    for (const tool of this.getActiveTools()) {
      result[tool.name] = AITool({
        description: tool.description,
        inputSchema: tool.inputSchema,
        toModelOutput: ({ output }) =>
          isToolContent(output)
            ? toAIToolOutput({ type: 'content', value: output })
            : typeof output === 'string'
              ? { type: 'text', value: output }
              : {
                  type: 'json',
                  value: JSON.parse(JSON.stringify(output ?? null)),
                },
        execute: (input: unknown, options) =>
          this.track(async () => {
            const output = await this.runCall(tool, input, {
              toolCallId: options?.toolCallId,
              abortSignal: options?.abortSignal,
            })
            // Throw the reason string. An Error would prefix "Error: " on the text the
            // model reads, and the event result would be that Error instead of the string
            // ctx.executeTool already returns. The model still reads the reason and can continue.
            if (output instanceof ToolRejection) throw output.reason
            return output
          }),
      })
    }
    return result
  }

  /** Permission checks, hooks, confirmation, execution, tool history and post hooks for one call. */
  private async runCall(
    tool: ToolDefinition,
    input: unknown,
    options: CallOptions,
  ): Promise<unknown> {
    const name = tool.name
    const mode = tool.executionMode ?? 'parallel'
    const signal = options.abortSignal
    // Permissions, hooks and ask run before the execution gate, so waiting on the user doesn't hold back other calls
    this.assertHealthy()
    const reject = async (reason: string) => {
      await this.recordRejection(
        name,
        options.toolCallId ?? crypto.randomUUID(),
        input,
        reason,
      )
      return new ToolRejection(reason)
    }
    const decision = this.decide(name)
    if (decision === 'deny') {
      return await reject(
        this.selection && !this.selection.has(name)
          ? `[Rejected] ${name} is not enabled in this session`
          : `[Rejected] ${name} is denied by this session's permissions`,
      )
    }
    const pipeline = this.shared.hookPipeline
    const hookContext = {
      sessionId: this.sessionId,
      toolCallId: options.toolCallId,
      ...(options.parentToolCallId === undefined
        ? {}
        : { parentToolCallId: options.parentToolCallId }),
      emit: (event: Parameters<VelaEventListener>[0]) => this.onEvent?.(event),
    }
    if (pipeline) {
      const pre = await pipeline.runPre(name, input, hookContext)
      if (pre.action === 'block') {
        return await reject(
          `[Blocked by hook] ${pre.reason || 'Operation blocked'}`,
        )
      }
      if (pre.action === 'modify' && pre.modifiedInput !== undefined) {
        input = pre.modifiedInput
        try {
          input = await validateInput(tool, input)
        } catch (error) {
          return await reject(
            `[Rejected] Input modified by hook is invalid: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
    if (name === 'bash') {
      const command = (input as { command?: unknown } | null)?.command
      if (typeof command !== 'string')
        return await reject('[Rejected] bash command must be a string')
      const risk = classifyBashCommand(command)
      if (risk.level === 'dangerous') {
        return await reject(
          `[Rejected] Dangerous operation detected: ${risk.reason}\nCommand: ${command}`,
        )
      }
      if (risk.level === 'moderate')
        this.onEvent?.({
          type: 'security_warning',
          toolName: name,
          reason: risk.reason ?? 'Moderate-risk command',
          command,
        })
    }
    // ask runs after hooks, on the final input, so input changed by extensions still needs approval
    if (decision === 'ask') {
      const approved = this.confirm
        ? await untilAborted(
            this.confirm(name, input).catch(() => false),
            signal,
          )
        : false
      signal?.throwIfAborted()
      if (!approved) return await reject(`[Rejected] ${name} was not approved`)
    }
    // A nested call runs inside its parent's turn at the gate (waiting there could deadlock), so
    // nested calls have their own queue
    const gated = <T>(fn: () => Promise<T>) =>
      options.parentToolCallId === undefined
        ? this.gate.run(mode, fn)
        : this.runNested(mode, options.parentToolCallId, options.toolCallId, fn)
    return await gated(async () => {
      this.shared.logger.debug(`[tools] ${name} started (${mode})`)
      this.assertHealthy()
      const history = this.results.history
      const call = await history.begin(
        name,
        options.toolCallId,
        input,
        this.results.dir,
      )
      const started = performance.now()
      let settled = false
      const onUpdate = (partialResult: unknown) => {
        if (settled || options.toolCallId === undefined) return
        this.onEvent?.({
          type: 'tool_execution_update',
          toolCallId: options.toolCallId,
          toolName: name,
          args: input,
          partialResult,
          ...(options.parentToolCallId === undefined
            ? {}
            : { parentToolCallId: options.parentToolCallId }),
        })
        options.onUpdate?.(partialResult)
      }
      let nested = 0
      const parentId = options.toolCallId ?? call.callId
      let raw: unknown
      try {
        signal?.throwIfAborted()
        raw = await tool.execute(input, {
          results: this.results,
          toolCallId: options.toolCallId,
          callId: call.callId,
          signal,
          registry: this,
          onUpdate,
          executeTool: (nestedName, args, nestedOptions = {}) =>
            this.executeTool(
              `${parentId}/${++nested}`,
              parentId,
              nestedName,
              args,
              {
                ...nestedOptions,
                signal: nestedOptions.signal ?? signal,
              },
            ),
        })
      } catch (error) {
        settled = true
        await history.append<ResultRecord>({
          type: 'tool_result',
          callId: call.callId,
          status: signal?.aborted ? 'cancelled' : 'failed',
          durationMs: performance.now() - started,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
      settled = true
      if (raw instanceof ToolExecutionResult && options.toolCallId)
        this.details.set(options.toolCallId, raw.value)
      const result = await prepareCallResult({
        raw,
        name,
        results: this.results,
        call,
        started,
        signal,
        toolCallId: options.toolCallId,
        maxResultChars: tool.maxResultChars,
        onPersistenceFailure: (error) => {
          this.persistenceFailure = error
        },
      })
      let { output } = result
      const { execution, stored } = result
      if (pipeline) {
        const post = await pipeline.runPost(name, input, output, hookContext)
        if (post.modifiedOutput !== undefined)
          output = isToolContent(post.modifiedOutput)
            ? post.modifiedOutput
            : String(post.modifiedOutput)
      }
      // Normalize after all post hooks, including replacement image payloads.
      if (isToolContent(output)) output = await normalizeToolContent(output)
      // Like pi: a failed command is an error result, with its output (and where the full output is) as the message
      if (execution.isError)
        throw new ToolResultError(
          (typeof output === 'string' ? output : toolContentText(output)) ||
            'Tool reported an error',
          typeof output === 'string' ? undefined : output,
        )
      return typeof output !== 'string'
        ? output
        : stored
          ? { ...stored, preview: output }
          : output
    })
  }

  /**
   * Whether `name` can be run through ctx.executeTool() in this session (like pi: active direct
   * tools and every codemode / deferred tool; never model-only or hidden ones).
   */
  isCallable(name: string): boolean {
    const tool = this.tools.get(name)
    if (!tool || this.decide(name) === 'deny') return false
    const exposure = tool.exposure ?? 'direct'
    return exposure !== 'model-only' && exposure !== 'hidden'
  }

  /** Runs a call a tool made through ctx.executeTool(); never rejects for tool failures. */
  private async executeTool(
    toolCallId: string,
    parentToolCallId: string,
    name: string,
    args: unknown,
    options: ExecuteToolOptions,
  ): Promise<ToolCallOutcome> {
    const event = { toolCallId, toolName: name, parentToolCallId }
    this.onEvent?.({ type: 'tool_execution_start', ...event, args })
    const started = performance.now()
    const finish = (result: unknown, isError: boolean, ran: boolean) => {
      const details = this.takeDetails(toolCallId)
      const outcome: ToolCallOutcome = {
        toolCallId,
        toolName: name,
        result,
        isError,
        ...(ran ? { durationMs: Math.round(performance.now() - started) } : {}),
      }
      this.onEvent?.({
        type: 'tool_execution_end',
        ...event,
        result,
        isError,
        ...(details === undefined || isError ? {} : { details }),
        ...(outcome.durationMs === undefined
          ? {}
          : { durationMs: outcome.durationMs }),
      })
      return outcome
    }
    const tool = this.tools.get(name)
    if (!tool || !this.isCallable(name)) {
      const reason = tool
        ? `[Rejected] ${name} cannot be called from a tool in this session`
        : `Tool ${name} not found`
      await this.recordRejection(name, toolCallId, args, reason)
      return finish(reason, true, false)
    }
    let input: unknown
    try {
      input = await validateInput(tool, args)
    } catch (error) {
      const reason = `Invalid arguments for ${name}: ${error instanceof Error ? error.message : String(error)}`
      await this.recordRejection(name, toolCallId, args, reason)
      return finish(reason, true, false)
    }
    try {
      const output = await this.track(() =>
        this.runCall(tool, input, {
          toolCallId,
          parentToolCallId,
          abortSignal: options.signal,
          onUpdate: options.onUpdate,
        }),
      )
      return output instanceof ToolRejection
        ? finish(output.reason, true, false)
        : finish(output, false, true)
    } catch (error) {
      // A failed result save stops the session, as it does for model-issued calls
      if (error === this.persistenceFailure) throw error
      return finish(
        error instanceof ToolResultError && error.content
          ? error.content
          : error instanceof Error
            ? error.message
            : String(error),
        true,
        true,
      )
    }
  }

  /** Display data (`ToolExecutionResult.value`) of a finished call, for its `tool_execution_end`; removes it. */
  takeDetails(toolCallId: string): unknown {
    const details = this.details.get(toolCallId)
    this.details.delete(toolCallId)
    return details
  }

  /** Tools declared to the model: allowed, and direct / model-only, or deferred and loaded with tool_search. */
  getActiveTools() {
    return this.getAllTools().filter((tool) => {
      if (this.decide(tool.name) === 'deny') return false
      const exposure = tool.exposure ?? 'direct'
      if (exposure === 'deferred') return this.discoveredTools.has(tool.name)
      return exposure === 'direct' || exposure === 'model-only'
    })
  }

  /** Tools tool_search can load in this session: allowed deferred tools (not yet loaded, unless `loaded`). */
  private searchableTools(loaded = false): ToolDefinition[] {
    return this.getAllTools().filter(
      (tool) =>
        tool.exposure === 'deferred' &&
        tool.name !== 'tool_search' &&
        (loaded || !this.discoveredTools.has(tool.name)) &&
        this.decide(tool.name) !== 'deny',
    )
  }

  /**
   * The deferred tools for the system prompt. Like pi, tools of a namespace (an MCP server) are not
   * listed one by one: the namespace gets one line, and tool_search finds its tools.
   */
  getDeferredToolSummary(): string {
    const deferred = this.searchableTools()
    if (deferred.length === 0) return ''

    const lines: string[] = []
    const namespaces = new Map<string, ToolDefinition[]>()
    for (const tool of deferred) {
      if (!tool.namespace) {
        lines.push(
          `- ${tool.name}${tool.searchHint ? ` — ${tool.searchHint}` : ''}`,
        )
        continue
      }
      const key = tool.namespace.name
      namespaces.set(key, [...(namespaces.get(key) ?? []), tool])
    }
    for (const [key, tools] of namespaces) {
      const description = tools.find((t) => t.namespace?.description)?.namespace
        ?.description
      const count = `${tools.length} tool${tools.length === 1 ? '' : 's'}`
      lines.push(`- ${key} (${count})${description ? ` — ${description}` : ''}`)
    }
    return [
      'These tools are available but not loaded. Call tool_search with keywords or tool names to load the ones you need:',
      ...lines,
    ].join('\n')
  }

  /**
   * Loads deferred tools for this session (like pi's tool_search). A query of comma-separated exact
   * tool names loads those tools; any other query loads the `limit` best BM25 matches over names,
   * descriptions, parameters and namespaces.
   */
  async searchTools(query: string, limit = 8): Promise<ToolDefinition[]> {
    const loadable = this.searchableTools(true)
    const names = query
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
    // Exact names also return tools loaded earlier, so asking again is harmless
    const exact = names.map((name) => loadable.find((t) => t.name === name))
    let results: ToolDefinition[]
    if (names.length > 0 && exact.every((tool) => tool !== undefined)) {
      results = exact as ToolDefinition[]
    } else {
      const candidates = loadable.filter(
        (t) => !this.discoveredTools.has(t.name),
      )
      const documents = await Promise.all(
        candidates.map(async (tool) =>
          createToolSearchDocument({
            ...tool,
            jsonSchema: await asSchema(tool.inputSchema).jsonSchema,
          }),
        ),
      )
      results = rankTools(query, documents, limit).flatMap(
        (match) => candidates.find((t) => t.name === match.name) ?? [],
      )
    }
    for (const tool of results) this.discoveredTools.add(tool.name)
    return results
  }

  countTokenEstimate(): { active: number; deferred: number; total: number } {
    let active = 0
    let deferred = 0

    const declared = new Set(this.getActiveTools().map((tool) => tool.name))
    for (const tool of this.tools.values()) {
      if (tool.exposure === 'hidden') continue
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }).length
      const tokens = Math.ceil(schemaSize / 4)

      if (declared.has(tool.name)) active += tokens
      else deferred += tokens
    }

    return { active, deferred, total: active + deferred }
  }

  unregister(name: string): boolean {
    this.discoveredTools.delete(name)
    return this.tools.delete(name)
  }
}

/** Validates (and parses) input against the tool's schema; throws when it does not match. */
async function validateInput(
  tool: ToolDefinition,
  input: unknown,
): Promise<unknown> {
  const schema = asSchema(tool.inputSchema)
  if (schema.validate) {
    const validated = await schema.validate(input)
    if (!validated.success) throw validated.error
    return validated.value
  }
  const validated = new Validator(await schema.jsonSchema).validate(input)
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors))
  return input
}

/** Awaits the promise; resolves false early if signal aborts (stop waiting for the user). */
function untilAborted(
  promise: Promise<boolean>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!signal) return promise
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const onAbort = () => resolve(false)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then((value) => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    })
  })
}
