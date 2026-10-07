import { join } from 'node:path'
import type { LanguageModel, ModelMessage } from 'ai'
import { agentLoop } from './agent'
import type { VelaEvent, VelaEventListener } from './agent/events'
import { estimateMessageTokens } from './context/defense'
import { ContextManager } from './context/manager'
import type { RequestSnapshot } from './context/request'
import type { VelaLimits } from './limits'
import type { VelaLogger } from './logger'
import type { PromptContext, PromptPipeline } from './prompt/pipelins'
import { SessionStore } from './session/index'
import type { ToolRegistry } from './tools/registry'
import { TokenTracker, type TokenStatus, type UsageTotals } from './usage/tracker'

export interface PromptOptions {
  signal?: AbortSignal
}

/** 会话 id 会成为文件名：只允许字母、数字、`.`、`_`、`-`，且不能以 `.` 开头。 */
const SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/

export function assertSessionId(id: string): void {
  if (!SESSION_ID.test(id))
    throw new Error(
      `无效的会话 id "${id}"：只允许字母、数字、. _ -，不能以 . 开头，最长 128 个字符`,
    )
}

/** 把任意字符串（例如通道名 + 发送者 id）转换成合法的会话 id。 */
export function toSessionId(raw: string): string {
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\./, '_')
  return safe.slice(0, 128) || '_'
}

/** createVela() 交给每个会话的共享部分。 */
export interface SessionDeps {
  model: LanguageModel
  limits: VelaLimits
  logger: VelaLogger
  dataDir: string
  /** Vela 级工具 registry；会话用它 fork 出自己的 */
  registry: ToolRegistry
  builder: PromptPipeline
  /** 会话事件同时交给 Vela 的订阅者 */
  forward: (event: VelaEvent, sessionId: string) => void
  onClose: (session: VelaSession) => void
}

/**
 * 一个对话：自己的消息历史、上下文压缩状态、用量、工具结果和运行锁。
 * 工具定义、记忆、知识库、skill、插件和通道由同一个 Vela 里的所有会话共享。
 */
export class VelaSession {
  readonly id: string
  readonly model: LanguageModel
  readonly limits: VelaLimits
  /** 消息历史（按顺序）。斜杠命令可以追加，SDK 使用方应当只读。 */
  readonly messages: ModelMessage[] = []
  readonly timestamps: Map<ModelMessage, number>
  readonly store: SessionStore
  readonly tracker: TokenTracker
  readonly contextManager: ContextManager
  /** 这个会话的 registry：共享工具定义，独立的工具结果和已发现的延迟工具 */
  readonly registry: ToolRegistry
  readonly activeSkills = new Set<string>()
  /** 运行锁：任一 agent loop（prompt、skill、dream、defend、ingest）运行时置位 */
  readonly busy: { locked: boolean; controller?: AbortController } = {
    locked: false,
  }

  private readonly listeners = new Set<VelaEventListener>()
  private readonly builder: PromptPipeline
  private readonly deps: SessionDeps
  private closed = false
  private running?: Promise<void>

  constructor(id: string, deps: SessionDeps) {
    assertSessionId(id)
    this.id = id
    this.deps = deps
    this.model = deps.model
    this.limits = deps.limits
    this.builder = deps.builder
    this.store = new SessionStore(id, join(deps.dataDir, '.sessions'), deps.logger)
    this.registry = deps.registry.fork(this.store.results, {
      onEvent: this.emit,
      sessionId: id,
    })
    this.tracker = new TokenTracker(join(deps.dataDir, '.usage', 'today.jsonl'))
    this.contextManager = new ContextManager(
      this.store,
      this.tracker,
      { messages: this.messages, timestamps: new Map(), summary: '' },
      this.emit,
      deps.limits,
    )
    this.timestamps = this.contextManager.state.timestamps
  }

  /** 订阅这个会话的事件；返回取消订阅的函数。 */
  subscribe(listener: VelaEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 发一个事件给这个会话的订阅者和 Vela 的订阅者。 */
  readonly emit = (event: VelaEvent): void => {
    for (const listener of this.listeners) listener(event)
    this.deps.forward(event, this.id)
  }

  promptContext(): PromptContext {
    return {
      toolCount: this.registry.getActiveTools().length,
      deferredToolSummary: this.registry.getDeferredToolSummary(),
      sessionMessageCount: this.messages.length,
      sessionId: this.id,
      toolResults: this.store.results,
      activeSkills: this.activeSkills,
    }
  }

  /** 当前会话的 system prompt（每轮请求前重新构建）。 */
  buildSystem(): string {
    return this.builder.build(this.promptContext())
  }

  /** 在发请求前整理上下文（微压缩 / 摘要）。 */
  prepareContext(
    request: RequestSnapshot,
    options?: { allowSummary?: boolean },
  ): Promise<void> {
    return this.contextManager.prepare(request, options)
  }

  /** 把当前历史写盘。 */
  save(): Promise<void> {
    return this.contextManager.save()
  }

  /** 从磁盘恢复会话；返回是否找到已有会话。 */
  async resume(): Promise<boolean> {
    if (!(await this.store.exists())) return false
    this.contextManager.restore(await this.store.loadState())
    this.tracker.setEstimatedTokens(estimateMessageTokens(this.messages))
    return true
  }

  /** 追加一条消息到历史（不触发模型）。 */
  append(message: ModelMessage): void {
    this.messages.push(message)
    this.tracker.addMessage(message)
    this.timestamps.set(message, Date.now())
    this.emit({ type: 'message', message })
  }

  /** 追加一条用户消息并跑完一次 agent loop，结束后保存会话。 */
  prompt(input: string, options: PromptOptions = {}): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error(`会话 ${this.id} 已关闭`))
    if (this.busy.locked)
      return Promise.reject(new Error('有任务正在执行中'))
    const run = this.run(input, options)
    this.running = run.then(
      () => {},
      () => {},
    )
    return run
  }

  private async run(input: string, options: PromptOptions): Promise<void> {
    const busy = this.busy
    busy.locked = true
    busy.controller = new AbortController()
    const forward = () => busy.controller?.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', forward, { once: true })
    if (options.signal?.aborted) forward()
    try {
      this.emit({ type: 'agent_start', input })
      this.append({ role: 'user', content: input })
      await agentLoop({
        model: this.model,
        systemPrompt: () => this.buildSystem(),
        toolRegistry: this.registry,
        messages: this.messages,
        tokenTracker: this.tracker,
        prepareContext: (request) => this.prepareContext(request),
        abortSignal: busy.controller.signal,
        onEvent: this.emit,
        limits: this.limits,
      })
    } finally {
      options.signal?.removeEventListener('abort', forward)
      try {
        await this.save()
      } catch (error) {
        this.emit({ type: 'session_save_failed', error })
      } finally {
        busy.locked = false
        busy.controller = undefined
      }
    }
  }

  /** 中断当前 agent loop（如果有）。 */
  abort(reason: unknown = new DOMException('用户取消当前操作', 'AbortError')) {
    const controller = this.busy.controller
    if (controller && !controller.signal.aborted) controller.abort(reason)
  }

  /** token 估算、上下文占比和本会话累计用量。 */
  get usage(): TokenStatus & { totals: UsageTotals } {
    return { ...this.tracker.status, totals: this.tracker.totals() }
  }

  /** 中断正在跑的任务，等它结束并保存，然后从 Vela 里移除。 */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.abort(new DOMException('会话已关闭', 'AbortError'))
    await this.running
    await this.registry.waitForIdle().catch(() => {})
    this.listeners.clear()
    this.deps.onClose(this)
  }
}
