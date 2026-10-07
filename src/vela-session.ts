import { join } from 'node:path'
import type { LanguageModel, ModelMessage } from 'ai'
import { agentLoop } from './agent'
import type { VelaEvent, VelaEventListener } from './agent/events'
import { estimateMessageTokens } from './context/defense'
import type { ExtensionUI } from './extensions/types'
import { ContextManager } from './context/manager'
import type { RequestSnapshot } from './context/request'
import type { VelaLimits } from './limits'
import type { VelaLogger } from './logger'
import type { PromptContext, PromptPipeline } from './prompt/pipelins'
import type { PermissionRules, Role } from './security/roles'
import { SessionStore } from './session/index'
import type { SessionStorage } from './session/storage'
import type { ToolRegistry } from './tools/registry'
import {
  TokenTracker,
  type TokenStatus,
  type UsageTotals,
} from './usage/tracker'

export interface PromptOptions {
  signal?: AbortSignal
}

/** `vela.session(id, options)` 的选项；只在会话第一次打开时生效。 */
export interface SessionOptions {
  /** 会话角色，默认 owner（通道发送者的会话由通道决定，默认 guest） */
  role?: Role
  /** 叠加在角色上的工具权限，例如 `{ bash: 'ask' }` */
  permissions?: PermissionRules
  /** 只启用这些工具（仍受角色约束）；默认全部 */
  tools?: string[]
  /** 扩展用来和用户交互的界面；不传时没有界面（confirm 一律 false） */
  ui?: ExtensionUI
}

/** 扩展运行时在会话生命周期里要做的事（createVela 提供）。 */
export interface SessionExtensionHooks {
  /** 所有扩展加载完成 */
  ready: Promise<void>
  sessionStart(session: VelaSession): Promise<void>
  sessionShutdown(session: VelaSession): Promise<void>
  beforeAgentStart(
    session: VelaSession,
    prompt: string,
  ): Promise<Record<string, string>>
  runCommand(
    session: VelaSession,
    text: string,
    signal: AbortSignal,
  ): Promise<boolean>
}

/** 会话 id 会成为文件名：只允许字母、数字、`.`、`_`、`-`，且不能以 `.` 开头。 */
const SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/

export function assertSessionId(id: string): void {
  if (!SESSION_ID.test(id))
    throw new Error(
      `无效的会话 id "${id}"：只允许字母、数字、. _ -，不能以 . 开头，最长 128 个字符`,
    )
}

/** createVela() 交给每个会话的共享部分。 */
export interface SessionDeps {
  model: LanguageModel
  limits: VelaLimits
  logger: VelaLogger
  dataDir: string
  /** 会话历史存哪（文件 / 内存 / 自定义） */
  sessionStorage: SessionStorage
  /** dataDir 是 dispose() 会删掉的临时目录（没给 dataDir）：恢复时工具历史可能已经不在了 */
  temporaryDataDir?: boolean
  /** Vela 级工具 registry；会话用它 fork 出自己的 */
  registry: ToolRegistry
  builder: PromptPipeline
  extensions: SessionExtensionHooks
  /** 会话事件同时交给 Vela 的订阅者 */
  forward: (event: VelaEvent, sessionId: string) => void
  onClose: (session: VelaSession) => void
}

/**
 * 一个对话：自己的消息历史、上下文压缩状态、用量、工具结果、角色和运行锁。
 * 工具定义、扩展、记忆、知识库、skill 和通道由同一个 Vela 里的所有会话共享。
 */
export class VelaSession {
  readonly id: string
  readonly model: LanguageModel
  readonly limits: VelaLimits
  /** 消息历史（按顺序）。SDK 使用方应当只读，追加用 append()。 */
  readonly messages: ModelMessage[] = []
  /** @internal */
  readonly timestamps: Map<ModelMessage, number>
  /** @internal */
  readonly store: SessionStore
  /** @internal */
  readonly tracker: TokenTracker
  /** @internal */
  readonly contextManager: ContextManager
  /** @internal 这个会话的 registry：共享工具定义，独立的工具结果、权限和已发现的延迟工具 */
  readonly registry: ToolRegistry
  /** @internal */
  readonly activeSkills = new Set<string>()
  /** @internal 运行锁：任一 agent loop（prompt、skill、dream、defend、ingest）运行时置位 */
  readonly busy: { locked: boolean; controller?: AbortController } = {
    locked: false,
  }
  /** @internal 扩展的界面 */
  readonly ui: ExtensionUI
  /** @internal 是否有真正的界面 */
  readonly hasUI: boolean

  private readonly listeners = new Set<VelaEventListener>()
  private readonly builder: PromptPipeline
  private readonly deps: SessionDeps
  private closed = false
  private started?: Promise<void>
  private running?: Promise<void>
  /** 这一轮 before_agent_start 收集到的扩展段落 */
  private sections: Record<string, string> = {}

  /** @internal 由 vela.session() 创建 */
  constructor(id: string, deps: SessionDeps, options: SessionOptions = {}) {
    assertSessionId(id)
    this.id = id
    this.deps = deps
    this.model = deps.model
    this.limits = deps.limits
    this.builder = deps.builder
    this.store = new SessionStore(
      id,
      join(deps.dataDir, 'sessions'),
      deps.logger,
      deps.sessionStorage,
      deps.temporaryDataDir,
    )
    this.hasUI = options.ui !== undefined
    this.ui = options.ui ?? headlessUI(this.emit)
    this.registry = deps.registry.fork(this.store.results, {
      onEvent: this.emit,
      sessionId: id,
      confirm: (toolName, input) =>
        this.ui.confirm(
          `允许执行 ${toolName}？`,
          JSON.stringify(input, null, 2) ?? '',
        ),
    })
    this.registry.setRole(options.role ?? 'owner')
    this.registry.setPermissions(options.permissions)
    this.registry.setSelection(options.tools)
    this.tracker = new TokenTracker(join(deps.dataDir, 'usage', 'today.jsonl'))
    this.contextManager = new ContextManager(
      this.store,
      this.tracker,
      { messages: this.messages, timestamps: new Map(), summary: '' },
      this.emit,
      deps.limits,
    )
    this.timestamps = this.contextManager.state.timestamps
  }

  /** 会话角色：决定能用哪些工具（owner / collaborator / guest），也决定能否执行扩展命令。 */
  get role(): Role {
    return this.registry.getRole()
  }

  set role(role: Role) {
    this.registry.setRole(role)
  }

  /** 模型当前能看到的工具名（角色、工具选择和延迟加载都已考虑）。 */
  getActiveTools(): string[] {
    return this.registry.getActiveTools().map((tool) => tool.name)
  }

  /** 只启用这些工具（仍受角色约束）；传 undefined 恢复全部。同 pi 的 setActiveTools。 */
  setActiveTools(names: string[] | undefined): void {
    this.registry.setSelection(names)
  }

  /** 正在执行的扩展命令（命令不占运行锁，可以同时跑几个，命令里也可以再调用 prompt()） */
  private readonly commands = new Map<AbortController, Promise<boolean>>()

  /** @internal 正在跑（agent loop 或扩展命令）时的中断信号 */
  get signal(): AbortSignal | undefined {
    return (
      this.busy.controller?.signal ?? this.commands.keys().next().value?.signal
    )
  }

  /** 订阅这个会话的事件；返回取消订阅的函数。 */
  subscribe(listener: VelaEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** @internal 发一个事件给这个会话的订阅者和 Vela 的订阅者。 */
  readonly emit = (event: VelaEvent): void => {
    for (const listener of this.listeners) listener(event)
    this.deps.forward(event, this.id)
  }

  /** @internal `sections` 默认是这一轮 before_agent_start 收集到的段落 */
  promptContext(sections = this.sections): PromptContext {
    return {
      role: this.role,
      extensionSections: sections,
      toolCount: this.registry.getActiveTools().length,
      deferredToolSummary: this.registry.getDeferredToolSummary(),
      sessionMessageCount: this.messages.length,
      sessionId: this.id,
      toolResults: this.store.results,
      activeSkills: this.activeSkills,
    }
  }

  /** @internal 当前会话的 system prompt（每轮请求前重新构建）。 */
  buildSystem(sections?: Record<string, string>): string {
    return this.builder.build(this.promptContext(sections))
  }

  /**
   * @internal 下一次 prompt 会得到的扩展段落：跑一遍 before_agent_start，但不替换这一轮的段落
   * （/context 预览用；段落每次 prompt 才算，还没 prompt 过时这一轮的段落是空的）。
   */
  async previewSections(): Promise<Record<string, string>> {
    await this.start()
    return this.deps.extensions.beforeAgentStart(this, '')
  }

  /** @internal 在发请求前整理上下文（微压缩 / 摘要）。 */
  prepareContext(
    request: RequestSnapshot,
    options?: { allowSummary?: boolean },
  ): Promise<void> {
    return this.contextManager.prepare(request, options)
  }

  /** @internal 把当前历史写盘。 */
  save(): Promise<void> {
    return this.contextManager.save()
  }

  /** 从会话存储恢复历史（替换内存里的历史）；返回是否找到已有会话。运行中不能恢复。 */
  async resume(): Promise<boolean> {
    if (this.busy.locked)
      throw new Error(`会话 ${this.id} 正在运行，不能恢复历史`)
    const saved = await this.store.loadSaved()
    if (!saved) return false
    this.contextManager.restore(saved)
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

  /**
   * 追加一条用户消息并跑完一次 agent loop，结束后保存会话。
   * owner 会话里 `/name args` 如果是扩展注册的命令，就执行命令而不发给模型。
   */
  prompt(input: string, options: PromptOptions = {}): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`会话 ${this.id} 已关闭`))
    if (input.startsWith('/'))
      return (async () => {
        await this.start()
        if (await this.runCommand(input, options.signal)) return
        return this.promptModel(input, options)
      })()
    return this.promptModel(input, options)
  }

  /** 执行扩展命令；abort() 和 options.signal 会中断命令的 ctx.signal。 */
  private async runCommand(input: string, signal?: AbortSignal) {
    const controller = new AbortController()
    const forward = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', forward, { once: true })
    if (signal?.aborted) forward()
    const task = this.deps.extensions.runCommand(this, input, controller.signal)
    this.commands.set(controller, task)
    try {
      return await task
    } finally {
      this.commands.delete(controller)
      signal?.removeEventListener('abort', forward)
    }
  }

  private promptModel(input: string, options: PromptOptions): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`会话 ${this.id} 已关闭`))
    if (this.busy.locked) return Promise.reject(new Error('有任务正在执行中'))
    const run = this.run(input, options)
    this.running = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /** 第一次使用前：等扩展加载完，触发 session_start（只一次）。 */
  private start(): Promise<void> {
    this.started ??= this.deps.extensions.ready.then(() =>
      this.deps.extensions.sessionStart(this),
    )
    return this.started
  }

  private async run(input: string, options: PromptOptions): Promise<void> {
    const busy = this.busy
    busy.locked = true
    busy.controller = new AbortController()
    const forward = () => busy.controller?.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', forward, { once: true })
    if (options.signal?.aborted) forward()
    try {
      await this.start()
      busy.controller.signal.throwIfAborted()
      this.sections = await this.deps.extensions.beforeAgentStart(this, input)
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

  /** 中断当前 agent loop 和扩展命令（如果有）。 */
  abort(reason: unknown = new DOMException('用户取消当前操作', 'AbortError')) {
    for (const controller of [this.busy.controller, ...this.commands.keys()])
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
    // 先等扩展命令收尾（/dream 这类命令自己也在等它发起的 prompt）
    await Promise.allSettled(this.commands.values())
    await this.running
    await this.registry.waitForIdle().catch(() => {})
    // 只有触发过 session_start 的会话才发 session_shutdown
    if (this.started) {
      await this.started.catch(() => {})
      await this.deps.extensions.sessionShutdown(this)
    }
    this.listeners.clear()
    this.deps.onClose(this)
  }
}

/** 没有界面时的 ExtensionUI：notify 变成事件，需要回答的一律按“否 / 没有回答”处理（同 pi）。 */
function headlessUI(emit: (event: VelaEvent) => void): ExtensionUI {
  return {
    notify: (message, level = 'info') =>
      emit({ type: 'notify', message, level }),
    confirm: async () => false,
    select: async () => undefined,
    input: async () => undefined,
  }
}
