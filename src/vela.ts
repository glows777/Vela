import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { LanguageModel } from 'ai'
import type { VelaSessionEventListener } from './agent/events.ts'
import { ChannelGateway } from './channels/gateway.ts'
import { ExtensionRunner, type LoadedExtension } from './extensions/runner.ts'
import type { VelaExtension } from './extensions/types.ts'
import { resolveLimits, type VelaLimits } from './limits.ts'
import { silentLogger, type VelaLogger } from './logger.ts'
import {
  coreRules,
  deferredTools,
  extensionSections,
  toolHistoryGuide,
} from './prompt/index.ts'
import { PromptPipeline } from './prompt/pipeline.ts'
import { HookPipeline } from './security/hooks.ts'
import {
  fileSessionStorage,
  memorySessionStorage,
  type SessionStorage,
  type SessionSummary,
} from './session/storage.ts'
import { ToolResultStore } from './session/tool-results.ts'
import { SkillLoader } from './skills/loader.ts'
import { createBinaryResolver } from './tools/binaries.ts'
import { createCoreTools } from './tools/index.ts'
import { ToolRegistry } from './tools/registry.ts'
import {
  DEFAULT_THINKING_LEVEL,
  describeModel,
  type ModelInfo,
  ModelRegistry,
  type ProviderDefinition,
  type ResolvedModel,
  type ThinkingLevel,
} from './models/index.ts'
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
  /** Model providers (built-in openai / anthropic + models.json from loadConfig(), or your own) */
  providers?: Record<string, ProviderDefinition>
  /** Thinking level for new sessions, default medium (like pi) */
  thinkingLevel?: ThinkingLevel
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
  /** Skill directories (one `SKILL.md` per subdirectory); later skills override earlier ones with the same name. Default `<cwd>/.skills`, `<cwd>/.vela/skills` */
  skillDirs?: string[]
  /** Config section per extension; each extension reads its own section from `vela.config` (by extension name) */
  extensionConfig?: Record<string, Record<string, unknown>>
  /** Retry, compaction threshold and other limits; missing fields use defaults (see src/limits.ts). */
  limits?: Partial<VelaLimits>
  /**
   * Where the grep / find tools keep ripgrep and fd (the CLI uses `~/.vela/bin`). Checked before
   * PATH; a missing program is downloaded here (same as pi). Without it only PATH is searched.
   */
  binDir?: string
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
  /** Models listed by providers (`provider/id`, context window, price, ...), used by `/model` */
  models(): ModelInfo[]
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
  /** Stops channels and closes all sessions (aborting running tasks and saving) */
  dispose(): Promise<void>
}

/** Internals used by the CLI and tests; not part of the public API. */
export interface VelaInternals {
  logger: VelaLogger
  registry: ToolRegistry
  hooks: HookPipeline
  builder: PromptPipeline
  skillLoader: SkillLoader
  gateway: ChannelGateway
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
 * They share tools and extensions, and each has its own message history, compaction, usage, role and run lock.
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
  const models = new ModelRegistry(options.providers)
  const resolveModel = (
    choice: string | LanguageModel | undefined,
  ): ResolvedModel => {
    if (choice === undefined)
      throw new Error('No model selected: pass model to createVela(), or call session.setModel()')
    return typeof choice === 'string'
      ? models.resolve(choice)
      : { model: choice, info: describeModel(choice) }
  }
  const limits = resolveLimits(options.limits)
  const logger = options.logger ?? silentLogger

  // The Vela-level registry only holds shared tool definitions; tools run in each session's forked registry.
  // Its own results dir starts with `.`, so it never collides with a session id.
  const registry = new ToolRegistry(
    new ToolResultStore(join(dataDir, 'sessions', '.shared', 'tool-results')),
  )
  registry.setLogger(logger)
  registry.register(
    ...createCoreTools({
      cwd,
      bashTimeoutMs: limits.bashTimeoutMs,
      resolveBinary: createBinaryResolver({
        binDir: options.binDir,
        offline: options.offline,
        logger,
      }),
    }),
  )

  const hooks = new HookPipeline(logger)
  hooks.registerPost('bash-timestamp', (toolName, _input, output) => {
    if (toolName === 'bash') {
      return {
        action: 'modify',
        modifiedOutput: `[${new Date().toISOString()}]\n${output}`,
      }
    }
    return { action: 'allow' }
  })
  registry.setHookPipeline(hooks)
  registerToolSearchTool(registry)

  const skillLoader = new SkillLoader(
    options.skillDirs ?? [join(cwd, '.skills'), join(cwd, '.vela', 'skills')],
  )
  skillLoader.load()

  const builder = new PromptPipeline()
    .pipe('coreRules', coreRules(cwd))
    .pipe('toolHistoryGuide', toolHistoryGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('extensions', extensionSections())
    .pipe('skillContext', (ctx) =>
      skillLoader.buildPromptSection(ctx.activeSkills ?? new Set()),
    )

  const listeners = new Set<VelaSessionEventListener>()
  const sessions = new Map<string, VelaSession>()
  let disposed = false

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
        limitOverrides: options.limits ?? {},
        logger,
        dataDir,
        temporaryDataDir: ephemeral,
        sessionStorage,
        registry,
        builder,
        extensions: {
          ready: runner.ready,
          sessionStart: (s) => runner.sessionStart(s),
          sessionShutdown: (s) => runner.sessionShutdown(s),
          beforeAgentStart: (s, prompt) => runner.beforeAgentStart(s, prompt),
          runCommand: (s, text, signal) => runner.runCommand(s, text, signal),
        },
        forward: (event, sessionId) => {
          for (const listener of listeners) listener(event, sessionId)
          const source = sessions.get(sessionId)
          if (source) runner.notify(event, source)
        },
        onClose: (closed) => {
          if (sessions.get(closed.id) === closed) sessions.delete(closed.id)
        },
      },
      sessionOptions,
    )
    sessions.set(id, created)
    return created
  }

  const gateway: ChannelGateway = new ChannelGateway({ session, logger })
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
    models: () => models.list(),
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
    startChannels: () => gateway.startAll(),
    async dispose() {
      if (disposed) return
      disposed = true
      await gateway.stopAll()
      await Promise.all([...sessions.values()].map((s) => s.close()))
      listeners.clear()
      if (ephemeral) rmSync(dataDir, { recursive: true, force: true })
    },
  }
  internals.set(vela, {
    logger,
    registry,
    hooks,
    builder,
    skillLoader,
    gateway,
  })
  return vela
}
