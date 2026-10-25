import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { LanguageModel } from 'ai'
import type { VelaSessionEventListener } from './agent/events.ts'
import type {
  AuthInteraction,
  CredentialStore,
  LoginOptions,
} from './auth/types.ts'
import { ChannelGateway } from './channels/gateway.ts'
import { ExtensionRunner, type LoadedExtension } from './extensions/runner.ts'
import type { VelaExtension } from './extensions/types.ts'
import { resolveLimits, type VelaLimits } from './limits.ts'
import { silentLogger, type VelaLogger } from './logger.ts'
import {
  DEFAULT_THINKING_LEVEL,
  describeModel,
  type LoginProvider,
  type ModelInfo,
  ModelRegistry,
  type ProviderDefinition,
  type ResolvedModel,
  type ThinkingLevel,
} from './models/index.ts'
import { type ContextFile, loadContextFiles } from './prompt/context-files.ts'
import {
  addendum,
  coreRules,
  deferredTools,
  extensionSections,
  projectContext,
  workingDirectory,
} from './prompt/index.ts'
import { PromptPipeline } from './prompt/pipeline.ts'
import {
  expandPromptTemplate,
  loadPromptTemplates,
  type PromptTemplate,
} from './prompt/templates.ts'
import { HookPipeline } from './security/hooks.ts'
import {
  fileSessionStorage,
  memorySessionStorage,
  type SessionStorage,
  type SessionSummary,
} from './session/storage.ts'
import { ToolResultStore } from './session/tool-results.ts'
import { SkillLoader } from './skills/loader.ts'
import { type BinaryResolver, createBinaryResolver } from './tools/binaries.ts'
import { createCoreTools } from './tools/index.ts'
import { ToolRegistry } from './tools/registry.ts'
import { registerToolSearchTool } from './tools/tool-search.ts'
import { type SessionOptions, VelaSession } from './vela-session.ts'

export interface VelaOptions {
  /**
   * Default model: an AI SDK LanguageModel (tests pass faux), or `provider/id` (looked up in `providers`
   * and providers registered by extensions). Core never reads environment variables: the CLI uses the
   * providers from loadConfig(). Without it, a session must call setModel() (or resume a session with a
   * saved model) before it can prompt.
   */
  model?: LanguageModel | string
  /** Model providers (built-in anthropic / openai / openrouter + models.json from loadConfig(), or your own) */
  providers?: Record<string, ProviderDefinition>
  /**
   * Credentials stored by `/login` and `vela.login()`, read by providers per request. Default: in memory only.
   * The CLI passes `loadConfig().credentials` (`~/.vela/auth.json`).
   */
  credentials?: CredentialStore
  /** Thinking level for new sessions, default medium (like pi) */
  thinkingLevel?: ThinkingLevel
  /**
   * Automatic compaction for new sessions, default on (like pi's `compaction.enabled`). Off: the context is never
   * compacted on its own (no microcompaction, no threshold summary, no compact-and-retry on overflow); `compact()` still works.
   */
  autoCompaction?: boolean
  /** Working directory for file, search and bash tools and skills; default process.cwd(). */
  cwd?: string
  /**
   * Project data directory (sessions/, usage/, extension data such as memory/, rag/); relative paths resolve against cwd.
   * Without it nothing persists: sessions stay in memory, long tool output etc. goes to a temp dir deleted by dispose().
   * The CLI uses `~/.vela/projects/<encoded cwd>` (see loadConfig).
   */
  dataDir?: string
  /** Where session history is stored; defaults to `<dataDir>/sessions/*.jsonl` with dataDir, otherwise memory */
  sessionStorage?: SessionStorage
  /**
   * Skill directories or `.md` files (Agent Skills format, see docs/skills.md), in priority order: the first skill
   * with a name wins. Default `<cwd>/.vela/skills`, `<cwd>/.skills`. The model sees each skill's name, description
   * and path and reads the file itself; `/skill:<name> args` sends a skill explicitly.
   */
  skillDirs?: string[]
  /** Prompt template directories or `.md` files (`/<name> args` expands the template); first name wins. Default `<cwd>/.vela/prompts` */
  promptTemplateDirs?: string[]
  /**
   * AGENTS.md / CLAUDE.md files put into the system prompt. Default: found from cwd
   * up to the filesystem root like pi (`loadContextFiles({ cwd })`; the CLI also passes `~/.vela/AGENTS.md`). `false` loads none.
   */
  contextFiles?: false | ContextFile[]
  /** Text appended to the system prompt (pi's `--append-system-prompt`) */
  appendSystemPrompt?: string
  /**
   * A channel session (one shared session per chat) with no new message for this long is closed, so a
   * long-running bot doesn't keep every conversation in memory; the next message reopens and resumes it.
   * Default 10 minutes; 0 closes it right after each reply.
   */
  channelIdleMs?: number
  /** Config section per extension; each extension reads its own section from `vela.config` (by extension name) */
  extensionConfig?: Record<string, Record<string, unknown>>
  /** Retry, compaction threshold and other limits; missing fields use defaults (see src/limits.ts). */
  limits?: Partial<VelaLimits>
  /**
   * Where the grep / find tools keep ripgrep and fd (the CLI uses `~/.vela/bin`). Checked before
   * PATH; a missing program is downloaded here (same as pi). Without it only PATH is searched.
   */
  binDir?: string
  /** Shell the bash tool and `session.executeBash()` run commands with (settings `shellPath`, like pi). Default: bash on PATH */
  shellPath?: string
  /** Don't download ripgrep / fd into `binDir` (the CLI sets this from `VELA_OFFLINE=1`). */
  offline?: boolean
  /** Diagnostic output that is not an event (extensions, hooks, bad session file lines, ...); silent by default. */
  logger?: VelaLogger
  /**
   * Extensions to load, run in order (like pi; the SDK includes no built-in extensions by default).
   * Memory, knowledge base and web tools are extensions too: `[memory(), rag({ embedder }), web({ tavilyKey })]`.
   * Extension config is passed as factory arguments, e.g. `feishu({ appId, appSecret })`.
   */
  extensions?: VelaExtension[]
}

/** Return value of createVela(). */
export interface Vela {
  readonly cwd: string
  readonly dataDir: string
  /** Default model (a name is resolved on first access; throws if none is given or it cannot be resolved) */
  readonly model: LanguageModel
  readonly limits: VelaLimits
  /**
   * Models of the providers that have a credential (`provider/id`, context window, price, ...), used by `/model`
   * and `--list-models`; `{ all: true }` includes providers without one.
   */
  models(options?: { all?: boolean }): ModelInfo[]
  /** Providers `/login` can sign in to, with their current credential source */
  loginProviders(): LoginProvider[]
  /**
   * Signs in to a provider and stores the credential (pi's `/login`): `oauth` runs the provider's sign-in,
   * `api_key` asks for a key through `interaction`. Sessions use the new credential from their next request.
   */
  login(
    provider: string,
    method: 'oauth' | 'api_key',
    interaction: AuthInteraction,
    options?: LoginOptions,
  ): Promise<void>
  /** Removes a provider's stored credential (`/logout`); returns false when none was stored */
  logout(provider: string): Promise<boolean>
  /**
   * Opens a session (or returns it if already open); with file storage the id is the file name in `sessions/<id>.jsonl`.
   * options only apply on first open. Call `await session.resume()` to restore history.
   */
  session(id?: string, options?: SessionOptions): VelaSession
  /** Currently open sessions */
  sessions(): VelaSession[]
  /** Saved sessions (newest first) from SessionStorage.list(); empty if the storage doesn't implement list */
  listSessions(): Promise<SessionSummary[]>
  /** Subscribes to events from all sessions; returns an unsubscribe function */
  subscribe(listener: VelaSessionEventListener): () => void
  /** Waits for all extensions (including async factories) to load; rejects if loading fails */
  ready(): Promise<void>
  /** Loaded extensions and the tools, commands and channels they registered */
  extensions(): LoadedExtension[]
  /** Commands registered by extensions */
  commands(): { name: string; description?: string; extension: string }[]
  /** Channels registered by extensions */
  channels(): { name: string; description: string }[]
  /** Starts all channels (begins receiving messages) */
  startChannels(): Promise<void>
  /**
   * Attempts all cleanup, then rejects with AggregateError if any step failed.
   * Concurrent/repeated calls share the same result; failed cleanup is not retried.
   */
  dispose(): Promise<void>
}

/** Internals used by the CLI and tests; not part of the public API. */
export interface VelaInternals {
  logger: VelaLogger
  registry: ToolRegistry
  hooks: HookPipeline
  builder: PromptPipeline
  skillLoader: SkillLoader
  promptTemplates: PromptTemplate[]
  loadedContextFiles: readonly ContextFile[]
  gateway: ChannelGateway
  /** Finds (or downloads) rg / fd, shared with the grep and find tools */
  resolveBinary: BinaryResolver
}

const internals = new WeakMap<Vela, VelaInternals>()

/** @internal Gets Vela's internals (for CLI commands and tests). */
export function velaInternals(vela: Vela): VelaInternals {
  const found = internals.get(vela)
  if (!found) throw new Error('Not a Vela created by createVela()')
  return found
}

/**
 * Assembles a Vela: core tools (files, search, bash), hooks, prompt, skills, extensions and channels.
 * Conversations are opened with `vela.session(id)`; one Vela can have several sessions open at once.
 * They share tools and extensions, and each has its own message history, compaction, usage and run lock.
 */
export function createVela(options: VelaOptions = {}): Vela {
  const cwd = resolve(options.cwd ?? process.cwd())
  // Without dataDir, use a temp dir (long tool output, tool history, extension data) deleted on dispose
  const ephemeral = options.dataDir === undefined
  const dataDir = ephemeral
    ? mkdtempSync(join(tmpdir(), 'vela-'))
    : resolve(cwd, options.dataDir as string)
  const sessionStorage =
    options.sessionStorage ??
    (ephemeral
      ? memorySessionStorage()
      : fileSessionStorage(join(dataDir, 'sessions'), options.logger))
  const { model } = options
  const models = new ModelRegistry(options.providers, options.credentials)
  const resolveModel = (
    requested: string | LanguageModel | undefined,
    from?: VelaSession,
  ): ResolvedModel => {
    // Like pi: without a chosen model, the first provider with a credential supplies its default model
    const choice = requested ?? models.defaultRef()
    if (choice === undefined)
      throw new Error(
        'No model selected: pass model to createVela(), or call session.setModel()',
      )
    return typeof choice === 'string'
      ? models.resolve(choice, { channel: () => from?.channel })
      : { model: choice, info: describeModel(choice) }
  }
  const limits = resolveLimits(options.limits)
  // setTimeout fires at once for a delay above 2^31 - 1 ms (or Infinity): every channel session would close
  // right after its reply instead of staying open
  const { channelIdleMs } = options
  if (
    channelIdleMs !== undefined &&
    !(
      Number.isInteger(channelIdleMs) &&
      channelIdleMs >= 0 &&
      channelIdleMs <= 2 ** 31 - 1
    )
  )
    throw new Error(
      `channelIdleMs must be a whole number of milliseconds from 0 to ${2 ** 31 - 1}; got ${channelIdleMs}`,
    )
  const logger = options.logger ?? silentLogger
  const sessionCwds = new WeakMap<ToolRegistry, string>()

  // The Vela-level registry only holds shared tool definitions; tools run in each session's forked registry.
  // Its own results dir starts with `.`, so it never collides with a session id.
  const registry = new ToolRegistry(
    new ToolResultStore(join(dataDir, 'sessions', '.shared', 'tool-results')),
  )
  registry.setLogger(logger)
  const resolveBinary = createBinaryResolver({
    binDir: options.binDir,
    offline: options.offline,
    logger,
  })
  registry.register(
    ...createCoreTools({
      cwd,
      shellPath: options.shellPath,
      resolveBinary,
      resolveCwd: (context) =>
        (context?.registry && sessionCwds.get(context.registry)) ?? cwd,
    }),
  )

  const hooks = new HookPipeline(logger)
  registry.setHookPipeline(hooks)
  registerToolSearchTool(registry)

  const skillLoader = new SkillLoader(
    options.skillDirs ?? [join(cwd, '.vela', 'skills'), join(cwd, '.skills')],
  )
  skillLoader.load()
  const templates = loadPromptTemplates(
    options.promptTemplateDirs ?? [join(cwd, '.vela', 'prompts')],
  )
  for (const { message, path } of [
    ...skillLoader.diagnostics,
    ...templates.diagnostics,
  ])
    logger.warn(`[resources] ${path}: ${message}`)
  const promptTemplates = templates.templates
  const contextFiles =
    options.contextFiles === false
      ? []
      : (options.contextFiles ?? loadContextFiles({ cwd }))
  const sessions = new Map<string, VelaSession>()
  const sessionContextFiles = new Map<string, readonly ContextFile[]>()

  // Same order as pi: intro + rules, addendum, project context, skills, cwd, then extension sections
  const builder = new PromptPipeline()
    .pipe('coreRules', coreRules())
    .pipe('deferredTools', deferredTools())
    .pipe('appendSystemPrompt', addendum(options.appendSystemPrompt))
    .pipe('projectContext', (ctx) =>
      projectContext(sessionContextFiles.get(ctx.sessionId) ?? contextFiles)(
        ctx,
      ),
    )
    .pipe('skills', (ctx) =>
      skillLoader.buildPromptSection(ctx.activeTools ?? []),
    )
    .pipe('cwd', (ctx) =>
      workingDirectory(sessions.get(ctx.sessionId)?.cwd ?? cwd)(ctx),
    )
    .pipe('extensions', extensionSections())

  const listeners = new Set<VelaSessionEventListener>()
  let disposed = false
  /** The one dispose in progress: a second caller (a signal racing the CLI's exit) waits for it to finish */
  let disposing: Promise<void> | undefined

  const session = (
    id = 'default',
    sessionOptions?: SessionOptions,
  ): VelaSession => {
    if (disposed) throw new Error('Vela has been disposed')
    const existing = sessions.get(id)
    if (existing) return existing
    const created: VelaSession = new VelaSession(
      id,
      {
        model,
        resolveModel,
        thinkingLevel: options.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
        autoCompaction: options.autoCompaction ?? true,
        openSession: (newId, newOptions) => {
          if (sessions.has(newId))
            throw new Error(`Session ${newId} is already open`)
          return session(newId, newOptions)
        },
        limitOverrides: options.limits ?? {},
        logger,
        dataDir,
        temporaryDataDir: ephemeral,
        sessionStorage,
        cwd,
        shellPath: options.shellPath,
        registry,
        builder,
        // `/skill:<name> args`, then `/<template> args` (like pi; extension commands are tried first)
        expandInput: (text) =>
          skillLoader.expand(text) ??
          expandPromptTemplate(text, promptTemplates) ??
          text,
        extensions: runner,
        forward: (event, sessionId) => {
          for (const listener of listeners) listener(event, sessionId)
          const source = sessions.get(sessionId)
          if (source) runner.notify(event, source)
        },
        onSaved: (id) => gateway.sessionSaved(id),
        onClose: (closed) => {
          if (sessions.get(closed.id) === closed) {
            sessions.delete(closed.id)
            sessionContextFiles.delete(closed.id)
          }
        },
      },
      sessionOptions,
    )
    if (created.cwd !== cwd && options.contextFiles !== false)
      sessionContextFiles.set(id, loadContextFiles({ cwd: created.cwd }))
    sessions.set(id, created)
    sessionCwds.set(created.registry, created.cwd)
    return created
  }

  const gateway: ChannelGateway = new ChannelGateway({
    dataDir,
    session,
    find: (id) => sessions.get(id),
    idleMs: channelIdleMs,
    logger,
  })
  const runner: ExtensionRunner = new ExtensionRunner(
    {
      cwd,
      dataDir,
      extensionConfig: options.extensionConfig ?? {},
      logger,
      registry,
      models,
      hooks,
      gateway,
      session: (id) => sessions.get(id),
    },
    options.extensions ?? [],
  )
  // Audit runs after extensions' tool_call, so it records the path actually written after extensions modify it
  hooks.registerPre('audit-log', (toolName, input, context) => {
    if (toolName === 'write_file' || toolName === 'edit_file') {
      const path = (input as { path?: string } | null)?.path || 'unknown'
      context.emit({ type: 'audit', toolName, path })
    }
    return { action: 'allow' }
  })

  let defaultModel: LanguageModel | undefined
  const vela: Vela = {
    cwd,
    dataDir,
    get model() {
      defaultModel ??= resolveModel(model).model
      return defaultModel
    },
    limits,
    models: (opts) => (opts?.all ? models.list() : models.available()),
    loginProviders: () => models.loginProviders(),
    login: (provider, method, interaction, loginOptions) =>
      models.login(provider, method, interaction, loginOptions),
    logout: (provider) => models.logout(provider),
    session,
    sessions: () => [...sessions.values()],
    listSessions: async () => (await sessionStorage.list?.()) ?? [],
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ready: () => runner.ready,
    extensions: () => runner.loaded(),
    commands: () => runner.commands(),
    channels: () => gateway.list(),
    startChannels: async () => {
      await runner.ready
      await gateway.startAll(registry.getAllTools().map((tool) => tool.name))
    },
    dispose() {
      disposed = true
      disposing ??= (async () => {
        // A factory may still be registering resources. Initialization failures remain on ready().
        await runner.settled
        const errors: unknown[] = []
        try {
          await gateway.stopAll()
        } catch (error) {
          errors.push(error)
        }
        // Do not tear down shared dependencies until every session-close attempt settles.
        // Defer each call so a synchronous close() throw becomes a rejection, not an interrupted map.
        const closed = await Promise.allSettled(
          [...sessions.values()].map((s) =>
            Promise.resolve().then(() => s.close()),
          ),
        )
        for (const result of closed)
          if (result.status === 'rejected') errors.push(result.reason)
        try {
          await runner.shutdown()
        } catch (error) {
          errors.push(error)
        }
        listeners.clear()
        if (ephemeral) {
          try {
            rmSync(dataDir, { recursive: true, force: true })
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length)
          throw new AggregateError(errors, 'Vela disposal failed')
      })()
      return disposing
    },
  }
  internals.set(vela, {
    logger,
    registry,
    hooks,
    builder,
    skillLoader,
    promptTemplates,
    loadedContextFiles: contextFiles,
    gateway,
    resolveBinary,
  })
  return vela
}
