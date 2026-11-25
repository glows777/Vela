import { withProviderHooks } from '../providers/index.ts'
import { supportedThinkingLevels } from '../providers/models/catalog.ts'
import {
  limitsForModel,
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
import { ContextManager } from './context/manager.ts'
import {
  type RequestSnapshot,
  resolveRequestSnapshot,
} from './context/request.ts'
import { abortable, resolveLocation } from './execution/location.ts'
import type { ExecutionLocation } from './execution/types.ts'
import type {
  BeforeAgentStartResult,
  InputSource,
} from './extensions/events.ts'
import type { ImageContent, ModelMessage, TextContent } from './messages.ts'
import type { PromptContext, SystemPromptBuilder } from './prompt/index.ts'
import {
  cloneLeaf,
  copyFork,
  executeTreeNavigation,
  forkPoint,
} from './session/branch-selection.ts'
import { extractToolMessageDetails } from './session/db-store.ts'
import {
  buildForkSessionOptions,
  defaultAbortError,
  prepareAgentTurn,
  resolveRunProducer,
  restoreBranchState,
  runLoopCompaction,
  runPostTurnCompaction,
  SessionDefaultState,
  splitUserMessageContent,
  summarizeEntriesForTree,
  userPromptMessage,
} from './session/defaults.ts'
import type {
  SessionDeps as SessionDependencies,
  ForkResult as SessionForkResult,
} from './session/deps.ts'
import { shutdownSession, waitForDrain } from './session/drain.ts'
import {
  assertCustomType,
  entriesToMessages,
  type SessionContext,
  type SessionEntry,
  type SessionTreeNode,
} from './session/entries.ts'
import { exportBranch } from './session/export.ts'
import { SessionStore } from './session/index.ts'
import { MessageQueue } from './session/message-queue.ts'
import {
  assertSessionId,
  type ForkOptions,
  type InternalSessionOptions,
  type NavigateTreeOptions,
  type PromptOptions,
  type QueueMode,
  type SendMessageOptions,
  type SessionHost,
  type SessionPersistence,
  type SessionUsage,
} from './session/options.ts'
import { assertInterruptedTurn, pendingToolCalls } from './session/recovery.ts'
import {
  busyLocationError,
  needsRestoredWorkspace,
  restoredLocation,
  switchWorkspace,
} from './session/relocation.ts'
import type { SessionResources } from './session/resources.ts'
import * as routing from './session/routing.ts'
import type { SessionScope } from './session/scope.ts'
import { UserBash } from './session/user-bash.ts'
import { SessionWork } from './session/work.ts'
import {
  type ApprovalDecision,
  listPendingApprovals,
  type PendingApprovalInfo,
  type ResolvedApprovalInfo,
  resolveApproval as resolveApprovalRecord,
} from './step-recovery.ts'
import type { ToolRegistry } from './tools/registry.ts'
import type { BashResult } from './tools/shell.ts'
import { getToolListError, isToolModifier } from './tools/tool-selection.ts'
import { CONTEXT_WINDOW, TokenTracker } from './usage/tracker.ts'
import { VelaDriver } from './vela-driver.ts'

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

  /** Current trusted execution target, restored from the session transcript. */
  get location(): Readonly<ExecutionLocation> {
    return this.position
  }

  /** Prepare and persist an idle session's target before switching its prompt and tools. */
  async setLocation(location: ExecutionLocation): Promise<void> {
    if (!location) throw new Error('Invalid execution location')
    const target = resolveLocation(location, this.deps.cwd)
    return this.locationTask((signal) => this.switchLocation(target, signal))
  }

  private locationTask<T>(
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (
      this.busy.locked ||
      this.isBashRunning ||
      this.hasWork ||
      this.commands.size ||
      this.registry.hasActiveCalls
    )
      return Promise.reject(busyLocationError())
    return this.exclusive('change or restore location', async (signal) => {
      this.moving = true
      try {
        return await task(signal)
      } finally {
        this.moving = false
      }
    })
  }

  private switchLocation(
    target: Readonly<ExecutionLocation>,
    moveSignal?: AbortSignal,
  ) {
    return switchWorkspace(
      this,
      this.deps,
      target,
      this.started,
      () => {
        this.position = target
        Object.assign(this, { cwd: target.cwd })
        this.started = undefined
        this.turn = { sections: {}, messages: [] }
      },
      moveSignal,
    )
  }

  /** Limits in effect (recomputed from the new model's context window on model switch) */
  readonly limits: VelaLimits
  /** Message history (in order). SDK users should treat it as read-only and use append() to add. */
  readonly messages: ModelMessage[] = []
  /** @internal */
  readonly timestamps: Map<ModelMessage, number>
  /** @internal */
  readonly store: SessionStore
  /** @internal */
  readonly tracker: TokenTracker
  /** @internal */ readonly contextManager: ContextManager
  /** @internal */ execEnv = (signal?: AbortSignal) =>
    abortable(this.deps.resolveExecution(this), signal)
  /** @internal This session's registry: shared tool definitions, separate tool results and discovered deferred tools */
  readonly registry: ToolRegistry
  /** @internal Run lock: held while any agent loop (prompt, skill, dream, defend, ingest) runs */
  readonly busy: { locked: boolean; controller?: AbortController } = {
    locked: false,
  }

  private readonly listeners = new Set<VelaEventListener>()
  /** Tools' display data from `tool_execution_end`, recorded on their tool message. */
  private readonly toolDetails = new Map<string, unknown>()
  private readonly userBash: UserBash
  private readonly builder: SystemPromptBuilder
  private readonly deps: SessionDeps
  /** Options the session was opened with (a fork opens with the same) */
  private readonly options: InternalSessionOptions
  private closed = false
  private draining = false
  private drained?: Promise<void>
  /** The close in progress: a second caller waits for the final save instead of returning early */
  private closing?: Promise<void>
  private started?: Promise<void>
  private running?: Promise<void>
  private turn: BeforeAgentStartResult = { sections: {}, messages: [] }
  /** @internal */
  readonly driver: VelaDriver
  private readonly messageQueue = new MessageQueue((event) => this.emit(event))
  /** How steer messages are taken (default one-at-a-time, like pi) */
  steeringMode: QueueMode = 'one-at-a-time'

  /** @internal Created by vela.session() */
  constructor(
    id: string,
    deps: SessionDeps,
    options: InternalSessionOptions = {},
  ) {
    assertSessionId(id)
    this.id = id
    this.position = resolveLocation(options.location, deps.cwd, options.cwd)
    this.cwd = this.position.cwd
    if (this.position.environment !== 'local' && !deps.hasResolver)
      throw new Error(
        `Execution environment unavailable for ${this.position.environment}:${this.cwd}`,
      )
    this.deps = deps
    this.options = options
    this.backgroundWork = new SessionWork(options.unattended === true)
    this.defaults = new SessionDefaultState(deps, options)
    this.limits = limitsForModel({}, deps.limitOverrides)
    this.builder = deps.builder
    this.store = new SessionStore(id, deps.db, {
      uploadsDir: deps.uploadsRoot(id),
      logger: deps.logger,
      ephemeral: deps.ephemeral,
      cwd: this.cwd,
      location: this.location,
      onSaved: () => deps.onSaved(id),
    })
    this.registry = deps.registry.fork(
      this.store.transientSpillDir ?? deps.spillRoot(id),
      {
        onEvent: this.emit,
        sessionId: id,
        scope: () => this.scope,
      },
    )
    this.registry.isDraining = () => this.draining || this.moving
    routing.applySessionRouting(this, options)
    const toolListError = options.tools
      ? getToolListError(options.tools)
      : undefined
    if (toolListError) throw new Error(`Invalid tools option: ${toolListError}`)
    if (options.tools?.some(isToolModifier))
      this.registry.setDefaultToolModifiers(options.tools)
    else this.registry.setSelection(options.tools)
    this.tracker = new TokenTracker((record) =>
      this.store.recordUsageRecord(record),
    )
    this.driver = new VelaDriver({
      sessionId: id,
      db: deps.db,
      store: this.store,
      registry: this.registry,
      tracker: this.tracker,
      onEvent: this.emit,
    })
    this.contextManager = new ContextManager(
      this.store,
      this.tracker,
      { messages: this.messages, timestamps: new Map(), summary: '' },
      this.emit,
      this.limits,
    )
    this.timestamps = this.contextManager.state.timestamps
    this.userBash = new UserBash({
      store: this.store,
      emit: this.emit,
      busy: this.busy,
      save: () => this.save(),
      messages: this.messages,
      tracker: this.tracker,
      timestamps: this.timestamps,
      prepare: this.execEnv,
      start: (signal?: AbortSignal) => this.start(signal),
      background: () => this.registry.background,
      isClosed: () => this.closed,
      isDraining: () => this.draining,
    })
    this.contextManager.autoCompaction =
      options.autoCompaction ?? deps.autoCompaction
    if (typeof this.defaults.modelChoice === 'string')
      this.store.setModelChoice(this.defaults.modelChoice)
    this.store.setThinkingLevelChoice(this.defaults.thinking)
  }

  private displayName?: string

  /** Session display name (like pi's session name); saved with the session and shown in the session list. */
  get name(): string | undefined {
    return this.displayName
  }

  /** Sets the display name (empty string clears it), saved directly on the session row. */
  setName(name: string | undefined): void {
    const next = name?.replace(/[\r\n]+/g, ' ').trim() || undefined
    if (next === this.displayName) return
    this.displayName = next
    this.store.setSessionName(next)
  }

  private readonly defaults: SessionDefaultState

  private resolveModel(): ResolvedModel {
    if (!this.defaults.resolved)
      this.applyModel(this.deps.resolveModel(this.defaults.modelChoice, this))
    return this.defaults.resolved as ResolvedModel
  }

  private applyModel(resolved: ResolvedModel): void {
    const previousRef = this.defaults.lastResolvedRef
    this.defaults.resolved = resolved
    this.defaults.lastResolvedRef = resolved.info.ref
    this.defaults.hooked = undefined
    const limits = limitsForModel(
      resolved.info,
      this.defaults.effectiveLimitOverrides,
    )
    Object.assign(this.limits, limits)
    Object.assign(this.contextManager.limits, limits)
    const window = resolved.info.contextWindow ?? CONTEXT_WINDOW
    this.tracker.setModel(window, resolved.info.cost, {
      keepCalibration:
        previousRef === undefined || previousRef === resolved.info.ref,
    })
  }

  /** Emit a notification event on this session's event stream. */
  notify(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    this.emit({ type: 'notify', message, level })
  }

  private requestModel(): ModelInput {
    this.defaults.hooked ??= withProviderHooks(this.model, {
      has: (event, toolName, opts) =>
        this.deps.extensions.hasHandlers(event, toolName, opts),
      beforeRequest: (params) =>
        this.deps.extensions.beforeProviderRequest(this, params),
      afterResponse: (headers) =>
        this.deps.extensions.afterProviderResponse(this, headers),
      streamEvent: (event) =>
        this.deps.extensions.providerStreamEvent(this, {
          type: 'provider_stream_event',
          ...event,
        }),
    })
    return this.defaults.hooked
  }

  /** @internal Hook-wrapped model and reasoning level as sent in requests. */
  inspectToolOptions(): { model: ModelInput; reasoning?: ReasoningOption } {
    const { info } = this.resolveModel()
    return {
      model: this.requestModel(),
      reasoning: reasoningOption(this.defaults.thinkingLevelFor(info), info),
    }
  }

  /** Current model handle. Throws if the name cannot be resolved. */
  get model(): ModelInput {
    return this.resolveModel().model
  }

  /** Current model metadata: provider, id, `provider/id`, context window, etc. */
  get modelInfo(): ModelInfo {
    return this.defaults.info(this.resolveModel(), this.deps, this.channel)
  }

  /**
   * Switches the model (like pi's setModel): `provider/id` or `ModelHandle`, effective from the next prompt().
   * Compaction thresholds are recomputed from the new model's context window. Throws and keeps the
   * current model if the name cannot be resolved. A model chosen by name is appended to the session (`model_change`).
   */
  setModel(model: ModelInput): void {
    this.selectModel(model, true)
    this.defaults.modelPinned = true
  }

  private selectModel(model: ModelInput, record: boolean): void {
    const resolved = this.deps.resolveModel(model, this)
    const thinking = this.thinkingLevel
    this.defaults.modelChoice = model
    this.applyModel(resolved)
    if (record && typeof model === 'string')
      this.store.setModelChoice(resolved.info.ref ?? model)
    // Like pi's setModel: the thinking level is clamped to the new model and saved when that changes it
    if (record && this.thinkingLevel !== thinking)
      this.store.setThinkingLevelChoice(this.thinkingLevel)
  }

  /**
   * Thinking level (off … max, default medium), clamped to what the current model supports like pi: a model
   * without thinking uses `off`, and a level the model lacks moves to the nearest one it has.
   */
  get thinkingLevel(): ThinkingLevel {
    let info: ModelInfo
    try {
      info = this.resolveModel().info
    } catch {
      return this.defaults.thinking
    }
    return this.defaults.thinkingLevelFor(info)
  }

  /** Thinking levels the current model supports (all of them when its metadata doesn't say). */
  availableThinkingLevels(): ThinkingLevel[] {
    try {
      return supportedThinkingLevels(this.resolveModel().info, THINKING_LEVELS)
    } catch {
      return [...THINKING_LEVELS]
    }
  }

  /**
   * Sets the thinking level (like pi's setThinkingLevel); effective from the next request. The level actually used
   * is clamped to the model (see `thinkingLevel`) and saved with the session when it changes. Switching to a model
   * that supports the requested level uses it again.
   */
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
  /** Channel this session answers on. Open supplies it, and `resume()` restores a saved one. */
  channel?: string

  /** Transient host-supplied sharing identity; it never enables tools. */
  get scope(): Readonly<SessionScope> | undefined {
    return routing.sessionScope(this)
  }

  /** @internal The host's queue for results produced outside a turn (channels bind it at open). */
  get host(): SessionHost | undefined {
    return routing.sessionHost(this)
  }
  /** @internal Work outside a turn; idle cleanup keeps the session open while it runs. */
  readonly backgroundWork: SessionWork
  /** @internal */
  trackWork(work: Promise<unknown>): void {
    this.backgroundWork.track(work)
  }
  /** Whether work outside a turn (a background command) is still running. */
  get hasWork(): boolean {
    return this.backgroundWork.active
  }
  /** Tool names the model can currently see (after tool selection and deferred loading). */
  getActiveTools(): string[] {
    return this.registry.getActiveTools().map((tool) => tool.name)
  }

  /** Enable only these tools; pass undefined to restore all. Like pi's setActiveTools. */
  setActiveTools(names: string[] | undefined): void {
    this.registry.setSelection(names)
  }

  /** Running extension commands (commands don't hold the run lock; several can run at once and may call prompt()) */
  private readonly commands = new Map<AbortController, Promise<void>>()

  /** @internal Abort signal while running (agent loop or extension command) */
  get signal(): AbortSignal | undefined {
    return (
      this.busy.controller?.signal ?? this.commands.keys().next().value?.signal
    )
  }

  /** Subscribes to this session's events; returns an unsubscribe function. */
  subscribe(listener: VelaEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** @internal Emits an event to this session's subscribers and Vela's subscribers. */
  readonly emit = (raw: VelaEvent): void => {
    let event = raw
    if (
      (event.type === 'message_start' || event.type === 'message_end') &&
      !event.custom
    ) {
      const custom = this.messageQueue.customMessages.get(event.message)
      if (custom) event = { ...event, custom }
    }
    if (event.type === 'tool_execution_end' && event.details !== undefined)
      this.toolDetails.set(event.toolCallId, event.details)
    for (const listener of this.listeners) listener(event)
    this.deps.forward(event, this.id)
    // Like pi: only flush queued custom messages once no assistant tool call is awaiting its tool result.
    if (event.type === 'turn_end' && !pendingToolCalls(this.messages).length)
      this.messageQueue.flushPendingCustom((message) => this.append(message))
  }

  /** @internal `override` (`null`: none) keeps a preview or a new turn from inheriting a replacement */
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

  /** @internal This session's system prompt (rebuilt before each turn's requests). */
  buildSystem(sections?: Record<string, string>, override?: string | null) {
    return this.builder.build(this.promptContext(sections, override))
  }

  /** @internal Runs this turn's handlers on a fresh prompt for /context, keeping nothing */
  async previewPrompt(): Promise<BeforeAgentStartResult> {
    await this.start()
    return this.deps.extensions.beforeAgentStart(this, '')
  }

  /** @internal Prepares the context before a request. */
  prepareContext(
    request: RequestSnapshot,
    options?: { maxOutputTokens?: number },
  ): Promise<void> {
    request.maxOutputTokens =
      options?.maxOutputTokens ?? this.modelInfo.maxTokens
    return this.contextManager.prepare(request)
  }

  /** Flushes pending storage operations. */
  async save(): Promise<void> {
    await this.contextManager.save()
  }

  /**
   * The session's entries in append order (a copy; like pi's `getEntries()`): messages, including summarized
   * ones and aborted messages that are no longer sent to the model, compactions, context edits and setting changes.
   */
  getEntries(): SessionEntry[] {
    return this.store.getEntries()
  }

  /** The session as a tree (copies; like pi's getTree): every branch, with labels. */
  getTree(): SessionTreeNode[] {
    return this.store.getTree()
  }

  /** The current leaf: new messages are appended under it. Null before the first entry. */
  getLeafId(): string | null {
    return this.store.getLeafId()
  }

  /** The entries from the root to `fromId` (default: the current leaf), like pi's getBranch. */
  getBranch(fromId?: string): SessionEntry[] {
    return this.store.getBranch(fromId)
  }

  /** Id of the session this one was forked or cloned from. */
  get parentSession(): string | undefined {
    return this.store.parentSession
  }

  /** Where this session's history is kept (`file` is the SQLite database path, `memory` is in-memory). */
  get persistence(): SessionPersistence {
    if (this.store.isMemory || this.store.persistencePath === ':memory:') {
      return { type: 'memory' }
    }
    return { type: 'file', path: this.store.persistencePath }
  }

  /** Sets (or clears, with undefined / empty) a label on an entry, like pi's `/tree` labels. */
  setLabel(entryId: string, label: string | undefined): void {
    this.store.appendLabelChange(
      entryId,
      label?.replace(/[\r\n]+/g, ' ').trim() || undefined,
    )
  }

  /**
   * Whether the context is compacted automatically (like pi's autoCompactionEnabled). Off:
   * no threshold summary, no compact-and-retry on overflow; compact() still works.
   */
  get autoCompaction(): boolean {
    return this.contextManager.autoCompaction
  }

  set autoCompaction(enabled: boolean) {
    this.defaults.compactionPinned = true
    this.contextManager.autoCompaction = enabled
  }

  /** Takes the run lock for a session-level task (compact, tree navigation); throws if something runs. */
  private async exclusive<T>(
    what: string,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.draining) throw this.drainError()
    if (this.closed) throw new Error(`Session ${this.id} is closed`)
    if (this.busy.locked)
      throw new Error(`A task is already running; ${what} after it finishes`)
    const busy = this.busy
    busy.locked = true
    const controller = new AbortController()
    busy.controller = controller
    const run = task(controller.signal)
    const running = run.then(
      () => {},
      () => {},
    )
    this.running = running
    try {
      return await run
    } finally {
      if (this.running === running) this.running = undefined
      this.messageQueue.flushPendingCustom((message) => this.append(message))
      while (this.userBash.flush()) await this.save()
      busy.locked = false
      busy.controller = undefined
    }
  }

  /**
   * Moves to another entry of the session tree (like pi's navigateTree); the session file keeps every branch.
   * Selecting a user message moves to just before it and returns its text (edit and send it to start a new
   * branch); selecting any other entry continues after it. With `summarize`, the branch being left is
   * summarized and the summary is attached where the session goes. Throws while running; abort() stops a
   * summary in progress. `cancelled` is true when an extension (session_before_tree) or abort() stopped it.
   */
  async navigateTree(
    targetId: string,
    options: NavigateTreeOptions = {},
  ): Promise<{ editorText?: string; cancelled: boolean }> {
    const target = this.store.getEntry(targetId)
    if (!target) throw new Error(`Entry ${targetId} is not in the session`)
    const oldLeafId = this.store.getLeafId()
    const isUser = target.type === 'message' && target.message.role === 'user'
    // Selecting a user message moves to its parent, so only another entry at the leaf is a no-op
    if (targetId === oldLeafId && !isUser) return { cancelled: false }
    return this.exclusive('navigate the session tree', async (signal) => {
      await this.start(signal)
      return executeTreeNavigation({
        session: this,
        store: this.store,
        target,
        oldLeafId,
        options,
        signal,
        beforeTree: (s, prep, sig) =>
          this.deps.extensions.beforeTree(s, prep, sig),
        afterTree: (s, event) => this.deps.extensions.tree(s, event),
        summarizeBranch: async (entries, focus, sig) => {
          const branchMessages = entriesToMessages(entries)
          if (!branchMessages.length) return undefined
          return summarizeEntriesForTree(
            this.contextManager,
            this.model,
            this.buildSystem(),
            this.registry.toProviderTools(),
            branchMessages,
            this.modelInfo.maxTokens,
            focus,
            sig,
          )
        },
        loadBranch: (ctx) => this.loadBranch(ctx),
        save: () => this.save(),
      })
    })
  }

  /** Makes the store's current branch the session's context, model and thinking level. */
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

  /**
   * Copies the branch up to an entry into a new session (like pi's fork). `before` (default) needs a user
   * message and ends just before it, returning its text; `at` includes the entry. Unlike pi, which replaces
   * its one session, Vela opens the copy as another session in the same Vela and leaves this one open.
   * The new session records this one as `parentSession`. Throws while running.
   */
  async fork(entryId: string, options: ForkOptions = {}): Promise<ForkResult> {
    const position = options.position ?? 'before'
    const point = forkPoint(this.store, entryId, position)
    return this.exclusive('fork', async (signal) => {
      await this.start(signal)
      if (await this.deps.extensions.beforeFork(this, entryId, position))
        return { cancelled: true }
      return copyFork(
        this,
        point,
        options.sessionId,
        this.deps.openSession,
        buildForkSessionOptions(
          this.defaults,
          this.store,
          this.options,
          this.location,
          this.autoCompaction,
          point.leafId,
          (opts) => routing.unroutedOptions(opts),
        ),
      )
    })
  }

  /** Copies the current branch into a new session (like pi's /clone, a fork at the leaf). */
  async clone(
    options: Omit<ForkOptions, 'position'> = {},
  ): Promise<ForkResult> {
    return this.fork(cloneLeaf(this.store), { ...options, position: 'at' })
  }

  /** @internal Starts this new session as a copy of `parent`'s branch (fork / clone). */
  async seedFrom(parent: VelaSession, branch: SessionEntry[]): Promise<void> {
    await this.store.seedFrom(branch, parent, this.execEnv, {
      parentSpillDir: parent.registry.spillDir,
      spillDir: this.registry.spillDir,
      resolveSourceEnv: (loc) => this.deps.resolveExecution(parent, loc),
    })
    if (branch.length) await this.loadBranch(this.store.buildContext())
    await this.store.flush()
  }

  /**
   * Writes the current branch as JSONL (like pi's exportToJsonl; the session file format, one branch).
   * Relative paths resolve against Vela's cwd; returns the path written.
   */
  exportJsonl(path?: string): Promise<string> {
    return this.exportBranch('jsonl', path)
  }

  /** Exports the current branch as a self-contained HTML page; review it before sharing. */
  exportHtml(path?: string): Promise<string> {
    return this.exportBranch('html', path)
  }

  private exportBranch(
    format: 'jsonl' | 'html',
    path?: string,
  ): Promise<string> {
    return exportBranch({
      id: this.id,
      baseCwd: this.deps.cwd,
      location: this.location,
      path,
      entries: this.store.getBranch(),
      name: this.name,
      model: this.defaults.modelChoice,
      channel: this.channel,
      parentSession: this.parentSession,
      format,
    })
  }

  /** Restores saved history and a saved channel. Returns false when nothing was saved.
   * Throws while running, or `SessionRoutingConflictError` when the opened channel differs. */
  async resume(): Promise<boolean> {
    return this.locationTask((signal) => this.restoreHistory(signal))
  }
  private async restoreHistory(signal: AbortSignal): Promise<boolean> {
    await this.store.flush()
    const saved = await this.store.loadSaved()
    if (!saved) return false
    const target = restoredLocation(saved.location, this.options, this.deps.cwd)
    await this.switchLocation(target)
    this.displayName = saved.name
    await this.loadBranch(saved)
    if (saved.channel !== undefined)
      routing.bindSavedChannel(this, saved.channel)
    this.defaults.applyOpenChoices(
      this.options,
      (m) => this.selectModel(m, false),
      {
        store: this.store,
        modelRef: () => this.resolveModel().info.ref,
        thinkingLevel: () => this.thinkingLevel,
      },
    )
    if (needsRestoredWorkspace(this.options, target)) await this.prepare(signal)
    return true
  }

  /**
   * Continues a restored interrupted turn on its current branch, without adding user input.
   * Repairs missing tool results before asking the model; unsafe interrupted tools are not replayed.
   * Rejects while another operation holds the session's run lock.
   */
  async continueInterrupted(): Promise<void> {
    if (this.draining) return Promise.reject(this.drainError())
    if (this.closed)
      return Promise.reject(new Error(`Session ${this.id} is closed`))
    if (this.busy.locked)
      return Promise.reject(new Error(`Session ${this.id} is already running`))
    assertInterruptedTurn(this.messages)
    return this.trackRun(this.run(undefined, {}))
  }

  /** Lists pending human approval requests (`waiting_human`) for this session. */
  pendingApprovals(): PendingApprovalInfo[] {
    if (this.closed) throw new Error(`Session ${this.id} is closed`)
    return listPendingApprovals(this.deps.db, this.id)
  }

  /** Records a human decision for a suspended tool approval (`waiting_human`). Call `continueInterrupted()` next to resume. */
  resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
  ): ResolvedApprovalInfo {
    if (this.closed) throw new Error(`Session ${this.id} is closed`)
    return resolveApprovalRecord(this.deps.db, this.id, approvalId, decision)
  }

  /** Appends a message to history and the session (without calling the model). */
  append(message: ModelMessage): void {
    this.record(message)
    this.messages.push(message)
    this.tracker.addMessage(message)
    this.emit({ type: 'message_start', message })
    this.emit({ type: 'message_end', message })
  }

  /** Appends a message that entered the history to the session; a tool message carries its tools' details. */
  private record(message: ModelMessage, producedBy?: string): void {
    const custom = this.messageQueue.customMessages.get(message)
    if (custom && message.role === 'user') {
      this.store.appendCustomMessage(message, custom)
      this.timestamps.set(message, Date.now())
      return
    }
    const details = extractToolMessageDetails(message, this.toolDetails)
    this.store.appendMessage(message, { details, producedBy })
    for (const key of Object.keys(details)) this.toolDetails.delete(key)
    this.timestamps.set(message, Date.now())
  }

  /** Whether an `executeBash()` command is running */
  get isBashRunning(): boolean {
    return this.userBash.isRunning
  }

  /** Runs a shell command for the user (pi's `executeBash`, the TUI's `!cmd`); see `docs/sdk.md`. */
  async executeBash(
    command: string,
    options: {
      excludeFromContext?: boolean
      onUpdate?: (output: string) => void
      /** Set on this command's `bash_execution_update` events */
      id?: string
    } = {},
  ): Promise<BashResult> {
    if (this.draining) throw this.drainError()
    if (this.closed) throw new Error(`Session ${this.id} is closed`)
    if (this.moving) throw new Error('Session is changing location')
    return this.userBash.execute(command, options)
  }

  /** Cancels the running `executeBash()` command (pi's abortBash); it is still recorded, as cancelled. */
  abortBash(): void {
    this.userBash.abort()
  }

  /** Moves running shell commands to the background; see `docs/sdk.md`. */
  backgroundTasks(toolCallId?: string): Promise<string[]> {
    return this.userBash.detach(toolCallId)
  }

  /**
   * Appends a user message and runs the agent loop to completion (no turn limit, like pi), then saves the session.
   * Steer messages queued during the run also finish before it resolves (`agent_settled` is emitted last).
   * If the loop fails, queued messages still run, then it rejects.
   * While running, pass `streamingBehavior: 'steer'` (or use `steer()`); it resolves right after enqueueing.
   */
  prompt(input: string, options: PromptOptions = {}): Promise<void> {
    return this.promptInput(input, options, 'command')
  }

  /** Plain input queues synchronously. Slash commands and hooks can await cancellable work. */
  private promptInput(
    input: string,
    options: PromptOptions,
    mode: 'command' | 'expand' | 'literal' = 'expand',
  ): Promise<void> {
    if (this.draining) return Promise.reject(this.drainError())
    if (this.closed)
      return Promise.reject(new Error(`Session ${this.id} is closed`))
    if (this.moving)
      return Promise.reject(new Error('Session is changing location'))
    const { expandInput, prepareCommands } = this.deps
    const slash = mode !== 'literal' && input.startsWith('/')
    const hooks = prepareCommands || this.deps.extensions.hasHandlers('input')
    if (!slash && !hooks) return this.promptModel(input, options)
    return this.trackInput(options.signal, async (signal) => {
      await abortable(
        prepareCommands ? this.start(signal) : this.startExtensions(),
        signal,
      )
      if (this.draining) throw this.drainError()
      if (this.closed) throw new Error(`Session ${this.id} is closed`)
      signal.throwIfAborted()
      const extensions = this.deps.extensions
      const command = mode === 'command' && slash
      if (command && (await extensions.runCommand(this, input, signal))) return
      signal.throwIfAborted()
      let text = input,
        images = options.images
      if (extensions.hasHandlers('input')) {
        const event = await abortable(
          extensions.input(
            this,
            text,
            options.source ?? 'sdk',
            this.prompting ? options.streamingBehavior : undefined,
            images,
          ),
          signal,
        )
        if (!event) return
        text = event.text
        images = event.images
      }
      if (this.draining) throw this.drainError()
      if (mode !== 'literal' && text.startsWith('/')) {
        signal.throwIfAborted()
        text = await abortable(expandInput(text, this, signal), signal)
      }
      return this.promptModel(text, { ...options, images, signal })
    })
  }

  /** Register async input before dispatch so abort also covers resource expansion. */
  private async trackInput(
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<void>,
  ) {
    const controller = new AbortController()
    const forward = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', forward, { once: true })
    if (signal?.aborted) forward()
    const task = run(controller.signal)
    this.commands.set(controller, task)
    try {
      return await task
    } finally {
      this.commands.delete(controller)
      signal?.removeEventListener('abort', forward)
    }
  }

  /** While running: joins the current task, sent as a user message after this step's tools finish and before the next model request. Same as prompt() when idle. */
  steer(
    input: string,
    options: { source?: InputSource; images?: ImageContent[] } = {},
  ): Promise<void> {
    return this.promptInput(input, { ...options, streamingBehavior: 'steer' })
  }

  /**
   * Adds an extension's custom message to the conversation (like pi's `sendMessage`). The model sees it as a
   * user message; it is saved as a `custom_message` entry and its events carry `custom`.
   * - `deliverAs: 'nextTurn'`: added after the user message of the next prompt.
   * - Running (and `triggerTurn` not false): queued like steer().
   * - Idle with `triggerTurn`: runs the agent loop with the message as its input; resolves when the run ends.
   * - Running with `triggerTurn: false`: appended once the current step's tool results are in.
   * - Otherwise appended right away.
   */
  async sendMessage(
    message: CustomMessage,
    options: SendMessageOptions = {},
  ): Promise<void> {
    if (this.closed) throw new Error(`Session ${this.id} is closed`)
    const entry = this.messageQueue.customMessage(message)
    if (options.deliverAs === 'nextTurn') {
      this.messageQueue.nextTurnMessages.push(entry)
      return
    }
    if (this.prompting && options.triggerTurn !== false) {
      this.messageQueue.enqueue(entry)
      return
    }
    if (options.triggerTurn) return this.promptMessage(entry, {})
    if (this.busy.locked) {
      this.messageQueue.pendingCustom.push(entry)
      return
    }
    this.append(entry)
  }

  /**
   * Sends a user message as if typed (like pi's `sendUserMessage`): goes through the `input` handlers with
   * source `extension` but is not expanded as a command, skill or prompt template. While running, pass
   * `deliverAs: 'steer'` to queue it.
   */
  sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options: { deliverAs?: 'steer' } = {},
  ): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error(`Session ${this.id} is closed`))
    const { text, images } = splitUserMessageContent(content)
    return this.promptInput(
      text,
      {
        source: 'extension',
        images,
        ...(options.deliverAs ? { streamingBehavior: options.deliverAs } : {}),
      },
      'literal',
    )
  }

  /**
   * Saves extension state in the session (like pi's `appendEntry`): a `custom` entry that is never sent to the
   * model. Read it back with `getEntries()` (for example in `session_start` after a resume).
   */
  appendEntry(customType: string, data?: unknown): void {
    if (this.closed) throw new Error(`Session ${this.id} is closed`)
    assertCustomType(customType)
    this.store.appendCustom(customType, data)
  }

  /** The custom message fields of a history message an extension sent with sendMessage(); undefined for other messages. */
  customMessageOf(message: ModelMessage): CustomMessageInfo | undefined {
    return this.messageQueue.customMessages.get(message)
  }

  /** Clears queued steering messages and returns the user inputs among them. */
  clearQueue(): { steering: string[] } {
    return this.messageQueue.clear()
  }

  /** Currently queued steering user inputs. */
  get queue(): { steering: string[] } {
    return this.messageQueue.queue
  }

  /** Whether an agent loop is running (including loops for queued messages and manual compaction) */
  get isRunning(): boolean {
    return this.busy.locked
  }

  /** Waits for agent loops, queued messages and compaction (like pi's waitForIdle), never for a command. */
  async waitForIdle(): Promise<void> {
    while (this.running) await this.running
  }

  /** Stop admission and wait for active tools without cancelling them; the host owns the deadline. */
  drain(): Promise<void> {
    this.draining = true
    this.drained ??= waitForDrain(this, this.userBash.running)
    return this.drained
  }

  private drainError(): Error {
    return new Error(`Session ${this.id} is draining; new work is not accepted`)
  }

  /** Takes queued steering messages by steeringMode. */
  private dequeueSteering(): ModelMessage[] {
    if (this.draining) return []
    return this.messageQueue.dequeue(this.steeringMode)
  }

  /** `/xxx` that is not an extension command, or plain input: runs when idle, queued by streamingBehavior while running. */
  private promptModel(input: string, options: PromptOptions): Promise<void> {
    return this.promptMessage(userPromptMessage(input, options.images), options)
  }

  private promptMessage(
    message: ModelMessage,
    options: PromptOptions,
  ): Promise<void> {
    if (this.draining) return Promise.reject(this.drainError())
    if (this.closed)
      return Promise.reject(new Error(`Session ${this.id} is closed`))
    // Input hooks can finish after cancellation, while the aborted loop is still cleaning up.
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)
    if (this.busy.locked) {
      // Only the prompt loop drains the queue; nothing can be queued while /defend, a skill or compact holds the lock
      if (!this.prompting || !options.streamingBehavior)
        return Promise.reject(
          new Error(
            'A task is already running: queue with steer() (or streamingBehavior), or wait for it to finish',
          ),
        )
      this.messageQueue.enqueue(message)
      return Promise.resolve()
    }
    return this.trackRun(this.run(message, options))
  }

  private trackRun(run: Promise<void>): Promise<void> {
    const clear = () => {
      if (this.running === running) this.running = undefined
    }
    const running = run.then(clear, clear)
    this.running = running
    return run
  }

  /** Before first use: waits for extensions to load and fires session_start (once). */
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

  private prompting = false

  private async run(
    input: ModelMessage | undefined,
    options: PromptOptions,
  ): Promise<void> {
    const busy = this.busy
    busy.locked = true
    this.prompting = true
    const controller = new AbortController()
    busy.controller = controller
    const forward = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', forward, { once: true })
    if (options.signal?.aborted) forward()
    let failure: { error: unknown } | undefined
    const next = () => this.dequeueSteering()
    try {
      await this.start(controller.signal)
      await this.store.assertNew()
      const hasPending = pendingToolCalls(this.messages).length > 0
      const recoverPending = input === undefined || hasPending
      if (recoverPending) {
        this.registry.discoveredTools = new Set(await this.store.loadedTools())
      }
      let inputs = input === undefined ? [] : [input]
      let firstRun = true
      do {
        let stopForHuman = false
        try {
          const outcome = await this.runLoop(
            inputs,
            controller.signal,
            firstRun && recoverPending,
            input === undefined,
          )
          stopForHuman = outcome.reason === 'waiting_human'
          await runPostTurnCompaction({
            enabled: !stopForHuman && this.autoCompaction,
            signal: controller.signal,
            isDraining: () => this.draining,
            buildSnapshot: () =>
              this.buildSnapshot(controller.signal, {
                model: this.requestModel(),
                maxOutputTokens: this.resolveModel().info.maxTokens,
              }),
            compactIfNeeded: (req) => this.contextManager.compactIfNeeded(req),
            warn: (msg) =>
              this.deps.logger.warn(
                `[session:${this.id}] Post-turn compaction failed: ${msg}`,
              ),
          })
        } catch (error) {
          failure ??= { error }
        }
        firstRun = false
        if (stopForHuman || controller.signal.aborted) break
        inputs = next()
        if (!inputs.length && !pendingToolCalls(this.messages).length) {
          this.messageQueue.flushPendingCustom((message) =>
            this.append(message),
          )
          inputs = next()
        }
      } while (inputs.length)
    } finally {
      options.signal?.removeEventListener('abort', forward)
      const hasPendingCalls = pendingToolCalls(this.messages).length > 0
      if (!hasPendingCalls)
        this.messageQueue.flushPendingCustom((message) => this.append(message))
      this.toolDetails.clear()
      if (!hasPendingCalls) while (this.userBash.flush()) await this.save()
      busy.locked = false
      busy.controller = undefined
      this.prompting = false
      if (!hasPendingCalls)
        this.messageQueue.flushPendingCustom((message) => this.append(message))
      this.emit({ type: 'agent_settled' })
    }
    if (failure) throw failure.error
  }

  /** One agent loop via VelaDriver. */
  private async runLoop(
    inputs: ModelMessage[],
    signal: AbortSignal,
    recoverPending = false,
    allowWaitingHuman = false,
  ): Promise<{ reason: 'done' | 'waiting_human' }> {
    await this.start(signal)
    signal.throwIfAborted()
    await this.store.assertNew()
    const { info } = this.resolveModel()
    const serving = {
      model: this.requestModel(),
      maxOutputTokens: info.maxTokens,
    }
    const trigger = this.channel ? 'channel' : 'user'
    const claim = this.driver.claim({
      recoverPending,
      allowWaitingHuman,
      trigger,
      model: serving.model,
    })
    let handedOff = false
    try {
      if (this.defaults.modelChoice === undefined) {
        this.defaults.modelChoice = info.ref
        this.store.setModelChoice(info.ref)
      }
      const { newMessages, flushAndAppend } = await prepareAgentTurn({
        inputs,
        signal,
        recoverPending,
        normalizeInput: (m) => this.messageQueue.normalizeInput(m),
        beforeAgentStart: (text) =>
          this.deps.extensions.beforeAgentStart(this, text),
        setTurn: (turn) => {
          this.turn = turn
        },
        toCustomMessage: (m) => this.messageQueue.customMessage(m),
        emitStart: (input) => this.emit({ type: 'agent_start', input }),
        flushBash: () => this.userBash.flush(),
        flushPendingCustom: (cb) => this.messageQueue.flushPendingCustom(cb),
        nextTurnMessages: this.messageQueue.nextTurnMessages,
        append: (m) => this.append(m),
      })
      const { info: servingInfo } = this.resolveModel()
      serving.model = this.requestModel()
      serving.maxOutputTokens = servingInfo.maxTokens
      handedOff = true
      return await this.driver.run({
        claim,
        model: serving.model,
        producer: () =>
          resolveRunProducer(
            serving.model,
            this.defaults.modelChoice,
            servingInfo.provider,
            this.channel,
            this.deps.authMode,
          ),
        trigger,
        maxOutputTokens: serving.maxOutputTokens,
        supportsImages: servingInfo.input?.includes('image') ?? true,
        reasoning: () =>
          reasoningOption(
            this.defaults.thinkingLevelFor(servingInfo),
            servingInfo,
          ),
        systemPrompt: () => this.buildSystem(),
        messages: this.messages,
        newMessages,
        prepareContext: (req) => this.prepareContext(req, serving),
        transformContext: (msgs, p) =>
          this.deps.extensions.transformContext(this, msgs, p),
        compactOnOverflow: this.autoCompaction
          ? (sig) => this.runCompaction('overflow', undefined, sig, serving)
          : undefined,
        abortSignal: signal,
        isDraining: () => this.draining,
        takeSteering: () =>
          Promise.all(
            this.dequeueSteering().map((m) =>
              this.messageQueue.normalizeInput(m),
            ),
          ),
        hasSteering: () => !this.draining && this.messageQueue.hasSteering,
        limits: this.limits,
        recoverPending,
        onRecoveryComplete: recoverPending ? flushAndAppend : undefined,
        appendInput: (msg) => this.append(msg),
      })
    } catch (error) {
      if (!handedOff)
        claim.release(
          claim.resumedFromWaitingHuman ? 'waiting_human' : 'stopped',
        )
      throw error
    }
  }

  private buildSnapshot(
    signal?: AbortSignal,
    opts?: { model?: ModelInput; maxOutputTokens?: number },
  ) {
    return resolveRequestSnapshot(
      opts?.model ?? this.requestModel(),
      this.buildSystem(),
      this.registry.toProviderTools(),
      this.messages,
      signal,
      opts?.maxOutputTokens ?? this.modelInfo.maxTokens,
    )
  }

  private async runCompaction(
    reason: 'manual' | 'overflow',
    focus?: string,
    signal?: AbortSignal,
    serving?: { model?: ModelInput; maxOutputTokens?: number },
  ): Promise<void> {
    const request = await this.buildSnapshot(signal, serving)
    await runLoopCompaction(
      this.contextManager,
      request,
      this.limits.maxInputTokens,
      reason,
      focus,
    )
  }

  /**
   * Compacts the context manually (like pi's compact): replaces earlier history with a summary, keeps recent
   * messages, then saves. `focus` is what the summary should prefer to keep (pi's customInstructions).
   * Throws while the session is running; can be interrupted by abort().
   */
  async compact(focus?: string): Promise<void> {
    await this.exclusive('compact', async (signal) => {
      await this.start(signal)
      await this.runCompaction('manual', focus, signal)
      await this.save()
    })
  }

  /**
   * Aborts the current agent loop and extension commands (if any) and waits until the agent loop actually stops
   * (like pi's `await abort()`). Queued messages stay in the queue; call clearQueue() first if needed.
   */
  async abort(reason: unknown = defaultAbortError()): Promise<void> {
    for (const controller of [this.busy.controller, ...this.commands.keys()])
      if (controller && !controller.signal.aborted) controller.abort(reason)
    await this.waitForIdle()
  }

  /** Token estimate, context usage and this session's total usage. */
  get usage(): SessionUsage {
    return this.tracker.snapshot()
  }

  /** Aborts the running task, waits for it to finish and save, then removes the session from Vela. */
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
