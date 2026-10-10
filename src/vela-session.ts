import { join } from 'node:path'
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { LanguageModel, ModelMessage } from 'ai'
import type {
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
import { withProviderHooks } from './extensions/provider-hooks.ts'
import type {
  CustomMessage,
  ExtensionEventName,
  ExtensionUI,
  InputSource,
  ProviderStreamEvent,
  SendMessageOptions,
  SessionUI,
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
import type { NestedToolCalls, SessionEntry } from './session/entries.ts'
import { SessionStore } from './session/index.ts'
import { NestedCallLog } from './session/nested-calls.ts'
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
  /** Where the input came from, passed to `input` handlers (default `sdk`) */
  source?: InputSource
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
  ): Promise<{ sections: Record<string, string>; messages: CustomMessage[] }>
  runCommand(
    session: VelaSession,
    text: string,
    signal: AbortSignal,
  ): Promise<boolean>
  hasHandlers(event: ExtensionEventName): boolean
  /** Text after the input handlers; undefined when a handler handled it */
  input(
    session: VelaSession,
    text: string,
    source: InputSource,
    streamingBehavior?: 'steer' | 'followUp',
  ): Promise<string | undefined>
  transformContext(
    session: VelaSession,
    messages: ModelMessage[],
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
  private closed = false
  private started?: Promise<void>
  private running?: Promise<void>
  /** Extension sections collected by this turn's before_agent_start */
  private sections: Record<string, string> = {}
  private readonly steeringQueue: ModelMessage[] = []
  private readonly followUpQueue: ModelMessage[] = []
  /** Extensions' custom messages in the history or queues, and what they carry (pi's custom message fields) */
  private readonly customMessages = new WeakMap<
    ModelMessage,
    CustomMessageInfo
  >()
  /** Custom messages sent while running without triggering a turn: appended once the step's tool results are in (like pi) */
  private readonly pendingCustom: ModelMessage[] = []
  /** Custom messages for the next prompt (`deliverAs: 'nextTurn'`) */
  private readonly nextTurnMessages: ModelMessage[] = []
  /** How steer messages are taken (default one-at-a-time, like pi) */
  steeringMode: QueueMode = 'one-at-a-time'
  /** How followUp messages are taken (default one-at-a-time, like pi) */
  followUpMode: QueueMode = 'one-at-a-time'

  /** @internal Created by vela.session() */
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
    this.hooked = undefined
    const limits = limitsForModel(resolved.info, this.deps.limitOverrides)
    Object.assign(this.limits, limits)
    Object.assign(this.contextManager.limits, limits)
    this.tracker.contextWindow = resolved.info.contextWindow ?? CONTEXT_WINDOW
    // Price follows the current model (not keyed by modelId: same-named models from different providers cost differently)
    this.tracker.setPricing(resolved.info.cost)
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
  readonly emit = (raw: VelaEvent): void => {
    let event = raw
    if (
      (event.type === 'message_start' || event.type === 'message_end') &&
      !event.custom
    ) {
      const custom = this.customMessages.get(event.message)
      if (custom) event = { ...event, custom }
    }
    this.nestedCalls.observe(event)
    for (const listener of this.listeners) listener(event)
    this.deps.forward(event, this.id)
    // Like pi: the step's assistant and tool messages are in the history now, so a custom message cannot land
    // between a tool call and its result
    if (event.type === 'turn_end') this.flushPendingCustom()
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

  /** Restores history from session storage (replacing the in-memory history); returns whether a saved session was found. Not allowed while running. */
  async resume(): Promise<boolean> {
    if (this.busy.locked)
      throw new Error(`Session ${this.id} is running; cannot restore history`)
    // Entries not yet written would be replaced by the loaded ones
    await this.store.flush()
    const saved = await this.store.loadSaved()
    if (!saved) return false
    this.contextManager.restore(saved)
    for (const [message, info] of saved.custom)
      this.customMessages.set(message, info)
    this.displayName = saved.name
    if (saved.thinkingLevel && THINKING_LEVELS.includes(saved.thinkingLevel))
      this.thinking = saved.thinkingLevel
    if (saved.model) {
      // Providers registered by extensions resolve only after extensions load
      await this.deps.extensions.ready.catch(() => {})
      try {
        this.selectModel(saved.model, false)
      } catch (error) {
        this.deps.logger.warn(
          `[session] Saved model ${saved.model} for ${this.id} is unavailable, keeping the current model: ${error instanceof Error ? error.message : error}`,
        )
      }
    }
    this.tracker.setEstimatedTokens(estimateMessageTokens(this.messages))
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
    const custom = this.customMessages.get(message)
    if (custom && message.role === 'user') {
      this.store.appendCustomMessage(message, custom)
      return
    }
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
   * Other input goes through the extensions' `input` handlers first (like pi); a handled input resolves without running.
   */
  prompt(input: string, options: PromptOptions = {}): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error(`Session ${this.id} is closed`))
    if (input.startsWith('/'))
      return (async () => {
        await this.start()
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
    const next = (text: string) =>
      expand
        ? this.promptExpanded(text, options)
        : this.promptModel(text, options)
    if (!this.deps.extensions.hasHandlers('input')) return next(input)
    return (async () => {
      await this.start()
      const text = await this.deps.extensions.input(
        this,
        input,
        options.source ?? 'sdk',
        this.prompting ? options.streamingBehavior : undefined,
      )
      if (text === undefined) return
      return next(text)
    })()
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
  steer(input: string, options: { source?: InputSource } = {}): Promise<void> {
    return this.promptInput(input, { ...options, streamingBehavior: 'steer' })
  }

  /** While running: runs as a user message when the model would otherwise stop (no tool calls, no steer). Same as prompt() when idle. */
  followUp(
    input: string,
    options: { source?: InputSource } = {},
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
      this.nextTurnMessages.push(entry)
      return
    }
    if (this.prompting && options.triggerTurn !== false) {
      ;(options.deliverAs === 'followUp'
        ? this.followUpQueue
        : this.steeringQueue
      ).push(entry)
      this.emitQueue()
      return
    }
    if (options.triggerTurn) return this.promptMessage(entry, {})
    if (this.busy.locked) {
      this.pendingCustom.push(entry)
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
    text: string,
    options: { deliverAs?: 'steer' | 'followUp' } = {},
  ): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error(`Session ${this.id} is closed`))
    return this.promptInput(
      text,
      {
        source: 'extension',
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
    return this.customMessages.get(message)
  }

  /** Builds the user message a custom message becomes and remembers its fields. */
  private customMessage(message: CustomMessage): ModelMessage {
    assertCustomType(message.customType)
    if (typeof message.content !== 'string' && !Array.isArray(message.content))
      throw new Error('A custom message needs content (a string or parts)')
    const entry: ModelMessage = { role: 'user', content: message.content }
    this.customMessages.set(entry, {
      customType: message.customType,
      display: message.display === true,
      ...(message.details === undefined ? {} : { details: message.details }),
    })
    return entry
  }

  private flushPendingCustom(): void {
    for (const message of this.pendingCustom.splice(0)) this.append(message)
  }

  /** Clears queued messages and returns the user inputs among them (the TUI puts them back in the input box before aborting). */
  clearQueue(): { steering: string[]; followUp: string[] } {
    const steering = this.steeringQueue.splice(0)
    const followUp = this.followUpQueue.splice(0)
    if (steering.length || followUp.length) this.emitQueue()
    return {
      steering: this.inputTexts(steering),
      followUp: this.inputTexts(followUp),
    }
  }

  /** Currently queued user inputs (a copy; queued custom messages are not listed) */
  get queue(): { steering: string[]; followUp: string[] } {
    return {
      steering: this.inputTexts(this.steeringQueue),
      followUp: this.inputTexts(this.followUpQueue),
    }
  }

  private inputTexts(messages: ModelMessage[]): string[] {
    return messages
      .filter((message) => !this.customMessages.has(message))
      .map(messageText)
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
  private dequeue(kind: 'steering' | 'followUp'): ModelMessage[] {
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
    return this.promptMessage({ role: 'user', content: input }, options)
  }

  private promptMessage(
    message: ModelMessage,
    options: PromptOptions,
  ): Promise<void> {
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
      ).push(message)
      this.emitQueue()
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
      if (!saved) await this.saveOrReport()
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
    // Fail here if the model doesn't support the current thinking level, before sending a request or writing history
    const reasoning = reasoningOption(this.thinking, info)
    const input = inputs.map(messageText).join('\n\n')
    const started = await this.deps.extensions.beforeAgentStart(this, input)
    this.sections = started.sections
    // Appending to a saved session that was not resumed would mix two conversations in one log
    await this.store.assertNew()
    this.flushPendingCustom()
    this.emit({ type: 'agent_start', input })
    const newMessages: ModelMessage[] = []
    for (const message of [
      ...inputs,
      ...this.nextTurnMessages.splice(0),
      ...started.messages.map((message) => this.customMessage(message)),
    ]) {
      this.append(message)
      newMessages.push(message)
    }
    await agentLoop({
      model: this.requestModel(),
      reasoning,
      systemPrompt: () => this.buildSystem(),
      toolRegistry: this.registry,
      messages: this.messages,
      tokenTracker: this.tracker,
      prepareContext: (request) => this.prepareContext(request),
      transformContext: this.deps.extensions.hasHandlers('context')
        ? (messages) => this.deps.extensions.transformContext(this, messages)
        : undefined,
      compactOnOverflow: (overflowSignal) =>
        this.compactForOverflow(overflowSignal),
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
    if (this.closed) throw new Error(`Session ${this.id} is closed`)
    if (this.busy.locked)
      throw new Error('A task is already running; compact after it finishes')
    const busy = this.busy
    busy.locked = true
    const controller = new AbortController()
    busy.controller = controller
    const run = (async () => {
      await this.start()
      const request = await createRequestSnapshot(
        this.requestModel(),
        this.buildSystem(),
        this.registry.toAISDKFormat(),
        this.messages,
        controller.signal,
      )
      // Like pi: say so plainly when there is no earlier turn to summarize
      if (!canSummarize(request.messages))
        throw new Error('Nothing to compact (session too small)')
      await this.contextManager.compact(request, focus)
      await this.saveOrReport()
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
      this.flushPendingCustom()
    }
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

/** Text of a user message (its text parts joined). */
function messageText(message: ModelMessage): string {
  const { content } = message
  if (typeof content === 'string') return content
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

function assertCustomType(customType: unknown): void {
  if (typeof customType !== 'string' || !customType.trim())
    throw new Error('customType must be a non-empty string')
}
