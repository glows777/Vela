import { join, resolve } from 'node:path'
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import type {
  CustomMessage,
  CustomMessageInfo,
  VelaEvent,
  VelaEventListener,
} from './agent/events.ts'
import { agentLoop } from './agent/index.ts'
import { canSummarize } from './context/compressor.ts'
import { estimateMessageTokens } from './context/defense.ts'
import { ContextManager } from './context/manager.ts'
import {
  createRequestSnapshot,
  type RequestSnapshot,
} from './context/request.ts'
import type {
  ExtensionEventName,
  InputSource,
  ProviderStreamEvent,
  SessionBeforeTreeEventResult,
  SessionTreeEvent,
  TreePreparation,
} from './extensions/events.ts'
import { withProviderHooks } from './extensions/provider-hooks.ts'
import type { ExtensionUI, SessionUI } from './extensions/ui.ts'
import type { VelaLimits } from './limits.ts'
import type { VelaLogger } from './logger.ts'
import type { ImageContent, ModelMessage, TextContent } from './messages.ts'
import {
  clampThinkingLevel,
  supportedThinkingLevels,
} from './models/catalog.ts'
import {
  limitsForModel,
  type ModelInfo,
  type ResolvedModel,
  reasoningOption,
  THINKING_LEVELS,
  type ThinkingLevel,
} from './models/index.ts'
import type { PromptContext, PromptPipeline } from './prompt/pipeline.ts'
import type { PermissionRules } from './security/permissions.ts'
import {
  type BranchSummaryEntry,
  messageText as contentText,
  type NestedToolCalls,
  type SessionContext,
  type SessionEntry,
  type SessionTreeNode,
} from './session/entries.ts'
import { branchJsonl, writeExport } from './session/export.ts'
import { renderSessionHtml } from './session/export-html.ts'
import { SessionStore } from './session/index.ts'
import { MessageQueue, messageText } from './session/message-queue.ts'
import { NestedCallLog } from './session/nested-calls.ts'
import type { SendMessageOptions } from './session/options.ts'
import {
  assertSessionId,
  type ForkOptions,
  type NavigateTreeOptions,
  type QueueMode,
} from './session/options.ts'
import { newSessionId } from './session/session-id.ts'
import {
  type SessionPersistence,
  type SessionStorage,
  sessionArtifactsUseDataDir,
} from './session/storage.ts'
import { UserBash } from './session/user-bash.ts'
import type { ToolRegistry } from './tools/registry.ts'
import type { BashResult } from './tools/shell.ts'
import {
  CONTEXT_WINDOW,
  type TokenStatus,
  TokenTracker,
  type UsageTotals,
} from './usage/tracker.ts'

export interface PromptOptions {
  /** Inline images attached to this input; normalized after input hooks. */
  images?: ImageContent[]
  signal?: AbortSignal
  /**
   * How to handle this input while the session is running (like pi): `steer` joins the current task
   * (after this step's tools finish, before the next model request); `followUp` runs after the current
   * task ends. Required while running (throws otherwise); ignored when idle.
   */
  streamingBehavior?: 'steer' | 'followUp'
  /** Where the input came from, passed to `input` handlers (default `sdk`) */
  source?: InputSource
}

/** Options for `vela.session(id, options)`; only apply when the session is first opened. */
export interface SessionOptions {
  /** Working directory for this session's tools and automatic context; relative to Vela's cwd. */
  cwd?: string
  /** Tool permissions, e.g. `{ bash: 'ask' }`; tools without a rule are allowed */
  permissions?: PermissionRules
  /** Enable only these tools; default all */
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
interface SessionExtensionHooks {
  /** All extensions have loaded */
  ready: Promise<void>
  sessionStart(session: VelaSession): Promise<void>
  sessionShutdown(session: VelaSession): Promise<void>
  beforeAgentStart(
    session: VelaSession,
    prompt: string,
  ): Promise<{ sections: Record<string, string>; messages: CustomMessage[] }>
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
  hasHandlers(event: ExtensionEventName): boolean
  /** Text after the input handlers; undefined when a handler handled it */
  input(
    session: VelaSession,
    text: string,
    source: InputSource,
    streamingBehavior?: 'steer' | 'followUp',
    images?: ImageContent[],
  ): Promise<{ text: string; images?: ImageContent[] } | undefined>
  transformContext(
    session: VelaSession,
    messages: ModelMessage[],
    producer: string,
  ): Promise<ModelMessage[]>
  beforeProviderRequest(
    session: VelaSession,
    params: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4CallOptions>
  afterProviderResponse(
    session: VelaSession,
    headers: Record<string, string>,
  ): Promise<void>
  providerStreamEvent(session: VelaSession, event: ProviderStreamEvent): void
}

/** Shared parts createVela() hands to every session. */
export interface SessionDeps {
  /** Default model */
  model: string | LanguageModel | undefined
  /** Resolves a model by name or object (including the provider registry) for a session */
  resolveModel: (
    model: string | LanguageModel | undefined,
    session: VelaSession,
  ) => ResolvedModel
  thinkingLevel: ThinkingLevel
  /** Automatic compaction for new sessions */
  autoCompaction: boolean
  /** Opens a new session in the same Vela (fork / clone); throws if the id is already open */
  openSession: (id: string, options: SessionOptions) => VelaSession
  /** Explicitly given limits; the rest are derived from the model's context window */
  limitOverrides: Partial<VelaLimits>
  logger: VelaLogger
  dataDir: string
  /** Working directory, recorded in new session files; `executeBash()` runs commands here */
  cwd?: string
  /** Shell for `executeBash()` (settings `shellPath`); default bash on PATH */
  shellPath?: string
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
  onSaved: (sessionId: string) => void
}

/**
 * One conversation: its own message history, compaction state, usage, tool results and run lock.
 * Tool definitions, extensions, memory, knowledge base, skills and channels are shared by all sessions in the same Vela.
 */
export class VelaSession {
  readonly id: string
  /** Effective working directory; not a filesystem sandbox. */
  readonly cwd: string
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
  /** Tools' display data from `tool_execution_end`, recorded on their tool message like nestedCalls */
  private readonly toolDetails = new Map<string, unknown>()
  private readonly userBash: UserBash
  private readonly builder: PromptPipeline
  private readonly deps: SessionDeps
  /** Options the session was opened with (a fork opens with the same) */
  private readonly options: SessionOptions
  private closed = false
  /** The close in progress: a second caller waits for the final save instead of returning early */
  private closing?: Promise<void>
  private started?: Promise<void>
  private running?: Promise<void>
  /** Extension sections collected by this turn's before_agent_start */
  private sections: Record<string, string> = {}
  private readonly messageQueue = new MessageQueue((event) => this.emit(event))
  /** How steer messages are taken (default one-at-a-time, like pi) */
  steeringMode: QueueMode = 'one-at-a-time'
  /** How followUp messages are taken (default one-at-a-time, like pi) */
  followUpMode: QueueMode = 'one-at-a-time'

  /** @internal Created by vela.session() */
  constructor(id: string, deps: SessionDeps, options: SessionOptions = {}) {
    assertSessionId(id)
    this.id = id
    this.cwd = resolve(deps.cwd ?? process.cwd(), options.cwd ?? '.')
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
      this.cwd,
      () => deps.onSaved(id),
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
    this.registry.setPermissions(options.permissions)
    this.registry.setSelection(options.tools)
    // --no-session keeps usage in memory. /usage and /status still read the tracker;
    // they must not append usage/today.jsonl under the data directory.
    this.tracker = new TokenTracker(
      sessionArtifactsUseDataDir(deps.sessionStorage, id, deps.temporaryDataDir)
        ? join(deps.dataDir, 'usage', 'today.jsonl')
        : undefined,
    )
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
      cwd: this.cwd,
      shellPath: deps.shellPath,
      emit: this.emit,
      busy: this.busy,
      save: () => this.saveOrReport(),
      messages: this.messages,
      tracker: this.tracker,
      timestamps: this.timestamps,
    })
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
      this.applyModel(this.deps.resolveModel(this.modelChoice, this))
    return this.resolved as ResolvedModel
  }

  private applyModel(resolved: ResolvedModel): void {
    this.resolved = resolved
    this.hooked = undefined
    const limits = limitsForModel(resolved.info, this.deps.limitOverrides)
    Object.assign(this.limits, limits)
    Object.assign(this.contextManager.limits, limits)
    const window = resolved.info.contextWindow ?? CONTEXT_WINDOW
    this.tracker.setModel(window, resolved.info.cost)
  }

  /** The current model wrapped with the extension provider hooks (what requests go through) */
  private hooked?: LanguageModel

  private requestModel(): LanguageModel {
    this.hooked ??= withProviderHooks(this.model, {
      has: (event) => this.deps.extensions.hasHandlers(event),
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
    return this.hooked
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
    const resolved = this.deps.resolveModel(model, this)
    const thinking = this.thinkingLevel
    this.modelChoice = model
    this.applyModel(resolved)
    if (record && typeof model === 'string')
      this.store.appendModelChange(resolved.info.ref ?? model)
    // Like pi's setModel: the thinking level is clamped to the new model and saved when that changes it
    if (record && this.thinkingLevel !== thinking)
      this.store.appendThinkingLevelChange(this.thinkingLevel)
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
      return this.thinking
    }
    return clampThinkingLevel(this.thinking, info, THINKING_LEVELS)
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
    const before = this.thinkingLevel
    this.thinking = level
    const after = this.thinkingLevel
    if (after !== before) this.store.appendThinkingLevelChange(after)
  }

  /**
   * The channel this session answers on (e.g. `feishu`), set by the channel gateway on every message; undefined
   * for local sessions. Providers see it as `ProviderContext.channel()`.
   */
  channel?: string

  /** Tool names the model can currently see (after tool selection and deferred loading). */
  getActiveTools(): string[] {
    return this.registry.getActiveTools().map((tool) => tool.name)
  }

  /** Enable only these tools; pass undefined to restore all. Like pi's setActiveTools. */
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
  readonly emit = (raw: VelaEvent): void => {
    let event = raw
    if (
      (event.type === 'message_start' || event.type === 'message_end') &&
      !event.custom
    ) {
      const custom = this.messageQueue.customMessages.get(event.message)
      if (custom) event = { ...event, custom }
    }
    this.nestedCalls.observe(event)
    if (
      event.type === 'tool_execution_end' &&
      !event.parentToolCallId &&
      event.details !== undefined
    )
      this.toolDetails.set(event.toolCallId, event.details)
    for (const listener of this.listeners) listener(event)
    this.deps.forward(event, this.id)
    // Like pi: the step's assistant and tool messages are in the history now, so a custom message cannot land
    // between a tool call and its result
    if (event.type === 'turn_end') this.flushPendingCustom()
  }

  /** @internal `sections` defaults to the sections collected by this turn's before_agent_start */
  promptContext(sections = this.sections): PromptContext {
    return {
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
    return (await this.deps.extensions.beforeAgentStart(this, '')).sections
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

  /**
   * Where this session's history is kept. `file` is the jsonl path (the file may not exist until
   * the first user or assistant message). `memory` is not saved and cannot be resumed. `unknown`
   * means the storage did not report a location; the session may still be persisted.
   */
  get persistence(): SessionPersistence {
    return (
      this.deps.sessionStorage.persistence?.(this.id) ?? { type: 'unknown' }
    )
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
      this.flushPendingCustom()
      while (this.userBash.flush()) await this.saveOrReport()
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
        editorText = contentText(target.message.content)
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
    this.registry.discoveredTools = new Set(await this.store.loadedTools())
    for (const [message, info] of context.custom)
      this.messageQueue.customMessages.set(message, info)
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
      selectedText = contentText(entry.message.content)
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
          entry.type === 'custom_message' ||
          entry.type === 'bash_execution' ||
          (entry.type === 'message' &&
            (entry.message.role === 'user' ||
              entry.message.role === 'assistant')),
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

  /**
   * Writes the current branch as JSONL (like pi's exportToJsonl; the session file format, one branch).
   * Relative paths resolve against Vela's cwd; returns the path written.
   */
  exportJsonl(path?: string): Promise<string> {
    return writeExport(
      this.id,
      this.deps.cwd,
      path,
      'jsonl',
      branchJsonl(this.id, this.cwd, this.store.getBranch()),
    )
  }

  /**
   * Writes the current branch as a self-contained HTML page (messages, thinking, tool calls and results).
   * Relative paths resolve against Vela's cwd; returns the path written. Review it before sharing: it holds
   * everything the session saw, including tool output.
   */
  exportHtml(path?: string): Promise<string> {
    return writeExport(
      this.id,
      this.deps.cwd,
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

  /** Appends a message that entered the history to the session; a tool message carries its tools' nested calls and details. */
  private record(message: ModelMessage, producedBy?: string): void {
    this.timestamps.set(message, Date.now())
    const custom = this.messageQueue.customMessages.get(message)
    if (custom && message.role === 'user') {
      this.store.appendCustomMessage(message, custom)
      return
    }
    const nestedCalls: Record<string, NestedToolCalls> = {}
    const details: Record<string, unknown> = {}
    if (message.role === 'tool')
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue
        const calls = this.nestedCalls.take(part.toolCallId)
        if (calls) nestedCalls[part.toolCallId] = calls
        if (this.toolDetails.has(part.toolCallId)) {
          details[part.toolCallId] = this.toolDetails.get(part.toolCallId)
          this.toolDetails.delete(part.toolCallId)
        }
      }
    this.store.appendMessage(message, { nestedCalls, details, producedBy })
  }

  /** Whether an `executeBash()` command is running */
  get isBashRunning(): boolean {
    return this.userBash.isRunning
  }

  /**
   * Runs a shell command for the user (pi's `executeBash`, the TUI's `!cmd`) in the working directory,
   * without tool permissions or hooks; owner sessions only, one command at a time. The result is recorded
   * in the session and reaches the model as a user message with the next prompt; `excludeFromContext`
   * (`!!cmd`) records it without sending it. While the agent runs, recording waits until it stops.
   * `onUpdate` gets the output's tail while the command runs; `bash_execution_update` events carry each new
   * piece of output, with `id` (like pi). Rejects if the command cannot start.
   */
  async executeBash(
    command: string,
    options: {
      excludeFromContext?: boolean
      onUpdate?: (output: string) => void
      /** Set on this command's `bash_execution_update` events */
      id?: string
    } = {},
  ): Promise<BashResult> {
    if (this.closed) throw new Error(`Session ${this.id} is closed`)
    return this.userBash.execute(command, options)
  }

  /** Cancels the running `executeBash()` command (pi's abortBash); it is still recorded, as cancelled. */
  abortBash(): void {
    this.userBash.abort()
  }

  /**
   * Appends a user message and runs the agent loop to completion (no turn limit, like pi), then saves the session.
   * steer / followUp messages queued during the run also finish before it resolves (`agent_settled` is emitted last).
   * If the loop fails, queued messages still run, then it rejects.
   * While running, pass `streamingBehavior` (or use steer() / followUp()); it then resolves right after enqueueing.
   * In owner sessions, `/name args` matching an extension command runs the command instead of going to the model (immediately, even while running).
   * Other input goes through the extensions' `input` handlers first (like pi); a handled input resolves without running.
   */
  prompt(input: string, options: PromptOptions = {}): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error(`Session ${this.id} is closed`))
    if (input.startsWith('/'))
      return (async () => {
        await this.start()
        if (this.closed) throw new Error(`Session ${this.id} is closed`)
        if (await this.runCommand(input, options.signal)) return
        return this.promptInput(input, options)
      })()
    return this.promptInput(input, options)
  }

  /**
   * Runs the `input` handlers, then expands and prompts (or queues). Without input handlers nothing is awaited
   * before the run lock is taken or the input queued, so back-to-back calls keep their order.
   */
  private promptInput(
    input: string,
    options: PromptOptions,
    expand = true,
  ): Promise<void> {
    const next = (text: string, images = options.images) =>
      expand
        ? this.promptExpanded(text, { ...options, images })
        : this.promptModel(text, { ...options, images })
    if (!this.deps.extensions.hasHandlers('input')) return next(input)
    return (async () => {
      await this.start()
      const result = await this.deps.extensions.input(
        this,
        input,
        options.source ?? 'sdk',
        this.prompting ? options.streamingBehavior : undefined,
        options.images,
      )
      if (result === undefined) return
      return next(result.text, result.images)
    })()
  }

  /**
   * Expands `/skill:<name>` and prompt templates, then prompts (or queues). A skill file that can't be
   * read rejects instead of sending the raw command.
   */
  private promptExpanded(input: string, options: PromptOptions): Promise<void> {
    if (!input.startsWith('/')) return this.promptModel(input, options)
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
  steer(
    input: string,
    options: { source?: InputSource; images?: ImageContent[] } = {},
  ): Promise<void> {
    return this.promptInput(input, { ...options, streamingBehavior: 'steer' })
  }

  /** While running: runs as a user message when the model would otherwise stop (no tool calls, no steer). Same as prompt() when idle. */
  followUp(
    input: string,
    options: { source?: InputSource; images?: ImageContent[] } = {},
  ): Promise<void> {
    return this.promptInput(input, {
      ...options,
      streamingBehavior: 'followUp',
    })
  }

  /**
   * Adds an extension's custom message to the conversation (like pi's `sendMessage`). The model sees it as a
   * user message; it is saved as a `custom_message` entry and its events carry `custom`.
   * - `deliverAs: 'nextTurn'`: added after the user message of the next prompt.
   * - Running (and `triggerTurn` not false): queued like steer() (or followUp() with `deliverAs: 'followUp'`).
   * - Idle with `triggerTurn`: runs the agent loop with the message as its input; resolves when the run ends.
   * - Running with `triggerTurn: false`: appended once the current step's tool results are in.
   * - Otherwise appended right away.
   */
  async sendMessage(
    message: CustomMessage,
    options: SendMessageOptions = {},
  ): Promise<void> {
    if (this.closed) throw new Error(`Session ${this.id} is closed`)
    const entry = this.customMessage(message)
    if (options.deliverAs === 'nextTurn') {
      this.messageQueue.nextTurnMessages.push(entry)
      return
    }
    if (this.prompting && options.triggerTurn !== false) {
      this.messageQueue.enqueue(
        options.deliverAs === 'followUp' ? 'followUp' : 'steering',
        entry,
      )
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
   * `deliverAs` to queue it.
   */
  sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options: { deliverAs?: 'steer' | 'followUp' } = {},
  ): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error(`Session ${this.id} is closed`))
    const text =
      typeof content === 'string'
        ? content
        : content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
    const images =
      typeof content === 'string'
        ? undefined
        : content.filter((part) => part.type === 'image')
    return this.promptInput(
      text,
      {
        source: 'extension',
        images,
        ...(options.deliverAs ? { streamingBehavior: options.deliverAs } : {}),
      },
      false,
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

  /** Builds the user message a custom message becomes and remembers its fields. */
  private customMessage(message: CustomMessage): ModelMessage {
    assertCustomType(message.customType)
    if (typeof message.content !== 'string' && !Array.isArray(message.content))
      throw new Error('A custom message needs content (a string or parts)')
    const entry: ModelMessage = { role: 'user', content: message.content }
    this.messageQueue.customMessages.set(entry, {
      customType: message.customType,
      display: message.display === true,
      ...(message.details === undefined ? {} : { details: message.details }),
    })
    return entry
  }

  private flushPendingCustom(): void {
    for (const message of this.messageQueue.pendingCustom.splice(0))
      this.append(message)
  }

  /** Clears queued messages and returns the user inputs among them (the TUI puts them back in the input box before aborting). */
  clearQueue(): { steering: string[]; followUp: string[] } {
    return this.messageQueue.clear()
  }

  /** Currently queued user inputs (a copy; queued custom messages are not listed) */
  get queue(): { steering: string[]; followUp: string[] } {
    return this.messageQueue.queue
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

  /** Takes from the queues by mode: steer first, then followUp. */
  private dequeue(kind: 'steering' | 'followUp'): ModelMessage[] {
    return this.messageQueue.dequeue(
      kind,
      kind === 'steering' ? this.steeringMode : this.followUpMode,
    )
  }

  /** `/xxx` that is not an extension command, or plain input: runs when idle, queued by streamingBehavior while running. */
  private promptModel(input: string, options: PromptOptions): Promise<void> {
    const content = options.images?.length
      ? [
          { type: 'text' as const, text: input },
          ...options.images.map((image) => ({ ...image })),
        ]
      : input
    return this.promptMessage({ role: 'user', content }, options)
  }

  private promptMessage(
    message: ModelMessage,
    options: PromptOptions,
  ): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error(`Session ${this.id} is closed`))
    // Input hooks can finish after cancellation, while the aborted loop is still cleaning up.
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)
    if (this.busy.locked) {
      // Only the prompt loop drains the queue; nothing can be queued while /defend, a skill or compact holds the lock
      if (!this.prompting || !options.streamingBehavior)
        return Promise.reject(
          new Error(
            'A task is already running: queue with steer() / followUp() (or streamingBehavior), or wait for it to finish',
          ),
        )
      this.messageQueue.enqueue(
        options.streamingBehavior === 'steer' ? 'steering' : 'followUp',
        message,
      )
      return Promise.resolve()
    }
    const run = this.run(message, options)
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

  private async run(
    input: ModelMessage,
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
          this.flushPendingCustom()
          await this.saveOrReport()
          saved = true
          inputs = next()
        }
      }
    } finally {
      options.signal?.removeEventListener('abort', forward)
      this.flushPendingCustom()
      this.toolDetails.clear()
      if (!saved) await this.saveOrReport()
      // Until the last flush finds nothing there is no await before unlocking: a later `!` command records itself
      while (this.userBash.flush()) await this.saveOrReport()
      busy.locked = false
      busy.controller = undefined
      this.prompting = false
      // Sent while saving (written with the next entry or when the session closes)
      this.flushPendingCustom()
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

  /** One agent loop: the inputs are appended in order, then next-turn custom messages and before_agent_start's. */
  private async runLoop(
    inputs: ModelMessage[],
    signal: AbortSignal,
  ): Promise<void> {
    await this.start()
    signal.throwIfAborted()
    const { info } = this.resolveModel()
    // Like pi, save a model picked automatically (no model chosen: the first provider with a credential), so a
    // resumed session keeps it even when the credentials change later
    if (this.modelChoice === undefined) {
      this.modelChoice = info.ref
      this.store.appendModelChange(info.ref)
    }
    const reasoning = reasoningOption(this.thinkingLevel, info)
    inputs = await Promise.all(
      inputs.map((message) => this.messageQueue.normalizeInput(message)),
    )
    signal.throwIfAborted()
    const input = inputs.map(messageText).join('\n\n')
    const started = await this.deps.extensions.beforeAgentStart(this, input)
    this.sections = started.sections
    // An invalid message from a before_agent_start handler fails the prompt here, before agent_start
    const added = started.messages.map((message) => this.customMessage(message))
    // Appending to a saved session that was not resumed would mix two conversations in one log
    await this.store.assertNew()
    // `!` commands that finished during an earlier loop of this run come before the new input
    this.userBash.flush()
    this.flushPendingCustom()
    this.emit({ type: 'agent_start', input })
    const newMessages: ModelMessage[] = []
    for (const message of [
      ...inputs,
      ...this.messageQueue.nextTurnMessages.splice(0),
      ...added,
    ]) {
      this.append(message)
      newMessages.push(message)
    }
    await agentLoop({
      model: this.requestModel(),
      supportsImages: info.input?.includes('image') ?? true,
      reasoning,
      systemPrompt: () => this.buildSystem(),
      toolRegistry: this.registry,
      messages: this.messages,
      tokenTracker: this.tracker,
      prepareContext: (request) => this.prepareContext(request),
      transformContext: (messages, producer) =>
        this.deps.extensions.transformContext(this, messages, producer),
      // Like pi: with automatic compaction off, a context overflow is reported as is
      compactOnOverflow: this.autoCompaction
        ? (overflowSignal) => this.compactForOverflow(overflowSignal)
        : undefined,
      newMessages,
      abortSignal: signal,
      onEvent: this.emit,
      limits: this.limits,
      takeSteering: () =>
        Promise.all(
          this.dequeue('steering').map((message) =>
            this.messageQueue.normalizeInput(message),
          ),
        ),
      takeFollowUp: () =>
        Promise.all(
          this.dequeue('followUp').map((message) =>
            this.messageQueue.normalizeInput(message),
          ),
        ),
      onMessage: (message, producer) => this.record(message, producer),
      injectNotice: (content) =>
        this.customMessage({
          customType: 'loop',
          content,
          display: true,
        }),
      // Like pi: kept in the session, never sent to the model again
      onInterrupted: (message, stopReason) =>
        this.store.appendMessage(message, { stopReason }),
    })
  }

  /** The provider rejected a request as too long: summarize like /compact (like pi's overflow recovery). */
  private async compactForOverflow(signal?: AbortSignal): Promise<void> {
    const request = await createRequestSnapshot(
      this.requestModel(),
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
        this.requestModel(),
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
  close(): Promise<void> {
    this.closed = true
    this.closing ??= this.shutdown()
    return this.closing
  }

  private async shutdown(): Promise<void> {
    this.abortBash()
    this.abort(new DOMException('Session closed', 'AbortError'))
    // Let extension commands finish first (commands like /dream wait on the prompt they started)
    await Promise.allSettled(this.commands.values())
    await this.running
    // A cancelled `!` command still records itself; wait for that before the final save
    await this.userBash.running?.catch(() => {})
    await this.registry.waitForIdle().catch(() => {})
    const errors: unknown[] = []
    // Only sessions that fired session_start emit session_shutdown.
    if (this.started) {
      await this.started.catch(() => {})
      try {
        await this.deps.extensions.sessionShutdown(this)
      } catch (error) {
        errors.push(error)
      }
    }
    // A failing shutdown hook must not skip saving or detaching this session.
    try {
      await this.saveOrReport()
    } catch (error) {
      errors.push(error)
    } finally {
      this.store.releaseTransient()
      this.listeners.clear()
      this.deps.onClose(this)
    }
    if (errors.length)
      throw new AggregateError(errors, 'Session shutdown failed')
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

function assertCustomType(customType: unknown): void {
  if (typeof customType !== 'string' || !customType.trim())
    throw new Error('customType must be a non-empty string')
}
