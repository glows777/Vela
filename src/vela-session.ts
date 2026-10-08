import { join } from 'node:path'
import type { LanguageModel, ModelMessage } from 'ai'
import { agentLoop } from './agent/index.ts'
import type { VelaEvent, VelaEventListener } from './agent/events.ts'
import { estimateMessageTokens } from './context/defense.ts'
import type { ExtensionUI, SessionUI } from './extensions/types.ts'
import { ContextManager } from './context/manager.ts'
import { createRequestSnapshot, type RequestSnapshot } from './context/request.ts'
import type { VelaLimits } from './limits.ts'
import {
  limitsForModel,
  type ModelInfo,
  type ResolvedModel,
  reasoningOption,
  THINKING_LEVELS,
  type ThinkingLevel,
} from './models/index.ts'
import type { VelaLogger } from './logger.ts'
import type { PromptContext, PromptPipeline } from './prompt/pipeline.ts'
import type { PermissionRules, Role } from './security/roles.ts'
import { SessionStore } from './session/index.ts'
import type { SessionStorage } from './session/storage.ts'
import type { ToolRegistry } from './tools/registry.ts'
import {
  CONTEXT_WINDOW,
  TokenTracker,
  type TokenStatus,
  type UsageTotals,
} from './usage/tracker.ts'

export interface PromptOptions {
  signal?: AbortSignal
  /**
   * 会话正在跑时怎么处理这条输入（同 pi）：`steer` 插进当前任务（这一步的工具跑完、下一次模型请求前），
   * `followUp` 等当前任务结束后再跑。运行中不给会抛错；空闲时忽略。
   */
  streamingBehavior?: 'steer' | 'followUp'
}

/** 排队消息怎么取：每次取一条（默认，同 pi）或一次全取。 */
export type QueueMode = 'one-at-a-time' | 'all'

/** `vela.session(id, options)` 的选项；只在会话第一次打开时生效。 */
export interface SessionOptions {
  /** 会话角色，默认 owner（通道发送者的会话由通道决定，默认 guest） */
  role?: Role
  /** 叠加在角色上的工具权限，例如 `{ bash: 'ask' }` */
  permissions?: PermissionRules
  /** 只启用这些工具（仍受角色约束）；默认全部 */
  tools?: string[]
  /** 扩展用来和用户交互的界面；不传时没有界面（confirm 一律 false） */
  ui?: SessionUI
  /** 这个会话用的模型（`provider/id` 或 LanguageModel），默认 Vela 的模型 */
  model?: string | LanguageModel
  /** thinking 级别，默认 Vela 的（Vela 默认 medium，同 pi） */
  thinkingLevel?: ThinkingLevel
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
  /** 默认模型 */
  model: string | LanguageModel | undefined
  /** 按名字或对象找模型（含 provider 注册表） */
  resolveModel: (model: string | LanguageModel | undefined) => ResolvedModel
  thinkingLevel: ThinkingLevel
  /** 显式给的 limits；其余按模型的上下文窗口算 */
  limitOverrides: Partial<VelaLimits>
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
  /** 当前生效的上限（换模型时按新模型的上下文窗口重算） */
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
  private readonly steeringQueue: string[] = []
  private readonly followUpQueue: string[] = []
  /** steer 消息怎么取（默认 one-at-a-time，同 pi） */
  steeringMode: QueueMode = 'one-at-a-time'
  /** followUp 消息怎么取（默认 one-at-a-time，同 pi） */
  followUpMode: QueueMode = 'one-at-a-time'

  /** @internal 由 vela.session() 创建 */
  constructor(id: string, deps: SessionDeps, options: SessionOptions = {}) {
    assertSessionId(id)
    this.id = id
    this.deps = deps
    this.modelChoice = options.model ?? deps.model
    this.thinking = options.thinkingLevel ?? deps.thinkingLevel
    this.limits = limitsForModel({}, deps.limitOverrides)
    this.builder = deps.builder
    this.store = new SessionStore(
      id,
      join(deps.dataDir, 'sessions'),
      deps.logger,
      deps.sessionStorage,
      deps.temporaryDataDir,
    )
    this.hasUI = options.ui !== undefined
    this.ui = options.ui ? withDefaults(options.ui) : headlessUI(this.emit)
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
      this.limits,
    )
    this.timestamps = this.contextManager.state.timestamps
    this.store.settings = () => ({
      model:
        typeof this.modelChoice === 'string'
          ? this.resolved?.info.ref ?? this.modelChoice
          : undefined,
      thinkingLevel: this.thinking,
      ...(this.displayName ? { name: this.displayName } : {}),
    })
  }

  private displayName?: string

  /** 会话的显示名（同 pi 的 session name），随会话保存；会话列表里显示。 */
  get name(): string | undefined {
    return this.displayName
  }

  /** 设置显示名（空串清除），下次保存时写入；需要立刻写盘时再 `await save()`。 */
  setName(name: string | undefined): void {
    this.displayName = name?.trim() || undefined
  }

  /** 选定的模型（名字或对象），真正解析推迟到第一次用（扩展注册的 provider 可能还没加载完） */
  private modelChoice: string | LanguageModel | undefined
  private resolved?: ResolvedModel
  private thinking: ThinkingLevel

  private resolveModel(): ResolvedModel {
    if (!this.resolved) this.applyModel(this.deps.resolveModel(this.modelChoice))
    return this.resolved as ResolvedModel
  }

  private applyModel(resolved: ResolvedModel): void {
    this.resolved = resolved
    const limits = limitsForModel(resolved.info, this.deps.limitOverrides)
    Object.assign(this.limits, limits)
    Object.assign(this.contextManager.limits, limits)
    this.tracker.contextWindow = resolved.info.contextWindow ?? CONTEXT_WINDOW
    // 价格跟着当前模型（不按 modelId 记，不同 provider 的同名模型价格不同）
    this.tracker.setPricing(resolved.info.cost)
  }

  /** 当前模型（AI SDK 的 LanguageModel）。名字解析不了时抛错。 */
  get model(): LanguageModel {
    return this.resolveModel().model
  }

  /** 当前模型的元数据：provider、id、`provider/id`、上下文窗口等。 */
  get modelInfo(): ModelInfo {
    return this.resolveModel().info
  }

  /**
   * 换模型（同 pi 的 setModel）：`provider/id` 或 LanguageModel，从下一次 prompt() 起生效，
   * 压缩阈值按新模型的上下文窗口重算。名字解析不了时抛错、不换。按名字选的模型会随会话保存。
   */
  setModel(model: string | LanguageModel): void {
    const resolved = this.deps.resolveModel(model)
    this.modelChoice = model
    this.applyModel(resolved)
  }

  /** thinking 级别（off … max，默认 medium）。 */
  get thinkingLevel(): ThinkingLevel {
    return this.thinking
  }

  /**
   * 设置 thinking 级别（同 pi 的 setThinkingLevel），从下一次请求起生效，随会话保存。
   * 模型不支持 thinking 时 prompt() 会报错（模型条目 `reasoning: false`，或 provider 自己拒绝）。
   */
  setThinkingLevel(level: ThinkingLevel): void {
    if (!THINKING_LEVELS.includes(level))
      throw new Error(`thinking 级别只能是 ${THINKING_LEVELS.join(' / ')}`)
    this.thinking = level
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
    if (saved.name) this.displayName = saved.name
    // 旧 checkpoint 没有这个字段：保留当前级别
    if (saved.thinkingLevel && THINKING_LEVELS.includes(saved.thinkingLevel))
      this.thinking = saved.thinkingLevel
    if (saved.model) {
      // 扩展注册的 provider 要等扩展加载完才能解析
      await this.deps.extensions.ready.catch(() => {})
      try {
        this.setModel(saved.model)
      } catch (error) {
        this.deps.logger.warn(
          `[session] ${this.id} 保存的模型 ${saved.model} 不可用，继续用当前模型: ${error instanceof Error ? error.message : error}`,
        )
      }
    }
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
   * 追加一条用户消息并跑完 agent loop（同 pi 不限轮数），结束后保存会话；运行中排队的 steer / followUp
   * 也在这次 run 里跑完才 resolve（最后发 `agent_settled`）。loop 出错时，排队的消息仍会接着跑，然后再 reject。
   * 运行中要给 `streamingBehavior`（或用 steer() / followUp()），这时入队后立即 resolve。
   * owner 会话里 `/name args` 如果是扩展注册的命令，就执行命令而不发给模型（运行中也立即执行）。
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

  /** 运行中：插进当前任务，这一步的工具跑完、下一次模型请求前作为用户消息发给模型。空闲时等于 prompt()。 */
  steer(input: string): Promise<void> {
    return this.promptModel(input, { streamingBehavior: 'steer' })
  }

  /** 运行中：模型本来要结束时（没有工具调用、没有 steer）再作为用户消息接着跑。空闲时等于 prompt()。 */
  followUp(input: string): Promise<void> {
    return this.promptModel(input, { streamingBehavior: 'followUp' })
  }

  /** 清空排队的消息，返回它们（TUI 中断前把它们放回输入框）。 */
  clearQueue(): { steering: string[]; followUp: string[] } {
    const cleared = {
      steering: this.steeringQueue.splice(0),
      followUp: this.followUpQueue.splice(0),
    }
    if (cleared.steering.length || cleared.followUp.length)
      this.emitQueue()
    return cleared
  }

  /** 当前排队的消息（副本） */
  get queue(): { steering: string[]; followUp: string[] } {
    return {
      steering: [...this.steeringQueue],
      followUp: [...this.followUpQueue],
    }
  }

  /** 是否正在跑 agent loop（包括排队消息的 loop、手动压缩） */
  get isRunning(): boolean {
    return this.busy.locked
  }

  /**
   * 等 agent loop（包括排队消息的 loop、手动压缩）结束（同 pi 的 waitForIdle）。
   * 不等扩展命令：命令里可以调用 abort()，等自己会卡住。
   */
  async waitForIdle(): Promise<void> {
    while (this.running) await this.running
  }

  private emitQueue(): void {
    this.emit({ type: 'queue_update', ...this.queue })
  }

  /** 按模式从队列取：先 steer 再 followUp。 */
  private dequeue(kind: 'steering' | 'followUp'): string[] {
    const [queue, mode] =
      kind === 'steering'
        ? [this.steeringQueue, this.steeringMode]
        : [this.followUpQueue, this.followUpMode]
    const taken = queue.splice(0, mode === 'all' ? queue.length : 1)
    if (taken.length) this.emitQueue()
    return taken
  }

  /** 编辑命令之外的 `/xxx`、普通输入：空闲时开跑，运行中按 streamingBehavior 入队。 */
  private promptModel(input: string, options: PromptOptions): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`会话 ${this.id} 已关闭`))
    if (this.busy.locked) {
      // 只有 prompt 的 loop 会取队列；/defend、skill、compact 占着锁时不能排队
      if (!this.prompting || !options.streamingBehavior)
        return Promise.reject(
          new Error(
            '有任务正在执行中：用 steer() / followUp()（或 streamingBehavior）排队，或等它结束',
          ),
        )
      ;(options.streamingBehavior === 'steer'
        ? this.steeringQueue
        : this.followUpQueue
      ).push(input)
      this.emitQueue()
      return Promise.resolve()
    }
    const run = this.run(input, options)
    const running = run.then(
      () => {
        if (this.running === running) this.running = undefined
      },
      () => {
        if (this.running === running) this.running = undefined
      },
    )
    this.running = running
    return run
  }

  /** 第一次使用前：等扩展加载完，触发 session_start（只一次）。 */
  private start(): Promise<void> {
    this.started ??= this.deps.extensions.ready.then(() =>
      this.deps.extensions.sessionStart(this),
    )
    return this.started
  }

  /** prompt() 的 run 正在进行（会在结束前取完队列） */
  private prompting = false

  private async run(input: string, options: PromptOptions): Promise<void> {
    const busy = this.busy
    busy.locked = true
    this.prompting = true
    const controller = new AbortController()
    busy.controller = controller
    const forward = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', forward, { once: true })
    if (options.signal?.aborted) forward()
    let failure: { error: unknown } | undefined
    const next = () => {
      const steering = this.dequeue('steering')
      return steering.length ? steering : this.dequeue('followUp')
    }
    let saved = false
    try {
      // steer / followUp 正常在 agentLoop 里取（同 pi）；loop 因出错 / 预算 / 循环检测提前结束时
      // 剩下的消息另起一个 loop 接着跑（steer 优先）。中断后不再继续，队列留着。
      let inputs = [input]
      while (inputs.length) {
        saved = false
        try {
          await this.runLoop(inputs, controller.signal)
        } catch (error) {
          failure ??= { error }
        }
        if (controller.signal.aborted) break
        inputs = next()
        if (!inputs.length) {
          // 保存期间还可能有消息排进来：存完再看一次，之后到解锁之间没有 await
          await this.saveOrReport()
          saved = true
          inputs = next()
        }
      }
    } finally {
      options.signal?.removeEventListener('abort', forward)
      if (!saved) await this.saveOrReport()
      busy.locked = false
      busy.controller = undefined
      this.prompting = false
      this.emit({ type: 'agent_settled' })
    }
    if (failure) throw failure.error
  }

  private async saveOrReport(): Promise<void> {
    try {
      await this.save()
    } catch (error) {
      this.emit({ type: 'session_save_failed', error })
    }
  }

  /** 一次 agent loop：inputs 依次作为用户消息追加。 */
  private async runLoop(inputs: string[], signal: AbortSignal): Promise<void> {
    await this.start()
    signal.throwIfAborted()
    const { model, info } = this.resolveModel()
    // 模型不支持当前 thinking 级别时在这里报错，不发请求、不写历史
    const reasoning = reasoningOption(this.thinking, info)
    const input = inputs.join('\n\n')
    this.sections = await this.deps.extensions.beforeAgentStart(this, input)
    this.emit({ type: 'agent_start', input })
    for (const text of inputs) this.append({ role: 'user', content: text })
    await agentLoop({
      model,
      reasoning,
      systemPrompt: () => this.buildSystem(),
      toolRegistry: this.registry,
      messages: this.messages,
      tokenTracker: this.tracker,
      prepareContext: (request) => this.prepareContext(request),
      abortSignal: signal,
      onEvent: this.emit,
      limits: this.limits,
      takeSteering: () => this.dequeue('steering'),
      takeFollowUp: () => this.dequeue('followUp'),
    })
  }

  /**
   * 手动压缩上下文（同 pi 的 compact）：把较早的历史换成摘要，保留近期消息，然后保存。
   * `focus` 是摘要时优先保留的内容（pi 的 customInstructions）。会话正在跑时抛错；可以被 abort() 中断。
   */
  async compact(focus?: string): Promise<void> {
    if (this.closed) throw new Error(`会话 ${this.id} 已关闭`)
    if (this.busy.locked) throw new Error('有任务正在执行中，结束后再压缩')
    const busy = this.busy
    busy.locked = true
    const controller = new AbortController()
    busy.controller = controller
    const run = (async () => {
      await this.start()
      const request = await createRequestSnapshot(
        this.model,
        this.buildSystem(),
        this.registry.toAISDKFormat(),
        this.messages,
        controller.signal,
      )
      await this.contextManager.compact(request, focus)
    })()
    const running = run.then(
      () => {},
      () => {},
    )
    this.running = running
    try {
      await run
    } finally {
      if (this.running === running) this.running = undefined
      busy.locked = false
      busy.controller = undefined
    }
  }

  /**
   * 中断当前 agent loop 和扩展命令（如果有），等 agent loop 真正停下（同 pi 的 `await abort()`）。
   * 排队的消息留在队列里，需要的话先 clearQueue()。
   */
  async abort(
    reason: unknown = new DOMException('用户取消当前操作', 'AbortError'),
  ): Promise<void> {
    for (const controller of [this.busy.controller, ...this.commands.keys()])
      if (controller && !controller.signal.aborted) controller.abort(reason)
    await this.waitForIdle()
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
    setStatus: () => {},
    setWidget: () => {},
  }
}

/** 补上界面没实现的 setStatus / setWidget（什么都不做）。 */
function withDefaults(ui: SessionUI): ExtensionUI {
  return {
    notify: (message, level) => ui.notify(message, level),
    confirm: (title, message) => ui.confirm(title, message),
    select: (title, options) => ui.select(title, options),
    input: (title, placeholder) => ui.input(title, placeholder),
    setStatus: (key, text) => ui.setStatus?.(key, text),
    setWidget: (key, lines) => ui.setWidget?.(key, lines),
  }
}
