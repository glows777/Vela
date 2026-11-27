import { supportedThinkingLevels } from '../providers/models/catalog.ts'
import {
  type ModelInfo,
  type ResolvedModel,
  reasoningOption,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '../providers/models/index.ts'
import type { VelaLimits } from '../shared/limits.ts'
import type { ModelInput, ReasoningOption } from '../shared/provider-types.ts'
import type {
  CustomMessage,
  CustomMessageInfo,
  VelaEvent,
  VelaEventListener,
} from './agent/events.ts'
import type { ContextManager } from './context/manager.ts'
import type { RequestSnapshot } from './context/request.ts'
import { abortable, resolveLocation } from './execution/location.ts'
import type { ExecutionLocation } from './execution/types.ts'
import type {
  BeforeAgentStartResult,
  InputSource,
} from './extensions/events.ts'
import type { ImageContent, ModelMessage, TextContent } from './messages.ts'
import type { PromptContext } from './prompt/index.ts'
import {
  defaultAbortError,
  restoreBranchState,
  type SessionDefaultState,
  splitUserMessageContent,
} from './session/defaults.ts'
import type {
  SessionDeps as SessionDependencies,
  ForkResult as SessionForkResult,
} from './session/deps.ts'
import { shutdownSession, waitForDrain } from './session/drain.ts'
import {
  assertCustomType,
  type SessionContext,
  type SessionEntry,
  type SessionTreeNode,
} from './session/entries.ts'
import type { SessionStore } from './session/index.ts'
import type { MessageQueue } from './session/message-queue.ts'
import {
  assertSessionId,
  type ForkOptions,
  type NavigateTreeOptions,
  type PromptOptions,
  type QueueMode,
  type SendMessageOptions,
  type SessionOptions,
  type SessionPersistence,
  type SessionUsage,
} from './session/options.ts'
import { assertInterruptedTurn } from './session/recovery.ts'
import type { SessionResources } from './session/resources.ts'
import {
  cloneSessionBranch,
  exportSessionBranch,
  forkSessionBranch,
  navigateSessionTree,
  seedSessionFromBranch,
} from './session/session-branch.ts'
import {
  applySessionResolvedModel,
  bindInitialRouting,
  buildSessionHosts,
  createSessionComponents,
  dispatchSessionEvent,
  getHookedSessionModel,
  recordSessionMessage,
  registerSessionQueueRunner,
  runExclusiveSessionTask,
  runLocationGate,
} from './session/session-init.ts'
import {
  promptSessionInput,
  sendSessionCustomMessage,
} from './session/session-input.ts'
import {
  restoreSessionHistory,
  switchSessionLocation,
} from './session/session-location.ts'
import {
  runSessionCompaction,
  runSessionQueue,
} from './session/session-runner.ts'
import type { UserBash } from './session/user-bash.ts'
import type { SessionWork } from './session/work.ts'
import {
  type ApprovalDecision,
  listPendingApprovals,
  type PendingApprovalInfo,
  type ResolvedApprovalInfo,
  resolveApproval as resolveApprovalRecord,
} from './step-recovery.ts'
import type { ToolRegistry } from './tools/registry.ts'
import type { BashResult } from './tools/shell.ts'
import type { TokenTracker } from './usage/tracker.ts'
import type { VelaDriver } from './vela-driver.ts'

registerSessionQueueRunner(runSessionQueue)

/** What `fork()` / `clone()` returns. */
export interface ForkResult extends SessionForkResult<VelaSession> {}

/** Shared parts createVela() hands to every session. */
export type SessionDeps = SessionDependencies<VelaSession>

/**
 * One conversation: its own message history, compaction state, usage, tool results and run lock.
 * Tool definitions, extensions, memory, knowledge base, skills and channels are shared by all sessions in the same Vela.
 */
export class VelaSession {
  readonly id: string
  /** Effective working directory; not a filesystem sandbox. */
  readonly cwd: string
  private position: Readonly<ExecutionLocation>
  private moving = false
  /** Limits in effect (recomputed from the new model's context window on model switch) */
  readonly limits: VelaLimits
  /** Message history (in order). SDK users should treat it as read-only and use append() to add. */
  readonly messages: ModelMessage[] = []
  /** @internal */ readonly timestamps: Map<ModelMessage, number>
  /** @internal */ readonly store: SessionStore
  /** @internal */ readonly tracker: TokenTracker
  /** @internal */ readonly contextManager: ContextManager
  /** @internal */ execEnv = (signal?: AbortSignal) =>
    abortable(this.deps.resolveExecution(this), signal)
  /** @internal */ readonly registry: ToolRegistry
  /** @internal */ readonly busy: {
    locked: boolean
    controller?: AbortController
  } = {
    locked: false,
  }
  private readonly listeners = new Set<VelaEventListener>()
  private readonly toolDetails = new Map<string, unknown>()
  private readonly userBash: UserBash
  private readonly deps: SessionDeps
  private closed = false
  private draining = false
  private drained?: Promise<void>
  private closing?: Promise<void>
  private started?: Promise<void>
  private running?: Promise<void>
  private turn: BeforeAgentStartResult = { sections: {}, messages: [] }
  /** @internal */ readonly driver: VelaDriver
  private readonly messageQueue: MessageQueue
  /** How steer messages are taken (default one-at-a-time, like pi) */
  steeringMode: QueueMode = 'one-at-a-time'
  private displayName?: string
  private readonly defaults: SessionDefaultState
  /** @internal */ readonly backgroundWork: SessionWork
  private readonly commands = new Map<AbortController, Promise<void>>()
  private prompting = false
  /** Channel this session answers on. Open supplies it, and `resume()` restores a saved one. */
  channel?: string
  private readonly hosts: ReturnType<typeof buildSessionHosts<VelaSession>>

  /** @internal Created by vela.session() */
  constructor(id: string, deps: SessionDeps, options: SessionOptions = {}) {
    assertSessionId(id)
    this.id = id
    this.position = resolveLocation(options.location, deps.cwd, options.cwd)
    this.cwd = this.position.cwd
    if (this.position.environment !== 'local' && !deps.hasResolver) {
      throw new Error(
        `Execution environment unavailable for ${this.position.environment}:${this.cwd}`,
      )
    }
    this.deps = deps
    const parts = createSessionComponents({
      id,
      cwd: this.cwd,
      location: this.position,
      deps,
      options,
      messages: this.messages,
      busy: this.busy,
      emit: this.emit,
      save: () => this.save(),
      prepare: (signal) => this.execEnv(signal),
      start: (signal) => this.start(signal),
      isClosed: () => this.closed,
      isDraining: () => this.draining,
      isMoving: () => this.moving,
    })
    this.backgroundWork = parts.backgroundWork
    this.defaults = parts.defaults
    this.limits = parts.limits
    this.store = parts.store
    this.registry = parts.registry
    this.tracker = parts.tracker
    this.driver = parts.driver
    this.contextManager = parts.contextManager
    this.timestamps = parts.contextManager.state.timestamps
    this.userBash = parts.userBash
    this.messageQueue = parts.messageQueue
    bindInitialRouting(this, options)
    this.hosts = buildSessionHosts<VelaSession>({
      ...parts,
      id,
      session: this,
      deps,
      options,
      messages: this.messages,
      toolDetails: this.toolDetails,
      busy: this.busy,
      commands: this.commands,
      getStarted: () => this.started,
      resetForSwitch: (target) => {
        this.position = target
        Object.assign(this, { cwd: target.cwd })
        this.started = undefined
        this.turn = { sections: {}, messages: [] }
      },
      setDisplayName: (name) => {
        this.displayName = name
      },
      getLocation: () => this.location,
      getName: () => this.name,
      getChannel: () => this.channel,
      getParentSession: () => this.parentSession,
      getAutoCompaction: () => this.autoCompaction,
      getModel: () => this.model,
      getMaxTokens: () => this.modelInfo.maxTokens,
      getThinkingLevel: () => this.thinkingLevel,
      isDraining: () => this.draining,
      drainError: () => this.drainError(),
      isClosed: () => this.closed,
      isMoving: () => this.moving,
      isPrompting: () => this.prompting,
      setPrompting: (value) => {
        this.prompting = value
      },
      setTurn: (turn) => {
        this.turn = turn
      },
      exclusive: (what, task) => this.exclusive(what, task),
      start: (signal) => this.start(signal),
      startExtensions: () => this.startExtensions(),
      prepare: (signal) => this.prepare(signal),
      loadBranch: (ctx) => this.loadBranch(ctx),
      selectModel: (model) => this.selectModel(model, false),
      resolveModel: () => this.resolveModel(),
      requestModel: () => this.requestModel(),
      buildSystem: () => this.buildSystem(),
      prepareContext: (req, opts) => this.prepareContext(req, opts),
      save: () => this.save(),
      append: (msg) => this.append(msg),
      emit: this.emit,
      dequeueSteering: () => this.dequeueSteering(),
      trackRun: (run) => this.trackRun(run),
      execEnv: (signal) => this.execEnv(signal),
    })
  }

  /** Current trusted execution target, restored from the session transcript. */
  get location(): Readonly<ExecutionLocation> {
    return this.position
  }

  /** Prepare and persist an idle session's target before switching its prompt and tools. */
  async setLocation(location: ExecutionLocation): Promise<void> {
    if (!location) throw new Error('Invalid execution location')
    const target = resolveLocation(location, this.deps.cwd)
    return this.locationTask((signal) =>
      switchSessionLocation(this.hosts.location(), target, signal),
    )
  }

  private locationTask<T>(
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return runLocationGate({
      locked: this.busy.locked,
      isBashRunning: this.isBashRunning,
      hasWork: this.hasWork,
      hasCommands: this.commands.size > 0,
      hasActiveCalls: this.registry.hasActiveCalls,
      setMoving: (value) => {
        this.moving = value
      },
      exclusive: (what, fn) => this.exclusive(what, fn),
      task,
    })
  }

  get name(): string | undefined {
    return this.displayName
  }

  setName(name: string | undefined): void {
    const next = name?.replace(/[\r\n]+/g, ' ').trim() || undefined
    if (next === this.displayName) return
    this.displayName = next
    this.store.setSessionName(next)
  }

  private resolveModel(): ResolvedModel {
    if (
      this.defaults.resolved &&
      this.defaults.resolvedChannel !== this.channel
    ) {
      this.defaults.resolved = undefined
      this.defaults.hooked = undefined
    }
    if (!this.defaults.resolved) {
      applySessionResolvedModel({
        resolved: this.deps.resolveModel(this.defaults.modelChoice, this),
        defaults: this.defaults,
        limits: this.limits,
        contextManager: this.contextManager,
        tracker: this.tracker,
      })
      this.defaults.resolvedChannel = this.channel
    }
    return this.defaults.resolved as ResolvedModel
  }

  notify(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    this.emit({ type: 'notify', message, level })
  }

  private requestModel(): ModelInput {
    return getHookedSessionModel(this, this.deps, this.defaults, this.model)
  }

  /** @internal Hook-wrapped model and reasoning level as sent in requests. */
  inspectToolOptions(): { model: ModelInput; reasoning?: ReasoningOption } {
    const { info } = this.resolveModel()
    return {
      model: this.requestModel(),
      reasoning: reasoningOption(this.defaults.thinkingLevelFor(info), info),
    }
  }

  get model(): ModelInput {
    return this.resolveModel().model
  }

  get modelInfo(): ModelInfo {
    return this.defaults.info(this.resolveModel(), this.deps, this.channel)
  }

  setModel(model: ModelInput): void {
    this.selectModel(model, true)
    this.defaults.modelPinned = true
  }

  private selectModel(model: ModelInput, record: boolean): void {
    const resolved = this.deps.resolveModel(model, this)
    const thinking = this.thinkingLevel
    this.defaults.modelChoice = model
    applySessionResolvedModel({
      resolved,
      defaults: this.defaults,
      limits: this.limits,
      contextManager: this.contextManager,
      tracker: this.tracker,
    })
    this.defaults.resolvedChannel = this.channel
    if (record && typeof model === 'string')
      this.store.setModelChoice(resolved.info.ref ?? model)
    if (record && this.thinkingLevel !== thinking)
      this.store.setThinkingLevelChoice(this.thinkingLevel)
  }
  get thinkingLevel(): ThinkingLevel {
    try {
      return this.defaults.thinkingLevelFor(this.resolveModel().info)
    } catch {
      return this.defaults.thinking
    }
  }
  availableThinkingLevels(): ThinkingLevel[] {
    try {
      return supportedThinkingLevels(this.resolveModel().info, THINKING_LEVELS)
    } catch {
      return [...THINKING_LEVELS]
    }
  }
  setThinkingLevel(level: ThinkingLevel): void {
    if (!THINKING_LEVELS.includes(level))
      throw new Error(
        `Thinking level must be one of ${THINKING_LEVELS.join(' / ')}`,
      )
    this.defaults.thinkingPinned = true
    const before = this.thinkingLevel
    this.defaults.thinking = level
    const after = this.thinkingLevel
    if (after !== before) this.store.setThinkingLevelChoice(after)
  }
  /** @internal */
  trackWork(work: Promise<unknown>): void {
    this.backgroundWork.track(work)
  }
  get hasWork(): boolean {
    return this.backgroundWork.active
  }
  getActiveTools(): string[] {
    return this.registry.getActiveTools().map((t) => t.name)
  }
  setActiveTools(names: string[] | undefined): void {
    this.registry.setSelection(names)
  }
  /** @internal Abort signal while running (agent loop or extension command) */
  get signal(): AbortSignal | undefined {
    return (
      this.busy.controller?.signal ?? this.commands.keys().next().value?.signal
    )
  }
  subscribe(listener: VelaEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  /** @internal Emits an event to this session's subscribers and Vela's subscribers. */
  readonly emit = (raw: VelaEvent): void => {
    dispatchSessionEvent({
      raw,
      id: this.id,
      messageQueue: this.messageQueue,
      toolDetails: this.toolDetails,
      listeners: this.listeners,
      deps: this.deps,
      messages: this.messages,
      append: (message) => this.append(message),
    })
  }
  /** @internal */
  promptContext(
    sections = this.turn.sections,
    override: string | null | undefined = this.turn.systemPrompt,
  ): PromptContext {
    return {
      extensionSections: sections,
      deferredToolSummary: this.registry.getDeferredToolSummary(),
      sessionId: this.id,
      activeTools: this.registry.getActiveTools(),
      systemPromptOverride: override,
    }
  }
  /** @internal Session-scoped resource inventory for Vela's own CLI. */
  resources(): Promise<SessionResources> {
    return this.prepare()
  }
  private async prepare(signal?: AbortSignal): Promise<SessionResources> {
    const resources = await this.deps.prepareWorkspace(this, signal)
    signal?.throwIfAborted()
    this.defaults.apply(
      resources.defaults,
      this.store,
      this.limits,
      this.contextManager,
    )
    return resources
  }
  /** @internal */
  buildSystem(sections?: Record<string, string>, override?: string | null) {
    return this.deps.builder.build(this.promptContext(sections, override))
  }
  /** @internal */
  async previewPrompt(): Promise<BeforeAgentStartResult> {
    await this.start()
    return this.deps.extensions.beforeAgentStart(this, '')
  }
  /** @internal */
  prepareContext(
    request: RequestSnapshot,
    options?: { maxOutputTokens?: number },
  ): Promise<void> {
    request.maxOutputTokens =
      options?.maxOutputTokens ?? this.modelInfo.maxTokens
    return this.contextManager.prepare(request)
  }
  async save(): Promise<void> {
    await this.contextManager.save()
  }
  getEntries(): SessionEntry[] {
    return this.store.getEntries()
  }
  getTree(): SessionTreeNode[] {
    return this.store.getTree()
  }
  getLeafId(): string | null {
    return this.store.getLeafId()
  }
  getBranch(fromId?: string): SessionEntry[] {
    return this.store.getBranch(fromId)
  }
  get parentSession(): string | undefined {
    return this.store.parentSession
  }
  get persistence(): SessionPersistence {
    return this.store.isMemory || this.store.persistencePath === ':memory:'
      ? { type: 'memory' }
      : { type: 'file', path: this.store.persistencePath }
  }
  setLabel(entryId: string, label: string | undefined): void {
    this.store.appendLabelChange(
      entryId,
      label?.replace(/[\r\n]+/g, ' ').trim() || undefined,
    )
  }
  get autoCompaction(): boolean {
    return this.contextManager.autoCompaction
  }
  set autoCompaction(enabled: boolean) {
    this.defaults.compactionPinned = true
    this.contextManager.autoCompaction = enabled
  }

  private exclusive<T>(
    what: string,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return runExclusiveSessionTask({
      id: this.id,
      what,
      isDraining: () => this.draining,
      drainError: () => this.drainError(),
      isClosed: () => this.closed,
      busy: this.busy,
      setRunning: (run, match) => {
        if (match === undefined || this.running === match) this.running = run
      },
      flushPendingCustom: () =>
        this.messageQueue.flushPendingCustom((message) => this.append(message)),
      flushBash: () => this.userBash.flush(),
      save: () => this.save(),
      task,
    })
  }

  navigateTree(
    targetId: string,
    options: NavigateTreeOptions = {},
  ): Promise<{ editorText?: string; cancelled: boolean }> {
    return navigateSessionTree(this.hosts.branch(), targetId, options)
  }

  private loadBranch(context: SessionContext): Promise<void> {
    return restoreBranchState({
      context,
      contextManager: this.contextManager,
      registry: this.registry,
      store: this.store,
      customMessages: this.messageQueue.customMessages,
      defaults: this.defaults,
      deps: this.deps,
      id: this.id,
      selectModel: (model) => this.selectModel(model, false),
      tracker: this.tracker,
      messages: this.messages,
    })
  }

  fork(entryId: string, options: ForkOptions = {}): Promise<ForkResult> {
    return forkSessionBranch(this.hosts.branch(), entryId, options)
  }

  async clone(
    options: Omit<ForkOptions, 'position'> = {},
  ): Promise<ForkResult> {
    return cloneSessionBranch(this.hosts.branch(), options)
  }

  /** @internal */
  seedFrom(parent: VelaSession, branch: SessionEntry[]): Promise<void> {
    return seedSessionFromBranch(this.hosts.branch(), parent, branch)
  }

  exportJsonl(path?: string): Promise<string> {
    return exportSessionBranch(this.hosts.branch(), 'jsonl', path)
  }

  exportHtml(path?: string): Promise<string> {
    return exportSessionBranch(this.hosts.branch(), 'html', path)
  }

  resume(): Promise<boolean> {
    return this.locationTask((signal) =>
      restoreSessionHistory(this.hosts.location(), signal),
    )
  }

  async continueInterrupted(): Promise<void> {
    if (this.draining) throw this.drainError()
    if (this.closed) throw new Error(`Session ${this.id} is closed`)
    if (this.busy.locked)
      throw new Error(`Session ${this.id} is already running`)
    assertInterruptedTurn(this.messages)
    return this.trackRun(runSessionQueue(this.hosts.runner(), undefined, {}))
  }

  pendingApprovals(): PendingApprovalInfo[] {
    if (this.closed) throw new Error(`Session ${this.id} is closed`)
    return listPendingApprovals(this.deps.db, this.id)
  }

  resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
  ): ResolvedApprovalInfo {
    if (this.closed) throw new Error(`Session ${this.id} is closed`)
    return resolveApprovalRecord(this.deps.db, this.id, approvalId, decision)
  }

  append(message: ModelMessage): void {
    recordSessionMessage({
      message,
      messageQueue: this.messageQueue,
      store: this.store,
      toolDetails: this.toolDetails,
      timestamps: this.timestamps,
    })
    this.messages.push(message)
    this.tracker.addMessage(message)
    this.emit({ type: 'message_start', message })
    this.emit({ type: 'message_end', message })
  }

  get isBashRunning(): boolean {
    return this.userBash.isRunning
  }

  async executeBash(
    command: string,
    options: {
      excludeFromContext?: boolean
      onUpdate?: (output: string) => void
      id?: string
    } = {},
  ): Promise<BashResult> {
    if (this.draining) throw this.drainError()
    if (this.closed) throw new Error(`Session ${this.id} is closed`)
    if (this.moving) throw new Error('Session is changing location')
    return this.userBash.execute(command, options)
  }

  abortBash(): void {
    this.userBash.abort()
  }

  backgroundTasks(toolCallId?: string): Promise<string[]> {
    return this.userBash.detach(toolCallId)
  }

  prompt(input: string, options: PromptOptions = {}): Promise<void> {
    return promptSessionInput(this.hosts.input(), input, options, 'command')
  }

  steer(
    input: string,
    options: { source?: InputSource; images?: ImageContent[] } = {},
  ): Promise<void> {
    return promptSessionInput(this.hosts.input(), input, {
      ...options,
      streamingBehavior: 'steer',
    })
  }

  sendMessage(
    message: CustomMessage,
    options: SendMessageOptions = {},
  ): Promise<void> {
    return sendSessionCustomMessage(this.hosts.input(), message, options)
  }

  sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options: { deliverAs?: 'steer' } = {},
  ): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error(`Session ${this.id} is closed`))
    const { text, images } = splitUserMessageContent(content)
    return promptSessionInput(
      this.hosts.input(),
      text,
      {
        source: 'extension',
        images,
        ...(options.deliverAs ? { streamingBehavior: options.deliverAs } : {}),
      },
      'literal',
    )
  }

  appendEntry(customType: string, data?: unknown): void {
    if (this.closed) throw new Error(`Session ${this.id} is closed`)
    assertCustomType(customType)
    this.store.appendCustom(customType, data)
  }

  customMessageOf(message: ModelMessage): CustomMessageInfo | undefined {
    return this.messageQueue.customMessages.get(message)
  }

  clearQueue(): { steering: string[] } {
    return this.messageQueue.clear()
  }

  get queue(): { steering: string[] } {
    return this.messageQueue.queue
  }

  get isRunning(): boolean {
    return this.busy.locked
  }

  async waitForIdle(): Promise<void> {
    while (this.running) await this.running
  }

  drain(): Promise<void> {
    this.draining = true
    this.drained ??= waitForDrain(this, this.userBash.running)
    return this.drained
  }

  private drainError(): Error {
    return new Error(`Session ${this.id} is draining; new work is not accepted`)
  }

  private dequeueSteering(): ModelMessage[] {
    if (this.draining) return []
    return this.messageQueue.dequeue(this.steeringMode)
  }

  private trackRun(run: Promise<void>): Promise<void> {
    const clear = () => {
      if (this.running === running) this.running = undefined
    }
    const running = run.then(clear, clear)
    this.running = running
    return run
  }

  private async start(signal?: AbortSignal): Promise<void> {
    await this.prepare(signal)
    await this.startExtensions()
  }

  private startExtensions(): Promise<void> {
    this.started ??= this.deps.extensions.ready.then(() =>
      this.deps.extensions.sessionStart(this),
    )
    return this.started
  }

  async compact(focus?: string): Promise<void> {
    await this.exclusive('compact', async (signal) => {
      await this.start(signal)
      await runSessionCompaction(this.hosts.runner(), 'manual', focus, signal)
      await this.save()
    })
  }

  async abort(reason: unknown = defaultAbortError()): Promise<void> {
    for (const controller of [this.busy.controller, ...this.commands.keys()])
      if (controller && !controller.signal.aborted) controller.abort(reason)
    await this.waitForIdle()
  }

  get usage(): SessionUsage {
    return this.tracker.snapshot()
  }

  close(): Promise<void> {
    this.closed = true
    this.closing ??= shutdownSession({
      abortBash: () => this.abortBash(),
      abort: (reason) => this.abort(reason),
      commands: this.commands.values(),
      running: this.running,
      bashRunning: this.userBash.running,
      waitForRegistry: () => this.registry.waitForIdle(),
      started: this.started,
      onShutdown: () => this.deps.extensions.sessionShutdown(this),
      save: () => this.save(),
      release: () => {
        this.store.releaseTransient()
        this.listeners.clear()
      },
      onClose: () => this.deps.onClose(this),
    })
    return this.closing
  }
}
