import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  assertNoLegacyConfigFiles,
  interpolateConfigLayer,
  parseConfig,
  toExtensionConfigView,
  type VelaSettings,
} from './config/index.ts'
import { openDatabase } from './db/index.ts'
import { savedTrust, saveTrust } from './db/trust.ts'
import { defaultAgentDir } from './driver/config/paths.ts'
import {
  createVelaAgentDriver,
  type RuntimeMcpAdapter,
} from './driver/runtime-adapter.ts'
import type { ResolveSpecialModelFn } from './driver/runtime-types.ts'
import { listSessionSummariesFromDb } from './driver/session/db-queries.ts'
import {
  fileCredentialStore,
  memoryCredentialStore,
} from './providers/auth/store.ts'
import {
  ModelRegistry,
  type ProviderDefinition,
} from './providers/models/index.ts'
import { loadModels } from './providers/models-config.ts'
import {
  EnvironmentRegistry,
  listRuntimeSessionMessages,
  SqliteOAuthRegistrationStore,
  VelaRuntimeEngine,
} from './runtime/index.ts'
import type {
  CreateRuntimeOptions,
  LocalVelaRuntime,
  RuntimePromptInput,
  RuntimeRecoverySummary,
  VelaRuntime,
} from './runtime-sdk-types.ts'
import { silentLogger, type VelaLogger } from './shared/logger.ts'
import type { ModelInput } from './shared/provider-types.ts'

export type {
  CreateRuntimeOptions,
  LocalVelaRuntime,
  RuntimePromptInput,
  RuntimeRecoverySummary,
  VelaRuntime,
}

function createLazyRuntimeMcpAdapter(
  hostEnv: Record<string, string | undefined> | undefined,
  logger: VelaLogger,
  skipUserConfig = false,
): RuntimeMcpAdapter {
  let adapterPromise: Promise<RuntimeMcpAdapter> | undefined
  const loadAdapter = (): Promise<RuntimeMcpAdapter> => {
    adapterPromise ??= import('./mcp/runtime-adapter.ts').then((mod) =>
      mod.createRuntimeMcpAdapter({ hostEnv, logger, skipUserConfig }),
    )
    return adapterPromise
  }
  return {
    async attach(params) {
      const adapter = await loadAdapter()
      return adapter.attach(params)
    },
    async dispose() {
      if (!adapterPromise) return
      const adapter = await adapterPromise
      await adapter.dispose?.()
    },
  }
}

function loadOwnerRuntimeConfig(
  agentDir: string,
  hostEnv: Record<string, string | undefined>,
): VelaSettings {
  assertNoLegacyConfigFiles(agentDir)
  const file = join(agentDir, 'config.json')
  if (!existsSync(file)) return {}
  return interpolateConfigLayer(
    parseConfig(readFileSync(file, 'utf8'), file),
    hostEnv,
  )
}

function statSignature(file: string): string {
  try {
    const st = statSync(file)
    return `${st.ino}:${st.mtimeMs}:${st.size}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

function mergeExtensionConfig(
  base: Record<string, Record<string, unknown>>,
  override: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> | undefined {
  const keys = new Set([...Object.keys(base), ...Object.keys(override ?? {})])
  if (keys.size === 0) return undefined
  const merged: Record<string, Record<string, unknown>> = {}
  for (const key of keys) {
    merged[key] = { ...(base[key] ?? {}), ...(override?.[key] ?? {}) }
  }
  return merged
}

function createSpecialModelResolver(): ResolveSpecialModelFn {
  return async ({ modelRef, recordPath, fallbackModel }) => {
    const testing = await import('./testing/core/index.ts')
    let baseModel: ModelInput | undefined
    if (modelRef === 'mock') {
      baseModel = testing.createMockModel()
    } else if (modelRef?.startsWith('faux:')) {
      baseModel = await testing.loadFauxScenario(modelRef.slice('faux:'.length))
    } else {
      baseModel = fallbackModel
    }
    if (!baseModel) return undefined
    const maybeCache = baseModel as unknown as {
      setCacheEnabled?: (enabled: boolean) => void
    }
    if (recordPath) {
      const recorder = testing.recordModel(baseModel, { path: recordPath })
      return {
        model: recorder.model,
        addInput: (input) => recorder.addInput(input),
        flush: () => recorder.flush(),
        ...(maybeCache.setCacheEnabled
          ? {
              setCacheEnabled: (enabled) =>
                maybeCache.setCacheEnabled?.(enabled),
            }
          : {}),
      }
    }
    return {
      model: baseModel,
      ...(maybeCache.setCacheEnabled
        ? {
            setCacheEnabled: (enabled) => maybeCache.setCacheEnabled?.(enabled),
          }
        : {}),
    }
  }
}

/**
 * Creates an in-process `LocalVelaRuntime` backed by `<agentDir>/vela.db` (or `:memory:` when `ephemeral: true`).
 * Implements the same `VelaRuntime` contract that `connectRuntime()` exposes over `vela.sock`.
 */
export function createRuntime(
  options: CreateRuntimeOptions = {},
): LocalVelaRuntime {
  const logger = options.logger ?? silentLogger
  const isEphemeral = options.ephemeral === true
  const hostEnv = options.hostEnv ?? {}
  const transientAgentDir =
    isEphemeral && !options.agentDir
      ? mkdtempSync(join(tmpdir(), 'vela-runtime-'))
      : undefined
  const agentDir = resolve(
    options.agentDir ?? transientAgentDir ?? defaultAgentDir(hostEnv),
  )
  const ownsDb = !options.db
  const db =
    options.db ??
    openDatabase({
      path: isEphemeral ? ':memory:' : join(agentDir, 'vela.db'),
    })

  try {
    const configPath = join(agentDir, 'config.json')
    const authPath = join(agentDir, 'auth.json')
    let lastConfigSig = isEphemeral ? 'ephemeral' : statSignature(configPath)
    let lastAuthSig = isEphemeral ? 'ephemeral' : statSignature(authPath)

    const computeConfigState = () => {
      const ownerConfig: VelaSettings = isEphemeral
        ? {}
        : loadOwnerRuntimeConfig(agentDir, hostEnv)
      const configProviders = isEphemeral ? {} : (ownerConfig.providers ?? {})
      const loadedProviders = loadModels({
        agentDir,
        env: hostEnv,
        providers: configProviders,
      })
      const providers: Record<string, ProviderDefinition> = {
        ...loadedProviders,
        ...(options.providers ?? {}),
      }
      const ownerExtensionConfig = isEphemeral
        ? {}
        : toExtensionConfigView(ownerConfig)
      const extensionConfig = mergeExtensionConfig(
        ownerExtensionConfig,
        options.extensionConfig,
      )
      const limits =
        ownerConfig.limits || options.limits
          ? { ...ownerConfig.limits, ...options.limits }
          : undefined
      const dreamEnabled =
        options.dreamEnabled ??
        (typeof ownerConfig.memory?.dream === 'boolean'
          ? ownerConfig.memory.dream
          : undefined)
      return {
        ownerConfig,
        configProviders,
        providers,
        extensionConfig,
        limits,
        dreamEnabled,
      }
    }

    const initial = computeConfigState()
    const credentials =
      options.credentials ??
      (isEphemeral ? memoryCredentialStore() : fileCredentialStore(authPath))
    const registrations = new SqliteOAuthRegistrationStore(db)
    const models = new ModelRegistry(
      initial.providers,
      credentials,
      registrations,
    )
    const environments =
      options.environments instanceof EnvironmentRegistry
        ? options.environments
        : new EnvironmentRegistry({
            dataDir: agentDir,
            environments:
              options.environments ??
              (isEphemeral ? undefined : initial.ownerConfig.environments),
            hostEnv,
          })
    const mcpAdapter =
      options.mcp === false
        ? undefined
        : createLazyRuntimeMcpAdapter(hostEnv, logger, isEphemeral)

    const engine = new VelaRuntimeEngine({
      db,
      agentDir,
      environments,
      drivers: options.drivers,
      logger,
    })

    const onBeforeExtensionImport = async () => {
      const { registerExtensionHostModules } = await import(
        './driver/config/extensions.ts'
      )
      registerExtensionHostModules({
        '@glows777/vela/extension-api': () => import('./extension-api.ts'),
        zod: () => import('zod'),
      })
    }

    const velaDriver = createVelaAgentDriver({
      db,
      agentDir,
      blobs: engine.blobs,
      environments: engine.environments,
      timers: engine.timers,
      subscriptions: engine.subscriptions,
      eventBus: engine.eventBus,
      wakeSession: (sid) => engine.scheduleSession(sid),
      flushOutbox: () => {
        void engine.outbox.flushOnce().catch(() => {})
      },
      isSessionBusy: (sid) => engine.isSessionBusy(sid),
      mcp: mcpAdapter,
      defaultModel: options.defaultModel ?? initial.ownerConfig.model,
      defaultThinkingLevel:
        options.defaultThinkingLevel ?? initial.ownerConfig.thinkingLevel,
      providers: initial.providers,
      rawConfigProviders: initial.configProviders,
      credentials,
      registrations,
      models,
      limits: initial.limits,
      tools: options.tools,
      defaultTools: initial.ownerConfig.tools,
      extensionConfig: initial.extensionConfig,
      extensions: initial.ownerConfig.extensions,
      enabledModels: initial.ownerConfig.enabledModels,
      hostEnv,
      contextFiles: options.contextFiles,
      skills: options.skills,
      promptTemplates: options.promptTemplates,
      offline: options.offline,
      dreamEnabled: initial.dreamEnabled,
      trustOverride: options.trustOverride,
      toolApprovalCheck: options.toolApprovalCheck,
      resolveSpecialModel: createSpecialModelResolver(),
      onBeforeExtensionImport,
      logger,
    })
    engine.registerDriver(velaDriver)

    let reloadQueue: Promise<void> = Promise.resolve()
    const reloadConfigInternal = (force: boolean): Promise<void> => {
      if (isEphemeral) return Promise.resolve()
      const next = reloadQueue.then(async () => {
        const nextConfigSig = statSignature(configPath)
        const nextAuthSig = statSignature(authPath)
        if (
          !force &&
          nextConfigSig === lastConfigSig &&
          nextAuthSig === lastAuthSig
        ) {
          return
        }
        lastConfigSig = nextConfigSig
        lastAuthSig = nextAuthSig
        const updated = computeConfigState()
        await velaDriver.control.reloadConfig({
          defaultModel: options.defaultModel ?? updated.ownerConfig.model,
          defaultThinkingLevel:
            options.defaultThinkingLevel ?? updated.ownerConfig.thinkingLevel,
          providers: updated.providers,
          rawConfigProviders: updated.configProviders,
          limits: updated.limits,
          defaultTools: updated.ownerConfig.tools,
          extensionConfig: updated.extensionConfig,
          extensions: updated.ownerConfig.extensions,
          enabledModels: updated.ownerConfig.enabledModels,
          dreamEnabled: updated.dreamEnabled,
          offline: options.offline,
        })
      })
      reloadQueue = next.catch(() => {})
      return next
    }

    const maybeRefreshConfig = (): Promise<void> => {
      if (isEphemeral) return Promise.resolve()
      const nextConfigSig = statSignature(configPath)
      const nextAuthSig = statSignature(authPath)
      if (nextConfigSig === lastConfigSig && nextAuthSig === lastAuthSig) {
        return reloadQueue
      }
      return reloadConfigInternal(false)
    }

    let disposing: Promise<void> | undefined

    return {
      agentDir: engine.agentDir,
      ready: () => velaDriver.control.ready(),
      extensionErrors: async () => velaDriver.control.extensionErrors(),
      reloadConfig: () => reloadConfigInternal(true),
      projects: {
        list: async (opts) => engine.projects.list(opts),
        get: async (id) => engine.projects.get(id),
        getByCwd: async (cwd) => engine.projects.getByCwd(cwd),
        create: async (input) => engine.projects.create(input),
        update: async (id, patch) => engine.projects.update(id, patch),
        remove: async (id, opts) => engine.projects.remove(id, opts),
      },
      trust: {
        check: async (location) =>
          savedTrust(db, location, engine.environments.dataDir),
        approve: async (location, trusted) => {
          saveTrust(db, location, trusted, engine.environments.dataDir)
        },
      },
      oauthRegistrations: {
        get: async (provider) => registrations.get(provider),
        set: async (provider, reg) => registrations.set(provider, reg),
        delete: async (provider) => registrations.delete(provider),
      },
      sessions: {
        list: async (opts) => engine.sessions.list(opts),
        listSummaries: async (opts) =>
          listSessionSummariesFromDb(db, opts?.includeArchived ?? false, {
            ...(opts?.projectId ? { projectId: opts.projectId } : {}),
            ...(opts?.cwd ? { cwd: opts.cwd } : {}),
            ...(opts?.excludeChannels
              ? { excludeChannels: opts.excludeChannels }
              : {}),
          }),
        get: async (id) => engine.sessions.get(id),
        create: async (input) => engine.sessions.create(input),
        rename: async (id, name) => engine.sessions.rename(id, name),
        delete: async (id) => engine.sessions.delete(id),
        reset: (id) => engine.restartSession(id),
        status: async (id) => engine.sessions.status(id),
        messages: async (input) => listRuntimeSessionMessages(db, input),
        configure: async (sessionId, override) => {
          await maybeRefreshConfig()
          await velaDriver.control.configure(sessionId, override)
        },
        setModel: (sessionId, modelRef) =>
          velaDriver.control.setModel(sessionId, modelRef),
        setThinkingLevel: (sessionId, level) =>
          velaDriver.control.setThinkingLevel(sessionId, level),
        compact: (sessionId, instructions) =>
          velaDriver.control.compact(sessionId, instructions),
        tree: (sessionId) => velaDriver.control.tree(sessionId),
        navigateTree: (sessionId, targetId, opts) =>
          velaDriver.control.navigateTree(sessionId, targetId, opts),
        setLabel: (sessionId, entryId, label) =>
          velaDriver.control.setLabel(sessionId, entryId, label),
        fork: (sessionId, entryId, opts) =>
          velaDriver.control.fork(sessionId, entryId, opts),
        clone: (sessionId, opts) => velaDriver.control.clone(sessionId, opts),
        inspect: async (sessionId, opts) => {
          await maybeRefreshConfig()
          return velaDriver.control.inspect(sessionId, opts)
        },
        execBash: (sessionId, command, opts) =>
          velaDriver.control.execBash(sessionId, command, opts),
        abortBash: async (sessionId) => {
          velaDriver.control.abortBash(sessionId)
        },
        runCommand: (sessionId, input) =>
          velaDriver.control.runCommand(sessionId, input),
        clearQueue: async (sessionId) =>
          velaDriver.control.clearQueue(sessionId),
        export: (sessionId, format, outputPath, baseCwd) =>
          velaDriver.control.exportSession(
            sessionId,
            format,
            outputPath,
            baseCwd,
          ),
      },
      prompt: async (sessionId, input) => {
        await maybeRefreshConfig()
        const res = engine.submitPrompt({ ...input, sessionId })
        return { eventId: res.event.id, inserted: res.inserted }
      },
      steer: (sessionId, text) => engine.steerSession(sessionId, text),
      stop: (sessionId, reason) => engine.stopSession(sessionId, reason),
      waitForIdle: (sessionId) => engine.waitForIdle(sessionId),
      jobs: {
        list: async (sessionId) => velaDriver.control.listJobs(sessionId),
        stop: (sessionId, jobId) =>
          velaDriver.control.stopJob(sessionId, jobId),
        promoteForeground: (sessionId, toolCallId) =>
          velaDriver.control.promoteForeground(sessionId, toolCallId),
      },
      approvals: {
        list: async (sessionId) => engine.listPendingApprovals(sessionId),
        resolve: async (input) => engine.resolveApproval(input),
      },
      timers: {
        list: async (filter) => engine.timers.list(filter),
        createRoutine: async (input) => engine.timers.createRoutine(input),
        createFollowup: async (input) => engine.timers.createFollowup(input),
        update: async (id, patch) => engine.timers.update(id, patch),
        delete: async (id) => engine.timers.delete(id),
      },
      subscriptions: {
        list: async (filter) => engine.subscriptions.list(filter),
        create: async (input) => engine.subscriptions.create(input),
        remove: async (id) => engine.subscriptions.remove(id),
      },
      bindings: {
        list: async (filter) => engine.bindings.list(filter),
        get: async (id) => engine.bindings.get(id),
        upsert: async (input) => engine.bindings.upsert(input),
        setEnabled: async (id, enabled) =>
          engine.bindings.setEnabled(id, enabled),
        remove: async (id) => engine.bindings.remove(id),
      },
      blobs: {
        get: async (id) => engine.blobs.get(id),
        list: async (sessionId, direction) =>
          engine.blobs.listBySession(sessionId, direction),
        read: (id) => engine.blobs.readBytes(id),
        storeInbound: (input) => engine.blobs.storeInbound(input),
      },
      events: {
        list: async (opts) => engine.listEvents(opts),
        bufferedDeltas: async (sessionId) => engine.bufferedDeltas(sessionId),
        subscribe: (listener) => engine.subscribeEvents(listener),
        subscribeDeltas: (listener) => engine.subscribeDeltas(listener),
      },
      models: async (opts) => {
        await maybeRefreshConfig()
        return opts?.all
          ? models.list(opts.channel)
          : models.available(opts?.channel)
      },
      loginProviders: async () => {
        await maybeRefreshConfig()
        return models.loginProviders()
      },
      login: async (provider, method, interaction, loginOptions) => {
        await models.login(provider, method, interaction, loginOptions)
        lastAuthSig = isEphemeral ? 'ephemeral' : statSignature(authPath)
      },
      logout: async (provider, logoutOptions) => {
        const res = await models.logout(provider, logoutOptions)
        lastAuthSig = isEphemeral ? 'ephemeral' : statSignature(authPath)
        return res
      },
      recover: () => engine.recover(),
      registerChannel: (adapter) => engine.registerChannel(adapter),
      unregisterChannel: (name) => engine.unregisterChannel(name),
      registerDriver: (driver) => engine.registerDriver(driver),
      dispose() {
        disposing ??= (async () => {
          try {
            await engine.dispose()
          } finally {
            if (ownsDb && db.open) db.close()
            if (transientAgentDir) {
              rmSync(transientAgentDir, { recursive: true, force: true })
            }
          }
        })()
        return disposing
      },
    }
  } catch (error) {
    if (ownsDb && db.open) db.close()
    if (transientAgentDir) {
      rmSync(transientAgentDir, { recursive: true, force: true })
    }
    throw error
  }
}
