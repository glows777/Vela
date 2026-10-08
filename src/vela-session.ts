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
  /** Where session history is stored (file / memory / custom) */
  sessionStorage: SessionStorage
  /** dataDir is a temp dir that dispose() deletes (no dataDir given): tool history may be gone on resume */
  temporaryDataDir?: boolean
  /** Vela-level tool registry; each session forks its own from it */
  registry: ToolRegistry
  builder: PromptPipeline
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
  /** @internal */
  readonly activeSkills = new Set<string>()
  /** @internal Run lock: held while any agent loop (prompt, skill, dream, defend, ingest) runs */
  readonly busy: { locked: boolean; controller?: AbortController } = {
    locked: false,
  }
  /** @internal UI for extensions */
  readonly ui: ExtensionUI
  /** @internal Whether there is a real UI */
  readonly hasUI: boolean

  private readonly listeners = new Set<VelaEventListener>()
  private readonly builder: PromptPipeline
  private readonly deps: SessionDeps
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

  /** Session display name (like pi's session name); saved with the session and shown in the session list. */
  get name(): string | undefined {
    return this.displayName
  }

  /** Sets the display name (empty string clears it); written on the next save. Call `await save()` to write it now. */
  setName(name: string | undefined): void {
    this.displayName = name?.trim() || undefined
  }

  /** Selected model (name or object); resolution is deferred until first use (providers registered by extensions may not be loaded yet) */
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
   * current model if the name cannot be resolved. A model chosen by name is saved with the session.
   */
  setModel(model: string | LanguageModel): void {
    const resolved = this.deps.resolveModel(model)
    this.modelChoice = model
    this.applyModel(resolved)
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
      throw new Error(`Thinking level must be one of ${THINKING_LEVELS.join(' / ')}`)
    this.thinking = level
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
      activeSkills: this.activeSkills,
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

  /** @internal Writes the current history to storage. */
  save(): Promise<void> {
    return this.contextManager.save()
  }

  /** Restores history from session storage (replacing the in-memory history); returns whether a saved session was found. Not allowed while running. */
  async resume(): Promise<boolean> {
    if (this.busy.locked)
      throw new Error(`Session ${this.id} is running; cannot restore history`)
    const saved = await this.store.loadSaved()
    if (!saved) return false
    this.contextManager.restore(saved)
    if (saved.name) this.displayName = saved.name
    // Older checkpoints lack this field: keep the current level
    if (saved.thinkingLevel && THINKING_LEVELS.includes(saved.thinkingLevel))
      this.thinking = saved.thinkingLevel
    if (saved.model) {
      // Providers registered by extensions resolve only after extensions load
      await this.deps.extensions.ready.catch(() => {})
      try {
        this.setModel(saved.model)
      } catch (error) {
        this.deps.logger.warn(
          `[session] Saved model ${saved.model} for ${this.id} is unavailable, keeping the current model: ${error instanceof Error ? error.message : error}`,
        )
      }
    }
    this.tracker.setEstimatedTokens(estimateMessageTokens(this.messages))
    return true
  }

  /** Appends a message to history (without calling the model). */
  append(message: ModelMessage): void {
    this.messages.push(message)
    this.tracker.addMessage(message)
    this.timestamps.set(message, Date.now())
    this.emit({ type: 'message', message })
  }

  /**
   * Appends a user message and runs the agent loop to completion (no turn limit, like pi), then saves the session.
   * steer / followUp messages queued during the run also finish before it resolves (`agent_settled` is emitted last).
   * If the loop fails, queued messages still run, then it rejects.
   * While running, pass `streamingBehavior` (or use steer() / followUp()); it then resolves right after enqueueing.
   * In owner sessions, `/name args` matching an extension command runs the command instead of going to the model (immediately, even while running).
   */
  prompt(input: string, options: PromptOptions = {}): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`Session ${this.id} is closed`))
    if (input.startsWith('/'))
      return (async () => {
        await this.start()
        if (await this.runCommand(input, options.signal)) return
        return this.promptModel(input, options)
      })()
    return this.promptModel(input, options)
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
    return this.promptModel(input, { streamingBehavior: 'steer' })
  }

  /** While running: runs as a user message when the model would otherwise stop (no tool calls, no steer). Same as prompt() when idle. */
  followUp(input: string): Promise<void> {
    return this.promptModel(input, { streamingBehavior: 'followUp' })
  }

  /** Clears queued messages and returns them (the TUI puts them back in the input box before aborting). */
  clearQueue(): { steering: string[]; followUp: string[] } {
    const cleared = {
      steering: this.steeringQueue.splice(0),
      followUp: this.followUpQueue.splice(0),
    }
    if (cleared.steering.length || cleared.followUp.length)
      this.emitQueue()
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
    if (this.closed) return Promise.reject(new Error(`Session ${this.id} is closed`))
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
   * Compacts the context manually (like pi's compact): replaces earlier history with a summary, keeps recent
   * messages, then saves. `focus` is what the summary should prefer to keep (pi's customInstructions).
   * Throws while the session is running; can be interrupted by abort().
   */
  async compact(focus?: string): Promise<void> {
    if (this.closed) throw new Error(`Session ${this.id} is closed`)
    if (this.busy.locked) throw new Error('A task is already running; compact after it finishes')
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
   * Aborts the current agent loop and extension commands (if any) and waits until the agent loop actually stops
   * (like pi's `await abort()`). Queued messages stay in the queue; call clearQueue() first if needed.
   */
  async abort(
    reason: unknown = new DOMException('User cancelled the current operation', 'AbortError'),
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
