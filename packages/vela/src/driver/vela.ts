import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  AuthInteraction,
  CredentialStore,
  LoginOptions,
} from '../providers/auth/types.ts'
import {
  DEFAULT_THINKING_LEVEL,
  describeModel,
  type LoginProvider,
  type ModelInfo,
  ModelRegistry,
  type ProviderDefinition,
  type ResolvedModel,
  type ThinkingLevel,
} from '../providers/models/index.ts'
import { resolveLimits, type VelaLimits } from '../shared/limits.ts'
import { silentLogger, type VelaLogger } from '../shared/logger.ts'
import type { ModelInput } from '../shared/provider-types.ts'
import type { VelaSessionEventListener } from './agent/events.ts'
import type { ConfigResourceSplit } from './config/runtime-resources.ts'
import {
  createLocalExecutionEnv,
  createSessionLocalExecutionEnv,
  scopeLocalResults,
} from './execution/local.ts'
import { abortable, sameLocation } from './execution/location.ts'
import type { ExecutionEnv, ExecutionLocation } from './execution/types.ts'
import { auditLog } from './extensions/audit.ts'
import { ExtensionRunner, type LoadedExtension } from './extensions/runner.ts'
import type { VelaExtension } from './extensions/types.ts'
import type { ContextFile } from './prompt/context-files.ts'
import type { DocsPaths, SystemPromptBuilder } from './prompt/index.ts'
import {
  expandPromptTemplate,
  loadPromptTemplates,
  type PromptTemplate,
} from './prompt/templates.ts'
import { setSavedSessionArchived } from './session/index.ts'
import type { SessionOptions } from './session/options.ts'
import { assertSessionId } from './session/options.ts'
import { ProjectConfig } from './session/project-config.ts'
import { ProjectExtensions } from './session/project-extensions.ts'
import { createSessionPrompt } from './session/prompt-builder.ts'
import { WorkspaceResources } from './session/resources.ts'
import { applySessionRouting } from './session/routing.ts'
import { type SessionSearchHit, searchSessionText } from './session/search.ts'
import {
  fileSessionStorage,
  memorySessionStorage,
  type SessionStorage,
  type SessionSummary,
} from './session/storage.ts'
import { ToolResultStore } from './session/tool-results.ts'
import { loadWorkspaceInventory, workspaceKey } from './session/workspace.ts'
import { expandEnvironmentSkill } from './skills/environment-skills.ts'
import { SkillLoader } from './skills/loader.ts'
import { type BinaryResolver, createBinaryResolver } from './tools/binaries.ts'
import { createCoreTools } from './tools/index.ts'
import { ToolRegistry } from './tools/registry.ts'
import { registerToolSearchTool } from './tools/tool-search.ts'
import { VelaSession } from './vela-session.ts'

export interface VelaOptions {
  /** @internal Host/workspace resource split from the frontend configuration. */
  sessionResources?: ConfigResourceSplit
  /** Resolve the execution environment for a session tool call. */
  env?: (target: {
    sessionId: string
    location: ExecutionLocation
  }) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>
  /** Observes real nonempty storage writes, including writes outside prompts. */
  onSessionSaved?: (sessionId: string) => void
  /** Stops external ingress after factories settle and before sessions close. */
  beforeDispose?: () => void | Promise<void>
  /**
   * Default model: an AI SDK LanguageModel (tests pass faux), or `provider/id` (looked up in `providers`
   * and providers registered by extensions). Core never reads environment variables: the CLI uses the
   * providers from loadConfig(). Without it, a session must call setModel() (or resume a session with a
   * saved model) before it can prompt.
   */
  model?: ModelInput
  /** Model providers (built-in anthropic / openai / openrouter / deepseek + models.json from loadConfig(), or your own) */
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
   * compacted on its own (no threshold summary, no compact-and-retry on overflow); `compact()` still works.
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
  /** Where session history is stored; defaults to `<dataDir>/sessions/<id>/transcript.jsonl` with dataDir, otherwise memory */
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
   * Replaces the default system prompt (pi's `--system-prompt` / `SYSTEM.md`): this text becomes the intro and
   * the tool list, rules and docs sections are left out. Addendum, project context, skills, cwd, env and
   * extension sections stay. `--append-system-prompt` still applies on top.
   */
  systemPrompt?: string
  /**
   * Where Vela's own README, docs and examples live, for the `<docs>` section: the CLI and the SDK umbrella point
   * at their package. Only folders that exist are used; without a docs folder the section stays off. `false` for none.
   */
  docs?: DocsPaths | false
  /** Config section per extension; each extension reads its own section from `vela.config` (by extension name) */
  extensionConfig?: Record<string, Record<string, unknown>>
  /** Retry, compaction threshold and other limits; missing fields use defaults (see src/limits.ts). */
  limits?: Partial<VelaLimits>
  /**
   * Where the grep / find tools keep ripgrep and fd (the CLI uses `~/.vela/bin`). Checked before
   * PATH; a missing program is downloaded here (same as pi). Without it only PATH is searched.
   */
  binDir?: string
  /** Shell the bash tool and `session.executeBash()` run commands with. Default: bash on PATH, or bash.exe on Windows. */
  shellPath?: string
  /** Don't download ripgrep / fd into `binDir` (the CLI sets this from `VELA_OFFLINE=1`). */
  offline?: boolean
  /** Diagnostic output that is not an event (extensions, hooks, bad session file lines, ...); silent by default. */
  logger?: VelaLogger
  /**
   * Extensions to load, run in order (like pi; the SDK includes no built-in extensions by default).
   * Memory, knowledge base and web tools are extensions too: `[memory(), rag({ embedder }), web({ tavilyKey })]`.
   * Extension config is passed as factory arguments, e.g. `lark({ appId, appSecret })`.
   */
  extensions?: VelaExtension[]
}

/** Which saved sessions a listing or search covers. */
export interface SavedSessionOptions {
  /** Also cover sessions archived with `setSessionArchived()` (default false) */
  includeArchived?: boolean
}

/** Return value of createVela(). */
export interface Vela {
  readonly cwd: string
  readonly dataDir: string
  /** Default model (a name is resolved on first access; throws if none is given or it cannot be resolved) */
  readonly model: ModelInput
  readonly limits: VelaLimits
  /**
   * Models of the providers that have a credential (`provider/id`, context window, price, ...), used by `/model`
   * and `--list-models`; `{ all: true }` includes providers without one.
   */
  models(options?: { all?: boolean }): ModelInfo[]
  /** Update a configured provider for subsequent model selections. */
  configureProvider(name: string, provider: ProviderDefinition): void
  /** Set defaults for subsequently created sessions, without changing open sessions. */
  setDefaults(model: ModelInput, thinkingLevel: ThinkingLevel): void
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
  /**
   * Removes a provider's stored credential (`/logout`); returns false when none was stored. A provider whose
   * sign-in can revoke its session does so first, and `onNotice` hears about it when that could not be confirmed.
   */
  logout(
    provider: string,
    options?: { signal?: AbortSignal; onNotice?: (text: string) => void },
  ): Promise<boolean>
  /**
   * Opens a session (or returns it if already open); with file storage the id names the directory `sessions/<id>/`.
   * Options apply on first open, except a first scope/channel routing binding may attach to an existing object. Call `await session.resume()` to restore history.
   */
  session(id?: string, options?: SessionOptions): VelaSession
  /** Currently open sessions */
  sessions(): VelaSession[]
  /**
   * Saved sessions, newest first, from SessionStorage.list(); empty if the storage doesn't implement list.
   * Sessions archived with `setSessionArchived()` are left out unless `includeArchived` is set.
   */
  listSessions(options?: SavedSessionOptions): Promise<SessionSummary[]>
  /**
   * Archives or unarchives a saved session, without opening it; the flag is appended to the session file and
   * survives a restart. Resolves when the entry is saved; rejects when nothing is saved under `id`.
   */
  setSessionArchived(id: string, archived: boolean): Promise<void>
  /**
   * Searches the text of saved sessions' user and assistant messages (not tool output, `!` commands, summaries
   * or custom messages); newest first, one hit per session with a short match around the query.
   */
  searchSessions(
    query: string,
    options?: SavedSessionOptions,
  ): Promise<SessionSearchHit[]>
  /** Subscribes to events from all sessions; returns an unsubscribe function */
  subscribe(listener: VelaSessionEventListener): () => void
  /** Waits for all extensions (including async factories) to load; rejects if loading fails */
  ready(): Promise<void>
  /** Loaded extensions and the tools, commands and channels they registered */
  extensions(sessionId?: string): LoadedExtension[]
  /** Commands registered by extensions */
  commands(
    sessionId?: string,
  ): { name: string; description?: string; extension: string }[]
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
  runner: ExtensionRunner
  builder: SystemPromptBuilder
  skillLoader: SkillLoader
  promptTemplates: PromptTemplate[]
  loadedContextFiles: readonly ContextFile[]
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

/** Assembles one host with per-session history, execution and location-bound project capabilities. */
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
  let { model } = options
  let defaultsChanged = false
  let defaultThinkingLevel = options.thinkingLevel ?? DEFAULT_THINKING_LEVEL
  const models = new ModelRegistry(options.providers, options.credentials)
  const resolveModel = (
    requested: ModelInput | undefined,
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

  registerToolSearchTool(registry)

  const resourceSplit = options.sessionResources
  const projectConfig = new ProjectConfig(resourceSplit, dataDir, logger)
  const sessionShells = new Map<string, string | undefined>()
  const skillLoader = new SkillLoader(
    resourceSplit?.hostSkillDirs ?? options.skillDirs ?? [],
  )
  skillLoader.load()
  const templates = loadPromptTemplates(
    resourceSplit?.hostPromptDirs ?? options.promptTemplateDirs ?? [],
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
      : (resourceSplit?.userContextFiles ?? options.contextFiles ?? [])
  const sessions = new Map<string, VelaSession>()
  const hostDefaults = new Map<
    string,
    { model?: ModelInput; thinkingLevel?: ThinkingLevel }
  >()
  const hostResources = {
    systemPrompt: options.systemPrompt,
    appendSystemPrompt: options.appendSystemPrompt,
    contextFiles,
    skills: skillLoader.list(),
    promptTemplates,
  }
  const resources = new WorkspaceResources(hostResources)

  const activeKey = (id: string) => {
    const owner = sessions.get(id)
    return owner ? workspaceKey(id, owner.location) : id
  }
  const builder = createSessionPrompt(
    (id) => resources.get(activeKey(id)),
    (id) => sessions.get(id)?.cwd ?? cwd,
    (id) =>
      sessions.get(id)?.location.environment === 'local'
        ? (sessionShells.get(activeKey(id)) ?? options.shellPath)
        : undefined,
    options.docs,
  )

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
    if (existing) {
      applySessionRouting(existing, sessionOptions)
      return existing
    }
    hostDefaults.set(id, {
      model,
      thinkingLevel: defaultsChanged
        ? defaultThinkingLevel
        : options.thinkingLevel,
    })
    const created: VelaSession = new VelaSession(
      id,
      {
        model,
        prepareCommands: resourceSplit !== undefined,
        resolveModel,
        planLabel: (provider, channel) => models.planLabel(provider, channel),
        thinkingLevel: defaultThinkingLevel,
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
        expandInput: async (text, owner, signal) => {
          const snapshot = await prepareWorkspace(owner, signal)
          const name = /^\/skill:([^\s]+)/.exec(text)?.[1]
          const skill =
            name && snapshot.skills.find((item) => item.name === name)
          if (skill) {
            const expanded =
              skillLoader.get(skill.name) === skill
                ? skillLoader.expand(text)
                : await expandEnvironmentSkill(
                    text,
                    snapshot.skills,
                    await abortable(resolveExecution(owner), signal),
                    signal,
                  )
            if (expanded !== undefined) return expanded
          }
          return expandPromptTemplate(text, snapshot.promptTemplates) ?? text
        },
        get extensions() {
          return projects.runner(activeKey(id))
        },
        forward: (event, sessionId) => {
          for (const listener of listeners) listener(event, sessionId)
          const source = sessions.get(sessionId)
          if (source)
            projects.runner(activeKey(sessionId)).notify(event, source)
        },
        onSaved: (id) => options.onSessionSaved?.(id),
        hasResolver: !!options.env,
        resolveExecution,
        prepareWorkspace,
        bindWorkspace,
        discardWorkspace,
        onClose: async (closed) => {
          if (sessions.get(closed.id) === closed) {
            sessions.delete(closed.id)
            hostDefaults.delete(closed.id)
          }
          await discardWorkspace(closed, closed.location)
        },
      },
      sessionOptions,
    )
    sessions.set(id, created)
    sessionCwds.set(created.registry, created.cwd)
    return created
  }

  const runner: ExtensionRunner = new ExtensionRunner(
    {
      cwd,
      dataDir,
      extensionConfig: options.extensionConfig ?? {},
      logger,
      registry,
      models,
    },
    options.extensions ?? [],
    [auditLog],
  )

  const projects = new ProjectExtensions({
    split: resourceSplit,
    config: projectConfig,
    host: runner,
    registry,
    models,
    dataDir,
    logger,
  })

  const identities = new Map<string, string>()
  const bindWorkspace = (session: VelaSession) => {
    sessionCwds.set(session.registry, session.cwd)
    if (resourceSplit)
      projects.bind(
        workspaceKey(session.id, session.location),
        session.registry,
      )
  }
  const discardWorkspace = async (
    session: VelaSession,
    location: ExecutionLocation,
  ) => {
    const key = workspaceKey(session.id, location)
    resources.clear(key)
    projectConfig.clear(key)
    sessionShells.delete(key)
    identities.delete(key)
    await projects.release(key)
  }
  const resolveExecution = async (
    session: VelaSession,
    location = session.location,
    signal?: AbortSignal,
  ) => {
    session.store.assertLocationKnown()
    const key = workspaceKey(session.id, location)
    const local = location.environment === 'local'
    const target = { sessionId: session.id, location }
    const resolver =
      local && resourceSplit?.useBuiltinLocal ? undefined : options.env
    let env = resolver
      ? await resolver(target)
      : local
        ? createSessionLocalExecutionEnv({
            cwd: location.cwd,
            shellPath: options.shellPath,
            tempRoot: session.registry.results.dir,
          })
        : undefined
    signal?.throwIfAborted()
    if (
      !env?.id ||
      (env.id === 'node:local') !== local ||
      env.cwd !== location.cwd ||
      (identities.has(key) && identities.get(key) !== env.id)
    )
      throw new Error(
        `Execution environment unavailable for ${location.environment}:${location.cwd}`,
      )
    identities.set(key, env.id)
    if (local && resourceSplit) {
      const settings = await projectConfig.get(key, env)
      const shellPath =
        options.shellPath ??
        settings.shellPath ??
        resourceSplit?.fallbackShellPath
      signal?.throwIfAborted()
      sessionShells.set(key, shellPath)
      if (!resolver && shellPath !== options.shellPath)
        env = createSessionLocalExecutionEnv({
          cwd: location.cwd,
          shellPath,
          tempRoot: session.registry.results.dir,
        })
    }
    return local && resolver
      ? scopeLocalResults(env, session.registry.results.dir)
      : env
  }

  const prepareWorkspace = async (
    session: VelaSession,
    signal?: AbortSignal,
    target = session.location,
  ) => {
    session.store.assertLocationKnown()
    if (sessions.get(session.id) !== session)
      throw new Error('Session is closed')
    const key = workspaceKey(session.id, target)
    await resources.prepare(
      key,
      async (signal) => {
        const location = target.cwd
        const local = target.environment === 'local'
        const env = await abortable(
          resolveExecution(session, target, signal),
          signal,
        )
        const workspaceMode = local ? projectConfig.mode(location) : undefined
        const settings = await projectConfig.get(key, env)
        signal.throwIfAborted()
        await projects.prepare(key, env)
        signal.throwIfAborted()
        const inventory = await loadWorkspaceInventory(
          env,
          signal,
          settings,
          workspaceMode,
          {
            pinned:
              local &&
              !resourceSplit &&
              location === cwd &&
              options.contextFiles !== undefined,
            contextEnabled: options.contextFiles !== false,
            explicitSkills:
              local && location === cwd && options.skillDirs !== undefined,
            explicitTemplates:
              local &&
              location === cwd &&
              options.promptTemplateDirs !== undefined,
            split: resourceSplit,
            host: hostResources,
            logger,
          },
        )
        return {
          ...inventory,
          enabledModels: settings.enabledModels,
          defaultTools: settings.tools,
          defaults: resourceSplit
            ? {
                model:
                  hostDefaults.get(session.id)?.model ??
                  settings.model ??
                  resourceSplit.fallbackModel,
                thinkingLevel:
                  hostDefaults.get(session.id)?.thinkingLevel ??
                  settings.thinkingLevel,
                limits: { ...settings.limits, ...options.limits },
                autoCompaction:
                  options.autoCompaction ?? settings.autoCompaction,
              }
            : undefined,
        }
      },
      signal,
    )
    if (sameLocation(target, session.location)) bindWorkspace(session)
    return resources.get(key)
  }

  registry.setInterception({
    resolveEnv: async (sessionId, signal) => {
      const session = sessionId ? sessions.get(sessionId) : undefined
      if (!session)
        return createLocalExecutionEnv({ cwd, shellPath: options.shellPath })
      const targetSignal = signal ?? session.signal
      if (targetSignal?.aborted) throw targetSignal.reason
      try {
        return await abortable(resolveExecution(session), targetSignal)
      } catch (error) {
        if (targetSignal?.aborted) throw error
        throw new Error(
          `Execution environment unavailable for ${session.location.environment}:${session.cwd}`,
          { cause: error },
        )
      }
    },
    before: async (name, input, context) => {
      const session = context.sessionId
        ? sessions.get(context.sessionId)
        : undefined
      return session
        ? await projects
            .runner(activeKey(session.id))
            .toolCall(session, context.toolCallId, name, input)
        : { input }
    },
    after: async (name, input, output, context, isError) => {
      const session = context.sessionId
        ? sessions.get(context.sessionId)
        : undefined
      return session
        ? await projects
            .runner(activeKey(session.id))
            .toolResult(
              session,
              context.toolCallId,
              name,
              input,
              output,
              isError,
            )
        : output
    },
  })
  let defaultModel: ModelInput | undefined
  const vela: Vela = {
    cwd,
    dataDir,
    get model() {
      defaultModel ??= resolveModel(model).model
      return defaultModel
    },
    limits,
    models: (opts) => (opts?.all ? models.list() : models.available()),
    configureProvider: (name, provider) => {
      models.configure(name, provider)
      defaultModel = undefined
    },
    setDefaults: (nextModel, thinkingLevel) => {
      resolveModel(nextModel)
      model = nextModel
      defaultsChanged = true
      defaultThinkingLevel = thinkingLevel
      defaultModel = undefined
    },
    loginProviders: () => models.loginProviders(),
    login: (provider, method, interaction, loginOptions) =>
      models.login(provider, method, interaction, loginOptions),
    logout: (provider, options) => models.logout(provider, options),
    session,
    sessions: () => [...sessions.values()],
    listSessions: async (listOptions) => {
      const list = (await sessionStorage.list?.()) ?? []
      return listOptions?.includeArchived
        ? list
        : list.filter((summary) => !summary.archived)
    },
    setSessionArchived: async (id, archived) => {
      assertSessionId(id)
      const open = sessions.get(id)
      if (open) return open.store.setArchived(archived)
      if (!(await setSavedSessionArchived(sessionStorage, id, archived))) return
      try {
        options.onSessionSaved?.(id)
      } catch (error) {
        logger.error(
          `[session:${id}] save observer failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
    searchSessions: async (query, searchOptions) => {
      const text = query.trim()
      if (!text) return []
      const hits: SessionSearchHit[] = []
      for (const summary of await vela.listSessions(searchOptions)) {
        const entries = await sessionStorage.load(summary.id)
        const match = entries && searchSessionText(entries, text)
        if (match) hits.push({ id: summary.id, match })
      }
      return hits
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ready: () => runner.ready,
    extensions: (id) =>
      projects.select(id, sessions, activeKey(id ?? 'default')).loaded(),
    commands: (id) =>
      projects.select(id, sessions, activeKey(id ?? 'default')).commands(),
    dispose() {
      disposed = true
      disposing ??= (async () => {
        // A factory may still be registering resources. Initialization failures remain on ready().
        await runner.settled
        const errors: unknown[] = []
        try {
          await options.beforeDispose?.()
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
    runner,
    builder,
    skillLoader,
    promptTemplates,
    loadedContextFiles: contextFiles,
    resolveBinary,
  })
  return vela
}
