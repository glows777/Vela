import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../db/index.ts'
import type { OAuthRegistrationStore } from '../providers/auth/types.ts'
import {
  DEFAULT_THINKING_LEVEL,
  ModelRegistry,
  type ResolvedModel,
  resolveModelInput,
  type ThinkingLevel,
} from '../providers/models/index.ts'
import { SqliteOAuthRegistrationStore } from '../runtime/index.ts'
import { resolveLimits } from '../shared/limits.ts'
import { silentLogger } from '../shared/logger.ts'
import type { ModelInput } from '../shared/provider-types.ts'
import type { VelaSessionEventListener } from './agent/events.ts'
import { createLocalExecutionEnv } from './execution/local.ts'
import { abortable, sameLocation } from './execution/location.ts'
import type { ExecutionLocation } from './execution/types.ts'
import { auditLog } from './extensions/audit.ts'
import { ExtensionRunner } from './extensions/runner.ts'
import { localDateString } from './prompt/index.ts'
import { loadPromptTemplates } from './prompt/templates.ts'
import {
  listSessionSummariesFromDb,
  searchSessionsInDb,
  setSavedSessionArchivedInDb,
} from './session/db-queries.ts'
import type { SessionOptions } from './session/options.ts'
import { assertSessionId } from './session/options.ts'
import {
  canonicalEnvironmentPath,
  ProjectConfig,
} from './session/project-config.ts'
import { ProjectExtensions } from './session/project-extensions.ts'
import {
  createSessionPrompt,
  expandSessionInput,
} from './session/prompt-builder.ts'
import { WorkspaceResources } from './session/resources.ts'
import { applySessionRouting } from './session/routing.ts'
import {
  cleanupFailedVelaInit,
  disposeVelaRuntime,
  loadWorkspaceInventory,
  openVelaStorage,
  resolveSessionExecution,
  syncSessionNetwork,
  workspaceKey,
} from './session/workspace.ts'
import { SkillLoader } from './skills/loader.ts'
import { createBinaryResolver } from './tools/binaries.ts'
import { createCoreTools } from './tools/index.ts'
import { ToolRegistry } from './tools/registry.ts'
import { registerToolSearchTool } from './tools/tool-search.ts'
import { VelaSession } from './vela-session.ts'
import {
  type SavedSessionOptions,
  setVelaInternals,
  type Vela,
  type VelaOptions,
  velaInternals,
} from './vela-types.ts'

export type { SavedSessionOptions, Vela, VelaOptions }
export { velaInternals }

/** Assembles one host with per-session history, execution and location-bound project capabilities. */
export function createVela(options: VelaOptions = {}): Vela {
  const storage = openVelaStorage(options)
  try {
    return initVelaInstance(options, storage)
  } catch (error) {
    cleanupFailedVelaInit(
      storage.ownsDb,
      storage.db,
      storage.ephemeral,
      storage.dataDir,
    )
    throw error
  }
}

function lazyFileRegistrationStore(dbPath: string): OAuthRegistrationStore {
  return {
    get(provider) {
      if (!existsSync(dbPath)) return undefined
      const db = openDatabase({ path: dbPath, readonly: true })
      try {
        return new SqliteOAuthRegistrationStore(db).get(provider)
      } finally {
        db.close()
      }
    },
    set(provider, registration) {
      const db = openDatabase({ path: dbPath })
      try {
        new SqliteOAuthRegistrationStore(db).set(provider, registration)
      } finally {
        db.close()
      }
    },
    delete(provider) {
      if (!existsSync(dbPath)) return false
      const db = openDatabase({ path: dbPath })
      try {
        return new SqliteOAuthRegistrationStore(db).delete(provider)
      } finally {
        db.close()
      }
    },
  }
}

function initVelaInstance(
  options: VelaOptions,
  storage: ReturnType<typeof openVelaStorage>,
): Vela {
  const {
    cwd,
    agentDir,
    ephemeral,
    ephemeralSessions,
    dataDir,
    blobsDir,
    ownsDb,
    db,
  } = storage
  let { model } = options
  let defaultsChanged = false
  let defaultThinkingLevel = options.thinkingLevel ?? DEFAULT_THINKING_LEVEL
  const registrations =
    options.registrations ??
    (agentDir && ephemeralSessions && !options.db
      ? lazyFileRegistrationStore(join(agentDir, 'vela.db'))
      : new SqliteOAuthRegistrationStore(db))
  const models = new ModelRegistry(
    options.providers,
    options.credentials,
    registrations,
  )
  const resolveModel = (
    requested: ModelInput | undefined,
    from?: VelaSession,
  ): ResolvedModel => {
    // Like pi: without a chosen model, the first provider with a credential supplies its default model
    const choice = requested ?? models.defaultRef(from?.channel)
    if (choice === undefined)
      throw new Error(
        'No model selected: pass model to createVela(), or call session.setModel()',
      )
    return resolveModelInput(models, choice, () => from?.channel)
  }
  const limits = resolveLimits(options.limits)
  const logger = options.logger ?? silentLogger
  const sessionCwds = new WeakMap<ToolRegistry, string>()

  // The Vela-level registry only holds shared tool definitions; tools run in each session's forked registry.
  // Its own results dir starts with `.`, so it never collides with a session id.
  const registry = new ToolRegistry(
    join(dataDir, 'sessions', '.shared', 'tool-results'),
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
  const sessionOs = new Map<string, string>()
  const sessionDates = new Map<string, string>()
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
    (id) => (sessions.get(id)?.location.environment ?? 'local') === 'local',
    (id) => {
      const envName = sessions.get(id)?.location.environment ?? 'local'
      return (
        sessionOs.get(activeKey(id)) ??
        options.envOs?.(envName) ??
        (envName === 'local' ? process.platform : 'linux')
      )
    },
    (id) => sessionDates.get(id),
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
    const savedRow = !ephemeralSessions
      ? db.get<{ created_at: string }>(
          'SELECT created_at FROM sessions WHERE id = ?',
          id,
        )
      : undefined
    const sessionCreatedAt = savedRow?.created_at ?? new Date().toISOString()
    sessionDates.set(id, localDateString(new Date(sessionCreatedAt)))
    const created: VelaSession = new VelaSession(
      id,
      {
        model,
        prepareCommands: resourceSplit !== undefined,
        resolveModel,
        planLabel: (provider, channel) => models.planLabel(provider, channel),
        authMode: (provider, channel) => models.authMode(provider, channel),
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
        db,
        ephemeral: ephemeralSessions,
        temporaryDataDir: ephemeral,
        blobsDir,
        spillRoot: (sessionId) =>
          join(dataDir, 'sessions', sessionId, 'tool-results'),
        cwd,
        shellPath: options.shellPath,
        createdAt: sessionCreatedAt,
        registry,
        builder,
        // `/skill:<name> args`, then `/<template> args` (like pi; extension commands are tried first)
        expandInput: async (text, owner, signal) =>
          expandSessionInput({
            text,
            snapshot: await prepareWorkspace(owner, signal),
            skillLoader,
            resolveEnv: () => abortable(resolveExecution(owner), signal),
            signal,
          }),
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
            sessionDates.delete(closed.id)
          }
          await discardWorkspace(closed, closed.location)
        },
      },
      sessionOptions,
    )
    sessions.set(id, created)
    sessionCwds.set(created.registry, created.cwd)
    syncSessionNetwork(created, options.envNetworkMode)
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
    syncSessionNetwork(session, options.envNetworkMode)
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
    sessionOs.delete(key)
    identities.delete(key)
    await projects.release(key)
  }
  const resolveExecution = (
    session: VelaSession,
    location = session.location,
    signal?: AbortSignal,
  ) =>
    resolveSessionExecution({
      sessionId: session.id,
      location,
      spillDir: session.registry.spillDir,
      envResolver: options.env,
      shellPath: options.shellPath,
      dataDir,
      resourceSplit,
      projectConfig,
      identities,
      sessionOs,
      sessionShells,
      signal,
    })

  const prepareWorkspace = async (
    session: VelaSession,
    signal?: AbortSignal,
    target = session.location,
  ) => {
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
        const resolvedLocation =
          local || !resourceSplit
            ? location
            : await canonicalEnvironmentPath(env, location, signal)
        const workspaceMode = projectConfig.mode(
          resolvedLocation,
          target.environment,
        )
        const settings = await projectConfig.get(key, env, target.environment)
        signal.throwIfAborted()
        await projects.prepare(key, env, target.environment)
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
    models: (opts) =>
      opts?.all ? models.list(opts.channel) : models.available(opts?.channel),
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
    logout: (provider, logoutOptions) => models.logout(provider, logoutOptions),
    session,
    sessions: () => [...sessions.values()],
    listSessions: async (listOptions) =>
      ephemeralSessions
        ? []
        : listSessionSummariesFromDb(
            db,
            listOptions?.includeArchived ?? false,
            agentDir ? { cwd } : undefined,
          ),
    setSessionArchived: async (id, archived) => {
      assertSessionId(id)
      const open = sessions.get(id)
      if (open) return open.store.setArchived(archived)
      if (ephemeralSessions || !setSavedSessionArchivedInDb(db, id, archived))
        return
      try {
        options.onSessionSaved?.(id)
      } catch (error) {
        logger.error(
          `[session:${id}] save observer failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
    searchSessions: async (query, searchOptions) =>
      ephemeralSessions
        ? []
        : searchSessionsInDb(
            db,
            query,
            searchOptions?.includeArchived ?? false,
            agentDir ? { cwd } : undefined,
          ),
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
      disposing ??= disposeVelaRuntime({
        settled: runner.settled,
        shutdownRunner: () => runner.shutdown(),
        sessions: sessions.values(),
        listeners,
        db,
        ownsDb,
        ephemeral,
        dataDir,
        beforeDispose: options.beforeDispose,
      })
      return disposing
    },
  }
  setVelaInternals(vela, {
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
