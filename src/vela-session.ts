import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { LanguageModel, ModelMessage } from 'ai'
import type { VelaEvent, VelaEventListener } from './agent/events.ts'
import { agentLoop } from './agent/index.ts'
import { canSummarize } from './context/compressor.ts'
import { estimateMessageTokens } from './context/defense.ts'
import { ContextManager } from './context/manager.ts'
import {
  createRequestSnapshot,
  type RequestSnapshot,
} from './context/request.ts'
import type {
  ExtensionUI,
  SessionBeforeTreeEventResult,
  SessionTreeEvent,
  SessionUI,
  TreePreparation,
} from './extensions/types.ts'
import type { VelaLimits } from './limits.ts'
import type { VelaLogger } from './logger.ts'
import {
  limitsForModel,
  type ModelInfo,
  type ResolvedModel,
  reasoningOption,
  THINKING_LEVELS,
  type ThinkingLevel,
} from './models/index.ts'
import type { PromptContext, PromptPipeline } from './prompt/pipeline.ts'
import type { PermissionRules, Role } from './security/roles.ts'
import {
  type BranchSummaryEntry,
  messageText,
  type NestedToolCalls,
  SESSION_FORMAT_VERSION,
  type SessionContext,
  type SessionEntry,
  type SessionHeader,
  type SessionTreeNode,
} from './session/entries.ts'
import { renderSessionHtml } from './session/export-html.ts'
import { SessionStore } from './session/index.ts'
import { NestedCallLog } from './session/nested-calls.ts'
import { newSessionId } from './session/session-id.ts'
import type { SessionStorage } from './session/storage.ts'
import type { ToolRegistry } from './tools/registry.ts'
import {
  CONTEXT_WINDOW,
  type TokenStatus,
  TokenTracker,
  type UsageTotals,
} from './usage/tracker.ts'

export interface PromptOptions {
  signal?: AbortSignal
  /**
   * How to handle this input while the session is running (like pi): `steer` joins the current task
   * (after this step's tools finish, before the next model request); `followUp` runs after the current
   * task ends. Required while running (throws otherwise); ignored when idle.
   */
  streamingBehavior?: 'steer' | 'followUp'
}

/** How queued messages are taken: one at a time (default, like pi) or all at once. */
export type QueueMode = 'one-at-a-time' | 'all'

/** Options for `vela.session(id, options)`; only apply when the session is first opened. */
export interface SessionOptions {
  /** Session role, default owner (for channel senders the channel decides, default guest) */
  role?: Role
  /** Tool permissions layered on top of the role, e.g. `{ bash: 'ask' }` */
  permissions?: PermissionRules
  /** Enable only these tools (still limited by the role); default all */
  tools?: string[]
  /** UI extensions use to interact with the user; without it there is no UI (confirm always returns false) */
  ui?: SessionUI
  /** Model for this session (`provider/id` or LanguageModel), default Vela's model */
  model?: string | LanguageModel
  /** Thinking level, default Vela's (Vela defaults to medium, like pi) */
  thinkingLevel?: ThinkingLevel
  /** Automatic compaction, default Vela's (on unless createVela({ autoCompaction: false })) */
  autoCompaction?: boolean
}

/** Options for `session.navigateTree()` (like pi's). */
export interface NavigateTreeOptions {
  /** Summarize the branch being left; the summary is attached where the session goes */
  summarize?: boolean
  /** What the summary should prefer to keep (pi's customInstructions) */
  focus?: string
  /** Label for the target entry (or for the summary entry when summarizing) */
  label?: string
}

/** Options for `session.fork()` / `clone()`. */
export interface ForkOptions {
  /** `before` (default): the new session ends before this user message; `at`: it includes the entry */
  position?: 'before' | 'at'
  /** Id of the new session; default a new time-based id like the CLI's */
  sessionId?: string
}

/** What `fork()` / `clone()` returns. */
export interface ForkResult {
  /** True when an extension cancelled it (no session was created) */
  cancelled: boolean
  /** The new session, open in the same Vela (the original stays open) */
  session?: VelaSession
  /** Text of the user message forked from (`before`), for the input box */
  selectedText?: string
}

/** What the extension runtime does during the session lifecycle (provided by createVela). */
export interface SessionExtensionHooks {
  /** All extensions have loaded */
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
  beforeTree(
    session: VelaSession,
    preparation: TreePreparation,
    signal: AbortSignal,
  ): Promise<SessionBeforeTreeEventResult>
  tree(session: VelaSession, event: SessionTreeEvent): Promise<void>
  /** True when an extension cancels the fork */
  beforeFork(
    session: VelaSession,
    entryId: string,
    position: 'before' | 'at',
  ): Promise<boolean>
}

/** Session ids become file names: only letters, digits, `.`, `_` and `-`, and no leading `.`. */
const SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/

export function assertSessionId(id: string): void {
  if (!SESSION_ID.test(id))
    throw new Error(
      `Invalid session id "${id}": use only letters, digits, . _ -, do not start with ., at most 128 characters`,
    )
}

/** Shared parts createVela() hands to every session. */
export interface SessionDeps {
  /** Default model */
  model: string | LanguageModel | undefined
  /** Resolves a model by name or object (including the provider registry) */
  resolveModel: (model: string | LanguageModel | undefined) => ResolvedModel
  thinkingLevel: ThinkingLevel
  /** Automatic compaction for new sessions */
  autoCompaction: boolean
  /** Opens a new session in the same Vela (fork / clone); throws if the id is already open */
  openSession: (id: string, options: SessionOptions) => VelaSession
  /** Explicitly given limits; the rest are derived from the model's context window */
  limitOverrides: Partial<VelaLimits>
  logger: VelaLogger
  dataDir: string
  /** Working directory, recorded in new session files */
  cwd?: string
  /** Where session history is stored (file / memory / custom) */
  sessionStorage: SessionStorage
  /** dataDir is a temp dir that dispose() deletes (no dataDir given): tool history may be gone on resume */
  temporaryDataDir?: boolean
  /** Vela-level tool registry; each session forks its own from it */
  registry: ToolRegistry
  builder: PromptPipeline
  /** Expands `/skill:<name>` and prompt templates in owner input (src/prompt/templates.ts) */
  expandInput: (text: string) => string
  extensions: SessionExtensionHooks
  /** Session events also go to Vela's subscribers */
  forward: (event: VelaEvent, sessionId: string) => void
  onClose: (session: VelaSession) => void
}

/**
 * One conversation: its own message history, compaction state, usage, tool results, role and run lock.
 * Tool definitions, extensions, memory, knowledge base, skills and channels are shared by all sessions in the same Vela.
 */
export class VelaSession {
  readonly id: string
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
  /** @internal */
  readonly contextManager: ContextManager
  /** @internal This session's registry: shared tool definitions, separate tool results, permissions and discovered deferred tools */
  readonly registry: ToolRegistry
  /** @internal Run lock: held while any agent loop (prompt, skill, dream, defend, ingest) runs */
  readonly busy: { locked: boolean; controller?: AbortController } = {
    locked: false,
  }
  /** @internal UI for extensions */
  readonly ui: ExtensionUI
  /** @internal Whether there is a real UI */
  readonly hasUI: boolean

  private readonly listeners = new Set<VelaEventListener>()
  /** Calls tools made through ctx.executeTool(), recorded on their caller's tool result (like pi's nestedCalls) */
  private readonly nestedCalls = new NestedCallLog()
  private readonly builder: PromptPipeline
  private readonly deps: SessionDeps
  /** Options the session was opened with (a fork opens with the same) */
  private readonly options: SessionOptions
  private closed = false
  private started?: Promise<void>
  private running?: Promise<void>
  /** Extension sections collected by this turn's before_agent_start */
  private sections: Record<string, string> = {}
  private readonly steeringQueue: string[] = []
  private readonly followUpQueue: string[] = []
  /** How steer messages are taken (default one-at-a-time, like pi) */
  steeringMode: QueueMode = 'one-at-a-time'
  /** How followUp messages are taken (default one-at-a-time, like pi) */
  followUpMode: QueueMode = 'one-at-a-time'

  /** @internal Created by vela.session() */
  constructor(id: string, deps: SessionDeps, options: SessionOptions = {}) {
    assertSessionId(id)
    this.id = id
    this.deps = deps
    this.options = options
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
      deps.cwd,
    )
    this.hasUI = options.ui !== undefined
    this.ui = options.ui ? withDefaults(options.ui) : headlessUI(this.emit)
    this.registry = deps.registry.fork(this.store.results, {
      onEvent: this.emit,
      sessionId: id,
      confirm: (toolName, input) =>
        this.ui.confirm(
          `Allow ${toolName} to run?`,
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
    this.contextManager.autoCompaction =
      options.autoCompaction ?? deps.autoCompaction
    // Like pi: a new session starts with its model and thinking level (written with the first message)
    if (typeof this.modelChoice === 'string')
      this.store.appendModelChange(this.modelChoice)
    this.store.appendThinkingLevelChange(this.thinking)
  }

  private displayName?: string

  /** Session display name (like pi's session name); saved with the session and shown in the session list. */
  get name(): string | undefined {
    return this.displayName
  }

  /** Sets the display name (empty string clears it), appended to the session like pi's session_info. */
  setName(name: string | undefined): void {
    const next = name?.replace(/[\r\n]+/g, ' ').trim() || undefined
    if (next === this.displayName) return
    this.displayName = next
    this.store.appendSessionInfo(next)
  }

  /** Selected model (name or object); resolution is deferred until first use (providers registered by extensions may not be loaded yet) */
  private modelChoice: string | LanguageModel | undefined
  private resolved?: ResolvedModel
  private thinking: ThinkingLevel

  private resolveModel(): ResolvedModel {
    if (!this.resolved)
      this.applyModel(this.deps.resolveModel(this.modelChoice))
    return this.resolved as ResolvedModel
  }

  private applyModel(resolved: ResolvedModel): void {
    this.resolved = resolved
    const limits = limitsForModel(resolved.info, this.deps.limitOverrides)
    Object.assign(this.limits, limits)
    Object.assign(this.contextManager.limits, limits)
    this.tracker.contextWindow = resolved.info.contextWindow ?? CONTEXT_WINDOW
    // Price follows the current model (not keyed by modelId: same-named models from different providers cost differently)
    this.tracker.setPricing(resolved.info.cost)
  }

  /** Current model (AI SDK LanguageModel). Throws if the name cannot be resolved. */
  get model(): LanguageModel {
    return this.resolveModel().model
  }

  /** Current model metadata: provider, id, `provider/id`, context window, etc. */
  get modelInfo(): ModelInfo {
    return this.resolveModel().info
  }

  /**
   * Switches the model (like pi's setModel): `provider/id` or LanguageModel, effective from the next prompt().
   * Compaction thresholds are recomputed from the new model's context window. Throws and keeps the
   * current model if the name cannot be resolved. A model chosen by name is appended to the session (`model_change`).
   */
  setModel(model: string | LanguageModel): void {
    this.selectModel(model, true)
  }

  private selectModel(model: string | LanguageModel, record: boolean): void {
    const resolved = this.deps.resolveModel(model)
    this.modelChoice = model
    this.applyModel(resolved)
    if (record && typeof model === 'string')
      this.store.appendModelChange(resolved.info.ref ?? model)
  }

  /** Thinking level (off … max, default medium). */
  get thinkingLevel(): ThinkingLevel {
    return this.thinking
  }

  /**
   * Sets the thinking level (like pi's setThinkingLevel); effective from the next request and saved with the session.
   * prompt() throws if the model does not support thinking (model entry has `reasoning: false`, or the provider rejects it).
   */
  setThinkingLevel(level: ThinkingLevel): void {
    if (!THINKING_LEVELS.includes(level))
      throw new Error(
        `Thinking level must be one of ${THINKING_LEVELS.join(' / ')}`,
      )
    if (level === this.thinking) return
    this.thinking = level
    this.store.appendThinkingLevelChange(level)
  }

  /** Session role (owner / collaborator / guest): decides which tools are available and whether extension commands can run. */
  get role(): Role {
    return this.registry.getRole()
  }

  set role(role: Role) {
    this.registry.setRole(role)
  }

  /** Tool names the model can currently see (after role, tool selection and deferred loading). */
  getActiveTools(): string[] {
    return this.registry.getActiveTools().map((tool) => tool.name)
  }

  /** Enable only these tools (still limited by the role); pass undefined to restore all. Like pi's setActiveTools. */
  setActiveTools(names: string[] | undefined): void {
    this.registry.setSelection(names)
  }

  /** Running extension commands (commands don't hold the run lock; several can run at once and may call prompt()) */
  private readonly commands = new Map<AbortController, Promise<boolean>>()

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
  readonly emit = (event: VelaEvent): void => {
    this.nestedCalls.observe(event)
    for (const listener of this.listeners) listener(event)
    this.deps.forward(event, this.id)
  }

  /** @internal `sections` defaults to the sections collected by this turn's before_agent_start */
  promptContext(sections = this.sections): PromptContext {
    return {
      role: this.role,
      extensionSections: sections,
      toolCount: this.registry.getActiveTools().length,
      deferredToolSummary: this.registry.getDeferredToolSummary(),
      sessionMessageCount: this.messages.length,
      sessionId: this.id,
      toolResults: this.store.results,
      activeTools: this.registry.getActiveTools().map((tool) => tool.name),
    }
  }

  /** @internal This session's system prompt (rebuilt before each turn's requests). */
  buildSystem(sections?: Record<string, string>): string {
    return this.builder.build(this.promptContext(sections))
  }

  /**
   * @internal Extension sections the next prompt would get: runs before_agent_start without replacing this
   * turn's sections (for the /context preview; sections are computed per prompt, so they are empty before the first prompt).
   */
  async previewSections(): Promise<Record<string, string>> {
    await this.start()
    return this.deps.extensions.beforeAgentStart(this, '')
  }

  /** @internal Prepares the context before a request (microcompaction / summary). */
  prepareContext(
    request: RequestSnapshot,
    options?: { allowSummary?: boolean },
  ): Promise<void> {
    return this.contextManager.prepare(request, options)
  }

  /** @internal Waits until the session's entries are written to storage; rejects if some could not be. */
  save(): Promise<void> {
    return this.contextManager.save()
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

  /** Sets (or clears, with undefined / empty) a label on an entry, like pi's `/tree` labels. */
  setLabel(entryId: string, label: string | undefined): void {
    this.store.appendLabelChange(
      entryId,
      label?.replace(/[\r\n]+/g, ' ').trim() || undefined,
    )
  }

  /**
   * Whether the context is compacted automatically (like pi's autoCompactionEnabled). Off: no microcompaction,
   * no threshold summary, no compact-and-retry on overflow; compact() still works.
   */
  get autoCompaction(): boolean {
    return this.contextManager.autoCompaction
  }

  set autoCompaction(enabled: boolean) {
    this.contextManager.autoCompaction = enabled
  }

  /** Takes the run lock for a session-level task (compact, tree navigation); throws if something runs. */
  private async exclusive<T>(
    what: string,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
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
      await this.start()
      const oldBranch = this.store.getBranch(oldLeafId)
      const targetIds = new Set(
        this.store.getBranch(targetId).map((entry) => entry.id),
      )
      let common = -1
      while (
        common + 1 < oldBranch.length &&
        targetIds.has((oldBranch[common + 1] as SessionEntry).id)
      )
        common++
      const commonAncestorId = oldBranch[common]?.id ?? null
      const preparation: TreePreparation = {
        targetId,
        oldLeafId,
        commonAncestorId,
        entriesToSummarize: oldBranch.slice(common + 1),
        userWantsSummary: options.summarize ?? false,
        ...(options.focus ? { focus: options.focus } : {}),
        ...(options.label ? { label: options.label } : {}),
      }
      const hook = await this.deps.extensions.beforeTree(
        this,
        preparation,
        signal,
      )
      if (hook.cancel) return { cancelled: true }
      const focus = hook.focus ?? options.focus
      const label = (hook.label ?? options.label)?.trim() || undefined
      let summary: string | undefined
      let fromExtension = false
      if (options.summarize && preparation.entriesToSummarize.length) {
        if (hook.summary) {
          summary = hook.summary.summary
          fromExtension = true
        } else {
          try {
            summary = await this.summarizeBranch(
              new Set(oldBranch.slice(0, common + 1).map((entry) => entry.id)),
              focus,
              signal,
            )
          } catch (error) {
            if (signal.aborted) return { cancelled: true }
            throw error
          }
        }
      }
      let newLeafId: string | null = targetId
      let editorText: string | undefined
      if (isUser) {
        newLeafId = target.parentId
        editorText = messageText(target.message.content)
      }
      let summaryEntry: BranchSummaryEntry | undefined
      if (summary) {
        summaryEntry = this.store.branchWithSummary(newLeafId, summary)
        if (label) this.store.appendLabelChange(summaryEntry.id, label)
      } else {
        this.store.branch(newLeafId)
        if (label) this.store.appendLabelChange(targetId, label)
      }
      await this.loadBranch(this.store.buildContext())
      await this.deps.extensions.tree(this, {
        type: 'session_tree',
        newLeafId: this.store.getLeafId(),
        oldLeafId,
        ...(summaryEntry
          ? { summaryEntry: structuredClone(summaryEntry), fromExtension }
          : {}),
      })
      await this.saveOrReport()
      return {
        ...(editorText === undefined ? {} : { editorText }),
        cancelled: false,
      }
    })
  }

  /**
   * Summarizes the context messages after the common ancestor (the branch being left). Returns undefined
   * when that part has no messages.
   */
  private async summarizeBranch(
    ancestorIds: Set<string>,
    focus: string | undefined,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    let start = 0
    this.messages.forEach((message, index) => {
      const id = this.store.idOf(message)
      if (id && ancestorIds.has(id)) start = index + 1
    })
    if (start >= this.messages.length) return
    const request = await createRequestSnapshot(
      this.model,
      this.buildSystem(),
      this.registry.toAISDKFormat(),
      this.messages,
      signal,
    )
    return this.contextManager.summarizeBranch(request, start, focus)
  }

  /** Makes the store's current branch the session's context, model and thinking level. */
  private async loadBranch(context: SessionContext): Promise<void> {
    this.contextManager.restore(context)
    if (
      context.thinkingLevel &&
      THINKING_LEVELS.includes(context.thinkingLevel)
    )
      this.thinking = context.thinkingLevel
    if (context.model && context.model !== this.resolved?.info.ref) {
      // Providers registered by extensions resolve only after extensions load
      await this.deps.extensions.ready.catch(() => {})
      try {
        this.selectModel(context.model, false)
      } catch (error) {
        this.deps.logger.warn(
          `[session] Saved model ${context.model} for ${this.id} is unavailable, keeping the current model: ${error instanceof Error ? error.message : error}`,
        )
      }
    }
    // The branch's latest summary points into the tool call history up to this sequence
    const results = this.store.results
    const sequence = context.toolHistoryViewSeq
    await results.history.load()
    if (sequence !== undefined && sequence <= results.history.throughSequence) {
      await results.history.snapshot(undefined, sequence)
      results.historyViewSequence = sequence
    } else results.historyViewSequence = undefined
    this.tracker.setEstimatedTokens(estimateMessageTokens(this.messages))
  }

  /**
   * Copies the branch up to an entry into a new session (like pi's fork). `before` (default) needs a user
   * message and ends just before it, returning its text; `at` includes the entry. Unlike pi, which replaces
   * its one session, Vela opens the copy as another session in the same Vela and leaves this one open.
   * The new session records this one as `parentSession`. Throws while running.
   */
  async fork(entryId: string, options: ForkOptions = {}): Promise<ForkResult> {
    const position = options.position ?? 'before'
    const entry = this.store.getEntry(entryId)
    if (!entry) throw new Error(`Entry ${entryId} is not in the session`)
    let leafId: string | null = entryId
    let selectedText: string | undefined
    if (position === 'before') {
      if (entry.type !== 'message' || entry.message.role !== 'user')
        throw new Error(`Entry ${entryId} is not a user message to fork from`)
      leafId = entry.parentId
      selectedText = messageText(entry.message.content)
    }
    // Holds the run lock so no prompt appends to this session (or its tool history) while it is copied
    return this.exclusive('fork', async () => {
      await this.start()
      if (await this.deps.extensions.beforeFork(this, entryId, position))
        return { cancelled: true }
      const branch = leafId === null ? [] : this.store.getBranch(leafId)
      const session = this.deps.openSession(
        options.sessionId ?? newSessionId(),
        {
          ...this.options,
          role: this.role,
          model: this.modelChoice,
          thinkingLevel: this.thinking,
          autoCompaction: this.autoCompaction,
        },
      )
      try {
        await session.seedFrom(this, branch)
      } catch (error) {
        await session.close()
        throw error
      }
      return {
        cancelled: false,
        session,
        ...(selectedText === undefined ? {} : { selectedText }),
      }
    })
  }

  /** Copies the current branch into a new session (like pi's /clone, a fork at the leaf). */
  clone(options: Omit<ForkOptions, 'position'> = {}): Promise<ForkResult> {
    const leafId = this.store.getLeafId()
    // Setup entries (model, thinking level) alone are not a conversation to copy
    const hasConversation = this.store
      .getBranch()
      .some(
        (entry) =>
          entry.type === 'message' &&
          (entry.message.role === 'user' || entry.message.role === 'assistant'),
      )
    if (!leafId || !hasConversation)
      return Promise.reject(new Error('Nothing to clone yet'))
    return this.fork(leafId, { ...options, position: 'at' })
  }

  /** @internal Starts this new session as a copy of `parent`'s branch (fork / clone). */
  async seedFrom(parent: VelaSession, branch: SessionEntry[]): Promise<void> {
    await this.store.seedFrom(branch, {
      id: parent.id,
      results: parent.store.results,
    })
    if (branch.length) await this.loadBranch(this.store.buildContext())
    await this.store.flush()
  }

  /** The current branch as JSONL lines (like pi's exportToJsonl): a header, then the entries re-chained. */
  private branchJsonl(): string {
    const header: SessionHeader = {
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: this.id,
      timestamp: new Date().toISOString(),
      ...(this.deps.cwd ? { cwd: this.deps.cwd } : {}),
    }
    const lines: object[] = [header]
    let parentId: string | null = null
    for (const entry of this.store.getBranch()) {
      lines.push({ ...entry, parentId })
      parentId = entry.id
    }
    return lines.map((line) => `${JSON.stringify(line)}\n`).join('')
  }

  private async writeExport(
    path: string | undefined,
    extension: string,
    content: string,
  ): Promise<string> {
    const target = resolve(
      this.deps.cwd ?? process.cwd(),
      path ??
        `vela-session-${this.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`,
    )
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, { mode: 0o600 })
    return target
  }

  /**
   * Writes the current branch as JSONL (like pi's exportToJsonl; the session file format, one branch).
   * Relative paths resolve against Vela's cwd; returns the path written.
   */
  exportJsonl(path?: string): Promise<string> {
    return this.writeExport(path, 'jsonl', this.branchJsonl())
  }

  /**
   * Writes the current branch as a self-contained HTML page (messages, thinking, tool calls and results).
   * Relative paths resolve against Vela's cwd; returns the path written. Review it before sharing: it holds
   * everything the session saw, including tool output.
   */
  exportHtml(path?: string): Promise<string> {
    return this.writeExport(
      path,
      'html',
      renderSessionHtml({
        id: this.id,
        name: this.name,
        model: this.modelChoice,
        entries: this.store.getBranch(),
      }),
    )
  }

  /** Restores history from session storage (replacing the in-memory history); returns whether a saved session was found. Not allowed while running. */
  async resume(): Promise<boolean> {
    if (this.busy.locked)
      throw new Error(`Session ${this.id} is running; cannot restore history`)
    // Entries not yet written would be replaced by the loaded ones
    await this.store.flush()
    const saved = await this.store.loadSaved()
    if (!saved) return false
    this.displayName = saved.name
    await this.loadBranch(saved)
    return true
  }

  /** Appends a message to history and the session (without calling the model). */
  append(message: ModelMessage): void {
    this.messages.push(message)
    this.tracker.addMessage(message)
    this.record(message)
    this.emit({ type: 'message_start', message })
    this.emit({ type: 'message_end', message })
  }

  /** Appends a message that entered the history to the session; a tool message carries the nested calls its tools made. */
  private record(message: ModelMessage): void {
    this.timestamps.set(message, Date.now())
    const nestedCalls: Record<string, NestedToolCalls> = {}
    if (message.role === 'tool')
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue
        const calls = this.nestedCalls.take(part.toolCallId)
        if (calls) nestedCalls[part.toolCallId] = calls
      }
    this.store.appendMessage(message, { nestedCalls })
  }

  /**
   * Appends a user message and runs the agent loop to completion (no turn limit, like pi), then saves the session.
   * steer / followUp messages queued during the run also finish before it resolves (`agent_settled` is emitted last).
   * If the loop fails, queued messages still run, then it rejects.
   * While running, pass `streamingBehavior` (or use steer() / followUp()); it then resolves right after enqueueing.
   * In owner sessions, `/name args` matching an extension command runs the command instead of going to the model (immediately, even while running).
   */
  prompt(input: string, options: PromptOptions = {}): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error(`Session ${this.id} is closed`))
    if (input.startsWith('/'))
      return (async () => {
        await this.start()
        if (await this.runCommand(input, options.signal)) return
        return this.promptExpanded(input, options)
      })()
    return this.promptModel(input, options)
  }

  /**
   * Expands `/skill:<name>` and prompt templates, then prompts (or queues). Like extension commands, only for the
   * session's owner. A skill file that can't be read rejects instead of sending the raw command.
   */
  private promptExpanded(input: string, options: PromptOptions): Promise<void> {
    if (this.role !== 'owner' || !input.startsWith('/'))
      return this.promptModel(input, options)
    let expanded: string
    try {
      expanded = this.deps.expandInput(input)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.promptModel(expanded, options)
  }

  /** Runs an extension command; abort() and options.signal abort the command's ctx.signal. */
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

  /** While running: joins the current task, sent as a user message after this step's tools finish and before the next model request. Same as prompt() when idle. */
  steer(input: string): Promise<void> {
    return this.promptExpanded(input, { streamingBehavior: 'steer' })
  }

  /** While running: runs as a user message when the model would otherwise stop (no tool calls, no steer). Same as prompt() when idle. */
  followUp(input: string): Promise<void> {
    return this.promptExpanded(input, { streamingBehavior: 'followUp' })
  }

  /** Clears queued messages and returns them (the TUI puts them back in the input box before aborting). */
  clearQueue(): { steering: string[]; followUp: string[] } {
    const cleared = {
      steering: this.steeringQueue.splice(0),
      followUp: this.followUpQueue.splice(0),
    }
    if (cleared.steering.length || cleared.followUp.length) this.emitQueue()
    return cleared
  }

  /** Currently queued messages (a copy) */
  get queue(): { steering: string[]; followUp: string[] } {
    return {
      steering: [...this.steeringQueue],
      followUp: [...this.followUpQueue],
    }
  }

  /** Whether an agent loop is running (including loops for queued messages and manual compaction) */
  get isRunning(): boolean {
    return this.busy.locked
  }

  /**
   * Waits for the agent loop (including loops for queued messages and manual compaction) to finish (like pi's waitForIdle).
   * Does not wait for extension commands: a command may call abort(), and waiting on itself would hang.
   */
  async waitForIdle(): Promise<void> {
    while (this.running) await this.running
  }

  private emitQueue(): void {
    this.emit({ type: 'queue_update', ...this.queue })
  }

  /** Takes from the queues by mode: steer first, then followUp. */
  private dequeue(kind: 'steering' | 'followUp'): string[] {
    const [queue, mode] =
      kind === 'steering'
        ? [this.steeringQueue, this.steeringMode]
        : [this.followUpQueue, this.followUpMode]
    const taken = queue.splice(0, mode === 'all' ? queue.length : 1)
    if (taken.length) this.emitQueue()
    return taken
  }

  /** `/xxx` that is not an extension command, or plain input: runs when idle, queued by streamingBehavior while running. */
  private promptModel(input: string, options: PromptOptions): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error(`Session ${this.id} is closed`))
    if (this.busy.locked) {
      // Only the prompt loop drains the queue; nothing can be queued while /defend, a skill or compact holds the lock
      if (!this.prompting || !options.streamingBehavior)
        return Promise.reject(
          new Error(
            'A task is already running: queue with steer() / followUp() (or streamingBehavior), or wait for it to finish',
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

  /** Before first use: waits for extensions to load and fires session_start (once). */
  private start(): Promise<void> {
    this.started ??= this.deps.extensions.ready.then(() =>
      this.deps.extensions.sessionStart(this),
    )
    return this.started
  }

  /** A prompt() run is in progress (it drains the queue before finishing) */
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
      // steer / followUp are normally taken inside agentLoop (like pi). If the loop ends early (error / budget /
      // loop detection), remaining messages run in a new loop (steer first). After an abort, stop and keep the queue.
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
          // Messages may be queued while saving: check again after saving; there is no await between here and unlock
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

  /** One agent loop: inputs are appended in order as user messages. */
  private async runLoop(inputs: string[], signal: AbortSignal): Promise<void> {
    await this.start()
    signal.throwIfAborted()
    const { model, info } = this.resolveModel()
    // Fail here if the model doesn't support the current thinking level, before sending a request or writing history
    const reasoning = reasoningOption(this.thinking, info)
    const input = inputs.join('\n\n')
    this.sections = await this.deps.extensions.beforeAgentStart(this, input)
    // Appending to a saved session that was not resumed would mix two conversations in one log
    await this.store.assertNew()
    this.emit({ type: 'agent_start', input })
    const newMessages: ModelMessage[] = []
    for (const text of inputs) {
      const message: ModelMessage = { role: 'user', content: text }
      this.append(message)
      newMessages.push(message)
    }
    await agentLoop({
      model,
      reasoning,
      systemPrompt: () => this.buildSystem(),
      toolRegistry: this.registry,
      messages: this.messages,
      tokenTracker: this.tracker,
      prepareContext: (request) => this.prepareContext(request),
      // Like pi: with automatic compaction off, a context overflow is reported as is
      compactOnOverflow: this.autoCompaction
        ? (overflowSignal) => this.compactForOverflow(overflowSignal)
        : undefined,
      newMessages,
      abortSignal: signal,
      onEvent: this.emit,
      limits: this.limits,
      takeSteering: () => this.dequeue('steering'),
      takeFollowUp: () => this.dequeue('followUp'),
      onMessage: (message) => this.record(message),
      // Like pi: kept in the session, never sent to the model again
      onInterrupted: (message, stopReason) =>
        this.store.appendMessage(message, { stopReason }),
    })
  }

  /** The provider rejected a request as too long: summarize like /compact (like pi's overflow recovery). */
  private async compactForOverflow(signal?: AbortSignal): Promise<void> {
    const request = await createRequestSnapshot(
      this.model,
      this.buildSystem(),
      this.registry.toAISDKFormat(),
      this.messages,
      signal,
    )
    if (!canSummarize(request.messages))
      throw new Error('Nothing to compact (session too small)')
    await this.contextManager.compact(request, undefined, 'overflow')
  }

  /**
   * Compacts the context manually (like pi's compact): replaces earlier history with a summary, keeps recent
   * messages, then saves. `focus` is what the summary should prefer to keep (pi's customInstructions).
   * Throws while the session is running; can be interrupted by abort().
   */
  async compact(focus?: string): Promise<void> {
    await this.exclusive('compact', async (signal) => {
      await this.start()
      const request = await createRequestSnapshot(
        this.model,
        this.buildSystem(),
        this.registry.toAISDKFormat(),
        this.messages,
        signal,
      )
      // Like pi: say so plainly when there is no earlier turn to summarize
      if (!canSummarize(request.messages))
        throw new Error('Nothing to compact (session too small)')
      await this.contextManager.compact(request, focus)
      await this.saveOrReport()
    })
  }

  /**
   * Aborts the current agent loop and extension commands (if any) and waits until the agent loop actually stops
   * (like pi's `await abort()`). Queued messages stay in the queue; call clearQueue() first if needed.
   */
  async abort(
    reason: unknown = new DOMException(
      'User cancelled the current operation',
      'AbortError',
    ),
  ): Promise<void> {
    for (const controller of [this.busy.controller, ...this.commands.keys()])
      if (controller && !controller.signal.aborted) controller.abort(reason)
    await this.waitForIdle()
  }

  /** Token estimate, context usage and this session's total usage. */
  get usage(): TokenStatus & { totals: UsageTotals } {
    return { ...this.tracker.status, totals: this.tracker.totals() }
  }

  /** Aborts the running task, waits for it to finish and save, then removes the session from Vela. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.abort(new DOMException('Session closed', 'AbortError'))
    // Let extension commands finish first (commands like /dream wait on the prompt they started)
    await Promise.allSettled(this.commands.values())
    await this.running
    await this.registry.waitForIdle().catch(() => {})
    // Only sessions that fired session_start emit session_shutdown
    if (this.started) {
      await this.started.catch(() => {})
      await this.deps.extensions.sessionShutdown(this)
    }
    // Entries appended while idle (setName, setModel) are written here at the latest
    await this.saveOrReport()
    this.listeners.clear()
    this.deps.onClose(this)
  }
}

/** ExtensionUI without a real UI: notify becomes an event, and anything needing an answer is treated as "no / no answer" (like pi). */
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

/** Fills in setStatus / setWidget the UI doesn't implement (no-ops). */
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
