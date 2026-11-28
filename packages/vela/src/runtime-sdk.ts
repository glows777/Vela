import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  loadOwnerRuntimeConfig,
  statSignature,
  toExtensionConfigView,
  type VelaSettings,
} from './config/index.ts'
import { registerRuntimeSettingsHooksResolver } from './daemon/settings-discovery.ts'
import { openDatabase, withReadonlyDb } from './db/index.ts'
import { savedTrust, saveTrust } from './db/trust.ts'
import { defaultAgentDir } from './driver/config/paths.ts'
import { createVelaAgentDriver } from './driver/runtime-adapter.ts'
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
  extractGithubRepositories,
  hasChannelEnabledInDb,
  isChannelEnabledInDb,
  SqliteOAuthRegistrationStore,
  setChannelEnabledInDb,
  updateEnvironmentRegistryConfig,
  VelaRuntimeEngine,
} from './runtime/index.ts'
import {
  createLazyRuntimeMcpAdapter,
  createSpecialModelResolver,
  isLarkExtensionDisabled,
  mergeExtensionConfig,
} from './runtime-sdk-helpers.ts'
import type {
  CreateRuntimeOptions,
  LocalVelaRuntime,
  VelaRuntime,
} from './runtime-sdk-types.ts'
import { defaultDocsPaths } from './shared/docs-paths.ts'
import { silentLogger } from './shared/logger.ts'

export type {
  CreateRuntimeOptions,
  LocalVelaRuntime,
  RuntimeLarkDiscoveryGroup,
  RuntimeLarkSetupInput,
  RuntimeModelSetupInput,
  RuntimePromptInput,
  RuntimeRecoverySummary,
  RuntimeSettingsLarkState,
  RuntimeSettingsModel,
  RuntimeSettingsProvider,
  RuntimeSettingsState,
  VelaRuntime,
} from './runtime-sdk-types.ts'

/**
 * Creates an in-process `LocalVelaRuntime` backed by `<agentDir>/vela.db` (or `:memory:` when `ephemeral: true`).
 * Implements the same `VelaRuntime` contract that `connectRuntime()` exposes over `vela.sock`.
 */
export function createRuntime(
  options: CreateRuntimeOptions = {},
): LocalVelaRuntime {
  const logger = options.logger ?? silentLogger
  const isEphemeral = options.ephemeral === true
  const isEphemeralDb = isEphemeral || options.ephemeralSessions === true
  const hostEnv = options.hostEnv ?? {}
  const transientAgentDir =
    isEphemeral && !options.agentDir
      ? mkdtempSync(join(tmpdir(), 'vela-runtime-'))
      : undefined
  const transientSpillRoot = isEphemeralDb
    ? mkdtempSync(join(tmpdir(), 'vela-spill-'))
    : undefined
  const agentDir = resolve(
    options.agentDir ?? transientAgentDir ?? defaultAgentDir(hostEnv),
  )
  const ownsDb = !options.db
  const db =
    options.db ??
    openDatabase({
      path: isEphemeralDb ? ':memory:' : join(agentDir, 'vela.db'),
    })
  if (isEphemeralDb && !isEphemeral && !options.db) {
    try {
      withReadonlyDb(join(agentDir, 'vela.db'), (ownerDb) => {
        const trustRows = ownerDb.all<{
          path: string
          trusted: number
          updated_at: string
        }>('SELECT path, trusted, updated_at FROM trusted_paths')
        for (const r of trustRows) {
          db.run(
            'INSERT OR REPLACE INTO trusted_paths (path, trusted, updated_at) VALUES (?, ?, ?)',
            r.path,
            r.trusted,
            r.updated_at,
          )
        }
        const oauthRows = ownerDb.all<{
          provider: string
          client_id: string
          host_id: string | null
          subject: string | null
          updated_at: string
        }>(
          'SELECT provider, client_id, host_id, subject, updated_at FROM oauth_registrations',
        )
        for (const r of oauthRows) {
          db.run(
            'INSERT OR REPLACE INTO oauth_registrations (provider, client_id, host_id, subject, updated_at) VALUES (?, ?, ?, ?, ?)',
            r.provider,
            r.client_id,
            r.host_id,
            r.subject,
            r.updated_at,
          )
        }
      })
    } catch {
      /* ignore unreadable owner db when seeding ephemeral state */
    }
  }

  try {
    const configPath = join(agentDir, 'config.json')
    const authPath = join(agentDir, 'auth.json')
    let lastConfigSig = isEphemeral ? 'ephemeral' : statSignature(configPath)
    let lastAuthSig = isEphemeral ? 'ephemeral' : statSignature(authPath)

    const computeConfigState = () => {
      const loadedOwner = isEphemeral
        ? { settings: {} as VelaSettings }
        : loadOwnerRuntimeConfig(agentDir, hostEnv)
      const ownerConfig: VelaSettings = loadedOwner.settings
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
      const limits = ownerConfig.limits
      const dreamEnabled =
        options.dreamEnabled ??
        (typeof ownerConfig.memory?.dream === 'boolean'
          ? ownerConfig.memory.dream
          : undefined)
      return {
        ownerConfig,
        larkError: loadedOwner.larkError,
        configProviders,
        providers,
        extensionConfig,
        limits,
        dreamEnabled,
      }
    }

    const initial = computeConfigState()
    const hasLegacyLarkDisabled = (() => {
      if (isEphemeral || hasChannelEnabledInDb(db, 'lark')) return false
      if (initial.ownerConfig.lark?.runInApp === false) return true
      if (!existsSync(configPath)) return false
      try {
        const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
          lark?: { runInApp?: unknown }
        }
        return raw?.lark?.runInApp === false
      } catch {
        return false
      }
    })()
    if (hasLegacyLarkDisabled) {
      setChannelEnabledInDb(db, 'lark', false)
    }
    const readInitialCredentials = () => {
      if (isEphemeral) return {}
      try {
        const disk = fileCredentialStore(authPath)
        const out: Record<string, NonNullable<ReturnType<typeof disk.get>>> = {}
        for (const provider of disk.list()) {
          const cred = disk.get(provider)
          if (cred) out[provider] = cred
        }
        return out
      } catch {
        return {}
      }
    }
    const credentials =
      options.credentials ??
      (isEphemeralDb
        ? memoryCredentialStore(readInitialCredentials())
        : fileCredentialStore(authPath))
    const registrations = new SqliteOAuthRegistrationStore(db)
    const models = new ModelRegistry(
      initial.providers,
      credentials,
      registrations,
      { blockLocalOnlyOAuth: options.allowLocalOnlyOAuth === false },
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

    let closeDriverSession: ((sid: string) => Promise<void>) | undefined
    let trySteerDriverInboxEvent:
      | ((
          sid: string,
          inboxEventId: string,
          text: string,
          images?: Array<{ data: string; mimeType: string }>,
        ) => boolean)
      | undefined

    const engine = new VelaRuntimeEngine({
      db,
      agentDir,
      environments,
      drivers: options.drivers,
      ignoredChannels: options.ignoredChannels,
      onRestartSession: (sid) => closeDriverSession?.(sid),
      trySteerInboxEvent: (sid, inboxEventId, text, images) => {
        if (!trySteerDriverInboxEvent?.(sid, inboxEventId, text, images)) {
          return false
        }
        db.run(
          'UPDATE sessions SET followup_streak = 0, updated_at = ? WHERE id = ?',
          new Date().toISOString(),
          sid,
        )
        return true
      },
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

    const explicitExtensions = options.extensions

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
      shellPath: initial.ownerConfig.shellPath,
      explicitShellPath: options.shellPath,
      limits: initial.limits,
      explicitLimits: options.limits,
      tools: options.tools,
      defaultTools: initial.ownerConfig.tools,
      extensionConfig: initial.extensionConfig,
      extensions: initial.ownerConfig.extensions,
      explicitExtensions: explicitExtensions?.length
        ? explicitExtensions
        : undefined,
      enabledModels: initial.ownerConfig.enabledModels,
      githubRepositories: extractGithubRepositories(
        initial.ownerConfig.webhooks,
      ),
      getChannelTools: (sid, runId) =>
        engine.getChannelToolsForSession(sid, runId),
      getChannelTimezone: (channel) => engine.channelAdapter(channel)?.timezone,
      hostEnv,
      docsPaths: options.docs ?? defaultDocsPaths(),
      systemPrompt: options.systemPrompt,
      appendSystemPrompt: options.appendSystemPrompt,
      contextFiles: options.contextFiles,
      skills: options.skills,
      promptTemplates: options.promptTemplates,
      offline: options.offline,
      dreamEnabled: initial.dreamEnabled,
      autoCompaction: initial.ownerConfig.autoCompaction,
      explicitAutoCompaction: options.autoCompaction,
      trustOverride: options.trustOverride,
      toolApprovalCheck: options.toolApprovalCheck,
      resolveSpecialModel: createSpecialModelResolver(),
      spillRoot: transientSpillRoot,
      onBeforeExtensionImport,
      logger,
    })
    engine.registerDriver(velaDriver)
    closeDriverSession = (sid) => velaDriver.control.closeSession(sid)
    trySteerDriverInboxEvent = (sid, inboxEventId, text, images) =>
      velaDriver.control.steerInboxEvent(sid, inboxEventId, text, images)

    let currentWebhookConfig: {
      webhooks?: Record<string, unknown>
      eventDefaultTarget?: { channel: string; chatId: string }
    } = {
      webhooks: initial.ownerConfig.webhooks,
      eventDefaultTarget: initial.ownerConfig.eventDefaultTarget,
    }
    let currentLarkConfig: {
      lark?: Record<string, unknown>
      larkError?: string
      disabledByExtension?: boolean
    } = {
      lark: initial.ownerConfig.lark,
      ...(initial.larkError ? { larkError: initial.larkError } : {}),
      disabledByExtension: isLarkExtensionDisabled(
        initial.ownerConfig.extensions,
        explicitExtensions,
      ),
    }
    let reloadQueue: Promise<void> = Promise.resolve()
    const reloadConfigInternal = (force: boolean): Promise<void> => {
      if (isEphemeral) return Promise.resolve()
      const next = reloadQueue.then(async () => {
        if (disposing) return
        const nextConfigSig = statSignature(configPath)
        const nextAuthSig = statSignature(authPath)
        const configChanged = force || nextConfigSig !== lastConfigSig
        const authChanged = nextAuthSig !== lastAuthSig
        if (!configChanged && !authChanged) {
          return
        }
        if (!configChanged) {
          lastAuthSig = nextAuthSig
          return
        }
        const updated = computeConfigState()
        if (disposing) return
        if (
          !(options.environments instanceof EnvironmentRegistry) &&
          options.environments === undefined
        ) {
          updateEnvironmentRegistryConfig(
            environments,
            updated.ownerConfig.environments,
          )
        }
        currentWebhookConfig = {
          webhooks: updated.ownerConfig.webhooks,
          eventDefaultTarget: updated.ownerConfig.eventDefaultTarget,
        }
        currentLarkConfig = {
          lark: updated.ownerConfig.lark,
          ...(updated.larkError ? { larkError: updated.larkError } : {}),
          disabledByExtension: isLarkExtensionDisabled(
            updated.ownerConfig.extensions,
            explicitExtensions,
          ),
        }
        await velaDriver.control.reloadConfig({
          defaultModel: options.defaultModel ?? updated.ownerConfig.model,
          defaultThinkingLevel:
            options.defaultThinkingLevel ?? updated.ownerConfig.thinkingLevel,
          providers: updated.providers,
          rawConfigProviders: updated.configProviders,
          shellPath: updated.ownerConfig.shellPath,
          limits: updated.limits,
          defaultTools: updated.ownerConfig.tools,
          extensionConfig: updated.extensionConfig,
          extensions: updated.ownerConfig.extensions,
          enabledModels: updated.ownerConfig.enabledModels,
          githubRepositories: extractGithubRepositories(
            updated.ownerConfig.webhooks,
          ),
          dreamEnabled: updated.dreamEnabled,
          autoCompaction: updated.ownerConfig.autoCompaction,
          offline: options.offline,
        })
        if (disposing) return
        await options.onConfigReloaded?.(currentWebhookConfig)
        await options.onLarkConfigReloaded?.(currentLarkConfig)
        lastConfigSig = nextConfigSig
        lastAuthSig = nextAuthSig
      })
      reloadQueue = next.catch(() => {})
      return next
    }

    const maybeRefreshConfig = (): Promise<void> => {
      if (isEphemeral) return Promise.resolve()
      const nextConfigSig = statSignature(configPath)
      const nextAuthSig = statSignature(authPath)
      if (nextConfigSig === lastConfigSig) {
        lastAuthSig = nextAuthSig
        return reloadQueue
      }
      return reloadConfigInternal(false)
    }

    const hasPendingOutboxDeliveries = (chatId?: string): boolean => {
      const pending = db.all<{ session_id: string }>(
        `SELECT session_id FROM outbox WHERE channel = 'lark' AND status IN ('pending', 'sending')`,
      )
      if (pending.length === 0) return false
      if (!chatId) return true
      const bindingRows = db.all<{
        session_id: string | null
        project_id: string | null
      }>(
        `SELECT session_id, project_id FROM channel_bindings WHERE channel = 'lark' AND external_id = ?`,
        chatId,
      )
      const ownedSessionIds = new Set<string>()
      const projectIds = new Set<string>()
      for (const row of bindingRows) {
        if (row.session_id) ownedSessionIds.add(row.session_id)
        if (row.project_id) projectIds.add(row.project_id)
      }
      for (const projectId of projectIds) {
        const projectSessions = db.all<{ id: string }>(
          'SELECT id FROM sessions WHERE project_id = ?',
          projectId,
        )
        for (const s of projectSessions) ownedSessionIds.add(s.id)
      }
      return pending.some((row) => ownedSessionIds.has(row.session_id))
    }

    let disposing: Promise<void> | undefined
    let settingsApiPromise: Promise<VelaRuntime['settings']> | undefined
    const getSettingsApi = (): Promise<VelaRuntime['settings']> => {
      settingsApiPromise ??= import('./daemon/settings-discovery.ts').then(
        (svc) =>
          svc.createRuntimeSettingsApi({
            agentDir,
            hostEnv,
            runtime: runtimeHandle,
            ephemeral: isEphemeral,
            credentials,
            hasCustomCredentials: options.credentials !== undefined,
            extraProviders: options.providers,
            blockLocalOnlyOAuth: options.allowLocalOnlyOAuth === false,
            directModel: Boolean(options.defaultModel),
            isLarkLoaded: options.isLarkLoaded,
            isLarkEnabledInDb: () => isChannelEnabledInDb(db, 'lark'),
            getLarkConfigError: options.getLarkConfigError,
            pauseLark: options.onPauseLarkForDiscovery,
            resumeLark: options.onResumeLarkFromDiscovery,
            createDiscoveryTransport: options.onCreateLarkDiscoveryTransport,
            verifyCredentials: options.onVerifyLarkCredentials,
            hasPendingOutboxDeliveries,
          }),
      )
      return settingsApiPromise
    }

    const runtimeHandle: LocalVelaRuntime = {
      agentDir: engine.agentDir,
      ready: () => velaDriver.control.ready(),
      extensionErrors: async () => {
        await maybeRefreshConfig()
        return velaDriver.control.extensionErrors()
      },
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
        delete: async (id) => {
          await velaDriver.control.closeSession(id).catch(() => {})
          return engine.sessions.delete(id)
        },
        reset: async (id) => {
          await velaDriver.control.closeSession(id).catch(() => {})
          return engine.restartSession(id)
        },
        status: async (id) => engine.sessions.status(id),
        messages: (input) => engine.listSessionMessages(input),
        configure: async (sessionId, override) => {
          await maybeRefreshConfig()
          await velaDriver.control.configure(sessionId, override)
        },
        setModel: async (sessionId, modelRef) => {
          await maybeRefreshConfig()
          return velaDriver.control.setModel(sessionId, modelRef)
        },
        setThinkingLevel: async (sessionId, level) => {
          await maybeRefreshConfig()
          return velaDriver.control.setThinkingLevel(sessionId, level)
        },
        compact: async (sessionId, instructions) => {
          await maybeRefreshConfig()
          return velaDriver.control.compact(sessionId, instructions)
        },
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
        execBash: async (sessionId, command, opts) => {
          await maybeRefreshConfig()
          return velaDriver.control.execBash(sessionId, command, opts)
        },
        abortBash: async (sessionId) => {
          velaDriver.control.abortBash(sessionId)
        },
        runCommand: async (sessionId, input) => {
          await maybeRefreshConfig()
          return velaDriver.control.runCommand(sessionId, input)
        },
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
      steer: async (sessionId, text, images) => {
        await engine.steerSession(sessionId, text, images)
      },
      stop: (sessionId, reason, opts) =>
        engine.stopSession(sessionId, reason, opts),
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
        delete: async (id, filter) => engine.timers.delete(id, filter),
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
      channels: {
        list: async () => {
          const info = options.getKnownChannelInfo?.()
          return engine.listChannelStatuses(info?.names, info?.errors)
        },
        setEnabled: async (name, enabled) => {
          engine.setChannelEnabled(name, enabled)
          await options.onChannelEnabledChange?.(name, enabled)
          const info = options.getKnownChannelInfo?.()
          return (
            engine
              .listChannelStatuses([name, ...(info?.names ?? [])], info?.errors)
              .find((row) => row.name === name) ?? {
              name,
              enabled,
              connected: false,
            }
          )
        },
        chats: (channel) => engine.listChannelChats(channel),
        submit: (channel, input) =>
          engine.submitChannelHostMessage(channel, input),
        subscribe: (listener) => engine.subscribeChannelEvents(listener),
      },
      settings: {
        get: () => getSettingsApi().then((s) => s.get()),
        saveModel: (input) => getSettingsApi().then((s) => s.saveModel(input)),
        saveLark: (input) => getSettingsApi().then((s) => s.saveLark(input)),
        discoverLarkGroup: (opts) =>
          getSettingsApi().then((s) => s.discoverLarkGroup(opts)),
        confirmLarkGroup: (chatId) =>
          getSettingsApi().then((s) => s.confirmLarkGroup(chatId)),
        cancelLarkSetup: () =>
          settingsApiPromise
            ? settingsApiPromise.then((s) => s.cancelLarkSetup())
            : Promise.resolve(),
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
        let registry = models
        if (opts?.env) {
          const updated = computeConfigState()
          const effectiveEnv = { ...hostEnv, ...opts.env }
          const overlaid = loadModels({
            agentDir,
            env: effectiveEnv,
            providers: updated.configProviders,
          })
          registry = new ModelRegistry(
            { ...models.providerDefinitions(), ...overlaid },
            credentials,
            registrations,
            { blockLocalOnlyOAuth: models.blocksLocalOnlyOAuth },
          )
        }
        return opts?.all
          ? registry.list(opts.channel)
          : registry.available(opts?.channel)
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
      ingestWebhookEvent: async (event, defaultTarget) =>
        engine.ingestWebhookEvent(event, defaultTarget),
      getWebhookConfig: () => ({ ...currentWebhookConfig }),
      getLarkConfig: () => ({ ...currentLarkConfig }),
      reconcileProjectSessions: async (
        projectId: string,
        fields?: {
          location?: boolean
          model?: boolean
          thinkingLevel?: boolean
          topicModel?: boolean
          topicThinkingLevel?: boolean
        },
      ) => {
        const project = engine.projects.get(projectId)
        if (project) engine.sessions.reconcileProjectDefaults(project, fields)
      },
      dispose() {
        disposing ??= (async () => {
          if (settingsApiPromise) {
            await settingsApiPromise
              .then((s) => s.cancelLarkSetup())
              .catch(() => {})
          }
          try {
            await reloadQueue.catch(() => {})
            await engine.dispose()
          } finally {
            if (ownsDb && db.open) db.close()
            if (transientAgentDir) {
              rmSync(transientAgentDir, { recursive: true, force: true })
            }
            if (transientSpillRoot) {
              rmSync(transientSpillRoot, { recursive: true, force: true })
            }
          }
        })()
        return disposing
      },
    }
    registerRuntimeSettingsHooksResolver(runtimeHandle, () =>
      getSettingsApi().then((s) =>
        import('./daemon/settings-discovery.ts').then(
          (m) => m.getSettingsOwnerHooks(s)!,
        ),
      ),
    )
    return runtimeHandle
  } catch (error) {
    if (ownsDb && db.open) db.close()
    if (transientAgentDir) {
      rmSync(transientAgentDir, { recursive: true, force: true })
    }
    if (transientSpillRoot) {
      rmSync(transientSpillRoot, { recursive: true, force: true })
    }
    throw error
  }
}
