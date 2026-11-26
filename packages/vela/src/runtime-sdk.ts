import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDatabase, type VelaDatabase } from './db/index.ts'
import { defaultAgentDir } from './driver/config/paths.ts'
import type { ExecutionLocation } from './driver/execution/types.ts'
import type { ContextFile } from './driver/prompt/context-files.ts'
import type { PromptTemplate } from './driver/prompt/templates.ts'
import {
  createVelaAgentDriver,
  type RuntimeMcpAdapter,
} from './driver/runtime-adapter.ts'
import type { SkillDefinition } from './driver/skills/loader.ts'
import type { ToolDefinition } from './driver/tools/registry.ts'
import {
  fileCredentialStore,
  memoryCredentialStore,
} from './providers/auth/store.ts'
import type {
  AuthInteraction,
  CredentialStore,
  LoginOptions,
  LogoutOptions,
  LogoutResult,
} from './providers/auth/types.ts'
import {
  type LoginProvider,
  type ModelInfo,
  ModelRegistry,
  type ProviderDefinition,
  type ThinkingLevel,
} from './providers/models/index.ts'
import { loadModels } from './providers/models-config.ts'
import {
  type AgentDriver,
  type ApprovalRecord,
  type BlobDirection,
  type BlobRecord,
  type ChannelAdapter,
  type ChannelBinding,
  type CreateProjectInput,
  type CreateSessionInput,
  EnvironmentRegistry,
  listRuntimeSessionMessages,
  type ProjectRecord,
  type RuntimeEvent,
  type RuntimeEventListener,
  type RuntimeMessagePage,
  type SessionRecord,
  type SessionStatusInfo,
  SqliteOAuthRegistrationStore,
  type StreamDeltaEvent,
  type StreamDeltaListener,
  type SubscriptionRecord,
  type TimerKind,
  type TimerRecord,
  type TimerTarget,
  type UpdateProjectInput,
  type UpsertChannelBindingInput,
  VelaRuntimeEngine,
} from './runtime/index.ts'
import type { VelaLimits } from './shared/limits.ts'
import { silentLogger, type VelaLogger } from './shared/logger.ts'
import type { ModelInput } from './shared/provider-types.ts'
import type { RoutineSchedule } from './shared/routine-time.ts'

export interface RuntimePromptInput {
  text: string
  dedupeKey?: string
  source?: 'user' | 'handoff' | 'session'
  wake?: boolean
  passive?: boolean
  attachments?: Array<{ blobId: string; name: string; mimeType?: string }>
  metadata?: Record<string, unknown>
}

export interface RuntimeRecoverySummary {
  interruptedJobs: string[]
  recoveredRuns: string[]
  requeuedInboxRuns: string[]
  wokenSessions: string[]
}

/**
 * Isomorphic Runtime SDK contract implemented identically by in-process `createRuntime()`
 * and S4a's daemon IPC `connectRuntime()`. Every method is async and JSON-serializable.
 */
export interface VelaRuntime {
  readonly agentDir: string
  readonly projects: {
    list(options?: { includeArchived?: boolean }): Promise<ProjectRecord[]>
    get(id: string): Promise<ProjectRecord | undefined>
    getByCwd(cwd: string): Promise<ProjectRecord | undefined>
    create(input: CreateProjectInput): Promise<ProjectRecord>
    update(id: string, patch: UpdateProjectInput): Promise<ProjectRecord>
    remove(id: string, options?: { deleteSessions?: boolean }): Promise<boolean>
  }
  readonly sessions: {
    list(options?: {
      projectId?: string | null
      includeArchived?: boolean
    }): Promise<SessionRecord[]>
    get(id: string): Promise<SessionRecord | undefined>
    create(input?: CreateSessionInput): Promise<SessionRecord>
    rename(id: string, name: string | null): Promise<SessionRecord>
    delete(id: string): Promise<boolean>
    reset(id: string): Promise<SessionRecord>
    status(id: string): Promise<SessionStatusInfo>
    messages(input: {
      sessionId: string
      cursor?: string
      limit?: number
    }): Promise<RuntimeMessagePage>
  }
  prompt(
    sessionId: string,
    input: RuntimePromptInput,
  ): Promise<{ eventId: string; inserted: boolean }>
  steer(sessionId: string, text: string): Promise<void>
  stop(sessionId: string, reason?: string): Promise<boolean>
  waitForIdle(sessionId?: string): Promise<void>
  readonly approvals: {
    list(sessionId?: string): Promise<ApprovalRecord[]>
    resolve(input: {
      approvalId: string
      decision: 'approved' | 'denied' | 'cancelled'
      reason?: string
      decidedBy?: string
    }): Promise<{ approval: ApprovalRecord; shouldWake: boolean }>
  }
  readonly timers: {
    list(filter?: {
      projectId?: string
      sessionId?: string
      kind?: TimerKind
      enabledOnly?: boolean
    }): Promise<TimerRecord[]>
    createRoutine(input: {
      id?: string
      projectId?: string | null
      sessionId?: string | null
      channel?: string | null
      target?: TimerTarget
      creatorId?: string | null
      creatorName?: string | null
      message: string
      schedule: RoutineSchedule
      timezone?: string
      nowMs?: number
    }): Promise<TimerRecord>
    createFollowup(input: {
      id?: string
      sessionId: string
      projectId?: string | null
      channel?: string | null
      target?: TimerTarget
      message: string
      fireAt: string
      creatorId?: string | null
      creatorName?: string | null
    }): Promise<TimerRecord>
    update(
      id: string,
      patch: {
        message?: string
        schedule?: RoutineSchedule
        timezone?: string
        enabled?: boolean
        nowMs?: number
      },
    ): Promise<TimerRecord | undefined>
    delete(id: string): Promise<boolean>
  }
  readonly subscriptions: {
    list(filter?: {
      sessionId?: string
      projectId?: string
      source?: string
    }): Promise<SubscriptionRecord[]>
    create(input: {
      id?: string
      source: string
      eventKey: string
      projectId?: string | null
      sessionId: string
      creatorId?: string | null
      creatorName?: string | null
    }): Promise<SubscriptionRecord>
    remove(id: string): Promise<boolean>
  }
  readonly bindings: {
    list(filter?: {
      channel?: string
      projectId?: string
      enabledOnly?: boolean
    }): Promise<ChannelBinding[]>
    get(id: string): Promise<ChannelBinding | undefined>
    upsert(input: UpsertChannelBindingInput): Promise<ChannelBinding>
    setEnabled(
      id: string,
      enabled: boolean,
    ): Promise<ChannelBinding | undefined>
    remove(id: string): Promise<boolean>
  }
  readonly blobs: {
    get(id: string): Promise<BlobRecord | undefined>
    list(sessionId: string, direction?: BlobDirection): Promise<BlobRecord[]>
    read(id: string): Promise<Uint8Array>
    storeInbound(input: {
      id?: string
      sessionId?: string | null
      projectId?: string | null
      messageId?: string | null
      filename: string
      mimeType?: string
      bytes?: Uint8Array
      hostPath?: string
    }): Promise<BlobRecord>
  }
  readonly events: {
    list(options?: {
      sessionId?: string
      projectId?: string
      afterSeq?: number
      limit?: number
    }): Promise<RuntimeEvent[]>
    bufferedDeltas(sessionId: string): Promise<StreamDeltaEvent[]>
    subscribe(listener: RuntimeEventListener): () => void
    subscribeDeltas(listener: StreamDeltaListener): () => void
  }
  models(options?: { all?: boolean; channel?: string }): Promise<ModelInfo[]>
  loginProviders(): Promise<LoginProvider[]>
  logout(provider: string, options?: LogoutOptions): Promise<LogoutResult>
  recover(): Promise<RuntimeRecoverySummary>
  dispose(): Promise<void>
}

/**
 * In-process Runtime handle returned by `createRuntime()`, extending `VelaRuntime`
 * with host-local registration hooks that are not sent across daemon IPC.
 */
export interface LocalVelaRuntime extends VelaRuntime {
  registerChannel(adapter: ChannelAdapter): Promise<void>
  unregisterChannel(name: string): Promise<void>
  registerDriver(driver: AgentDriver): void
  login(
    provider: string,
    method: 'oauth' | 'api_key',
    interaction: AuthInteraction,
    options?: LoginOptions,
  ): Promise<void>
}

export interface CreateRuntimeOptions {
  /** Root agent directory (`~/.vela`), owning `<agentDir>/vela.db` and `<agentDir>/blobs/`. */
  agentDir?: string
  /** Use an in-memory `:memory:` SQLite database instead of `<agentDir>/vela.db`. */
  ephemeral?: boolean
  /** @internal Pre-opened SQLite database for tests or daemon hosting. */
  db?: VelaDatabase
  /** Environment variables used for `$VAR` provider interpolation and default `VELA_DIR`. */
  hostEnv?: Record<string, string | undefined>
  providers?: Record<string, ProviderDefinition>
  credentials?: CredentialStore
  defaultModel?: ModelInput
  defaultThinkingLevel?: ThinkingLevel
  limits?: Partial<VelaLimits>
  tools?: ToolDefinition[]
  extensionConfig?: Record<string, Record<string, unknown>>
  contextFiles?: readonly ContextFile[]
  skills?: readonly SkillDefinition[]
  promptTemplates?: readonly PromptTemplate[]
  /** Enable per-project MCP pooling (lazy-loaded on first turn). Default `true`. */
  mcp?: boolean
  offline?: boolean
  dreamEnabled?: boolean
  environments?: EnvironmentRegistry
  drivers?: AgentDriver[]
  trustOverride?: (location: ExecutionLocation) => boolean | Promise<boolean>
  toolApprovalCheck?: (
    toolName: string,
    input: unknown,
    sessionId: string,
  ) =>
    | Promise<{ requireApproval?: boolean; summary?: string } | undefined>
    | { requireApproval?: boolean; summary?: string }
    | undefined
  logger?: VelaLogger
}

function createLazyRuntimeMcpAdapter(
  hostEnv: Record<string, string | undefined> | undefined,
  logger: VelaLogger,
): RuntimeMcpAdapter {
  let adapterPromise: Promise<RuntimeMcpAdapter> | undefined
  const loadAdapter = (): Promise<RuntimeMcpAdapter> => {
    adapterPromise ??= import('./mcp/runtime-adapter.ts').then((mod) =>
      mod.createRuntimeMcpAdapter({ hostEnv, logger }),
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

/**
 * Creates an in-process `LocalVelaRuntime` backed by `<agentDir>/vela.db` (or `:memory:` when `ephemeral: true`).
 * Implements the same `VelaRuntime` contract that S4a's `connectRuntime()` exposes over `vela.sock`.
 */
export function createRuntime(
  options: CreateRuntimeOptions = {},
): LocalVelaRuntime {
  const logger = options.logger ?? silentLogger
  const transientAgentDir =
    options.ephemeral && !options.agentDir
      ? mkdtempSync(join(tmpdir(), 'vela-runtime-'))
      : undefined
  const agentDir = resolve(
    options.agentDir ??
      transientAgentDir ??
      defaultAgentDir(options.hostEnv ?? {}),
  )
  const ownsDb = !options.db
  const db =
    options.db ??
    openDatabase({
      path: options.ephemeral ? ':memory:' : join(agentDir, 'vela.db'),
    })

  try {
    const credentials =
      options.credentials ??
      (options.ephemeral
        ? memoryCredentialStore()
        : fileCredentialStore(join(agentDir, 'auth.json')))
    const providers =
      options.providers ??
      loadModels({
        agentDir,
        env: options.hostEnv ?? {},
      })
    const registrations = new SqliteOAuthRegistrationStore(db)
    const models = new ModelRegistry(providers, credentials, registrations)
    const environments =
      options.environments ??
      new EnvironmentRegistry({
        dataDir: agentDir,
        hostEnv: options.hostEnv,
      })
    const mcpAdapter =
      options.mcp === false
        ? undefined
        : createLazyRuntimeMcpAdapter(options.hostEnv, logger)

    const engine = new VelaRuntimeEngine({
      db,
      agentDir,
      environments,
      drivers: options.drivers,
      logger,
    })

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
      mcp: mcpAdapter,
      defaultModel: options.defaultModel,
      defaultThinkingLevel: options.defaultThinkingLevel,
      providers,
      credentials,
      models,
      limits: options.limits,
      tools: options.tools,
      extensionConfig: options.extensionConfig,
      hostEnv: options.hostEnv,
      contextFiles: options.contextFiles,
      skills: options.skills,
      promptTemplates: options.promptTemplates,
      offline: options.offline,
      dreamEnabled: options.dreamEnabled,
      trustOverride: options.trustOverride,
      toolApprovalCheck: options.toolApprovalCheck,
      logger,
    })
    engine.registerDriver(velaDriver)

    let disposing: Promise<void> | undefined

    return {
      agentDir: engine.agentDir,
      projects: {
        list: async (opts) => engine.projects.list(opts),
        get: async (id) => engine.projects.get(id),
        getByCwd: async (cwd) => engine.projects.getByCwd(cwd),
        create: async (input) => engine.projects.create(input),
        update: async (id, patch) => engine.projects.update(id, patch),
        remove: async (id, opts) => engine.projects.remove(id, opts),
      },
      sessions: {
        list: async (opts) => engine.sessions.list(opts),
        get: async (id) => engine.sessions.get(id),
        create: async (input) => engine.sessions.create(input),
        rename: async (id, name) => engine.sessions.rename(id, name),
        delete: async (id) => engine.sessions.delete(id),
        reset: (id) => engine.restartSession(id),
        status: async (id) => engine.sessions.status(id),
        messages: async (input) => listRuntimeSessionMessages(db, input),
      },
      prompt: async (sessionId, input) => {
        const res = engine.submitPrompt({ sessionId, ...input })
        return { eventId: res.event.id, inserted: res.inserted }
      },
      steer: (sessionId, text) => engine.steerSession(sessionId, text),
      stop: (sessionId, reason) => engine.stopSession(sessionId, reason),
      waitForIdle: (sessionId) => engine.waitForIdle(sessionId),
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
      models: async (opts) =>
        opts?.all ? models.list(opts.channel) : models.available(opts?.channel),
      loginProviders: async () => models.loginProviders(),
      login: (provider, method, interaction, loginOptions) =>
        models.login(provider, method, interaction, loginOptions),
      logout: (provider, logoutOptions) =>
        models.logout(provider, logoutOptions),
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
