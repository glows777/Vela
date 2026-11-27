import { join } from 'node:path'
import type { VelaDatabase } from '../db/index.ts'
import { canonicalLocalPath, savedTrust } from '../db/trust.ts'
import type { OAuthRegistrationStore } from '../providers/auth/types.ts'
import {
  DEFAULT_THINKING_LEVEL,
  ModelRegistry,
  type ResolvedModel,
  resolveModelInput,
  type ThinkingLevel,
} from '../providers/models/index.ts'
import { loadModels, type ProviderConfig } from '../providers/models-config.ts'
import { getActiveChannelForSession } from '../runtime/control-ops.ts'
import type { SessionRecord } from '../runtime/domain.ts'
import type { DriverTurnResult } from '../runtime/driver.ts'
import {
  MEMORY_RULES,
  type MemoryDirs,
  type MemoryRegistry,
  type MemoryStore,
} from '../runtime/memory/index.ts'
import type { VelaLogger } from '../shared/logger.ts'
import type { ModelInput } from '../shared/provider-types.ts'
import { mergeDefaultTools, selectTools } from '../shared/tool-selection.ts'
import {
  loadProjectSettings,
  type ProjectSettings,
} from './config/project-settings.ts'
import { createSessionLocalExecutionEnv } from './execution/local.ts'
import { resolveLocation } from './execution/location.ts'
import type { ExecutionEnv, ExecutionLocation } from './execution/types.ts'
import type { ExtensionRunner } from './extensions/runner.ts'
import type { MemoryDream } from './memory/dream.ts'
import type { ModelMessage } from './messages.ts'
import { localDateString } from './prompt/environment.ts'
import type { SystemPromptBuilder } from './prompt/index.ts'
import type { RuntimeBackgroundController } from './runtime-background.ts'
import {
  type RuntimeExtensionHost,
  resolveEffectiveDisabledBuiltins,
} from './runtime-extensions.ts'
import {
  buildRuntimePromptSections,
  preserveChannelControlTools,
  runtimeToolModifiers,
} from './runtime-prompt.ts'
import {
  loadTrustedRuntimeResources,
  resolveRuntimeMemoryStores,
  type TrustedRuntimeResources,
} from './runtime-resources.ts'
import {
  adaptChannelTools,
  createRuntimeSessionToolRegistry,
} from './runtime-tools.ts'
import { applyRuntimeProjectToolSelection } from './runtime-turn.ts'
import type {
  ActiveRunMeta,
  RuntimeMcpLease,
  RuntimeReloadableConfig,
  RuntimeSessionOverride,
  RuntimeSpecialModelHandle,
  VelaAgentDriverOptions,
} from './runtime-types.ts'
import type { BashExecutionEntry } from './session/entries.ts'
import type { SessionStore } from './session/index.ts'
import { createSessionPrompt } from './session/prompt-builder.ts'
import { ToolRegistry } from './tools/registry.ts'
import type { VelaSession } from './vela-session.ts'

export interface CachedSessionRunner {
  key: string
  runner: ExtensionRunner
  registry: ToolRegistry
  errors: string[]
  releaseHost: () => void
  started: boolean
  lastView?: VelaSession
  refs: number
  retired?: boolean
}

async function disposeCachedSessionRunner(
  entry: CachedSessionRunner,
): Promise<void> {
  try {
    if (entry.started && entry.lastView) {
      await entry.runner.sessionShutdown(entry.lastView).catch(() => {})
    }
    await entry.runner.shutdown().catch(() => {})
  } finally {
    entry.releaseHost()
  }
}

export async function retireOrDisposeCachedRunner(
  entry: CachedSessionRunner,
): Promise<void> {
  entry.retired = true
  if (entry.refs === 0) {
    await disposeCachedSessionRunner(entry)
  }
}

async function releaseCachedSessionRunner(
  entry: CachedSessionRunner,
): Promise<void> {
  entry.refs = Math.max(0, entry.refs - 1)
  if (entry.retired && entry.refs === 0) {
    await disposeCachedSessionRunner(entry)
  }
}

function withSessionRunnerLock<T>(
  state: DriverSharedState,
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = state.sessionRunnerLocks.get(sessionId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  const tail = next.then(
    () => {
      if (state.sessionRunnerLocks.get(sessionId) === tail) {
        state.sessionRunnerLocks.delete(sessionId)
      }
    },
    () => {
      if (state.sessionRunnerLocks.get(sessionId) === tail) {
        state.sessionRunnerLocks.delete(sessionId)
      }
    },
  )
  state.sessionRunnerLocks.set(sessionId, tail)
  return next
}

export async function disposeDriverSharedState(
  state: DriverSharedState,
): Promise<void> {
  if (state.disposed) return
  state.disposed = true
  state.disposeController.abort(
    new DOMException('Driver disposed', 'AbortError'),
  )
  for (const controller of state.activeAbort.values()) {
    controller.abort(new DOMException('Driver disposed', 'AbortError'))
  }
  for (const controller of state.activeBash.values()) {
    controller.abort(new DOMException('Driver disposed', 'AbortError'))
  }
  await Promise.allSettled([...state.activeTurns])
  await Promise.allSettled([...state.activeBashPromises])
  await Promise.allSettled(
    [...state.activeDreams.values()].map((d) => d.stop()),
  )
  await Promise.allSettled([...state.pendingDreamTasks])
  state.activeDreams.clear()
  await Promise.allSettled(
    [...state.sessionBackgrounds.values()].map((bg) => bg.stopAll()),
  )
  state.sessionBackgrounds.clear()
  await Promise.allSettled(
    [...state.activeMcpLeases].map((lease) => lease.release()),
  )
  state.activeMcpLeases.clear()
  await Promise.allSettled(
    [...state.specialModels.values()].map((s) => s.flush?.()),
  )
  state.specialModels.clear()
  const runners = [...state.sessionRunners.values()]
  state.sessionRunners.clear()
  state.sessionResourceSnapshots.clear()
  state.sessionActiveTools.clear()
  await Promise.allSettled(
    runners.map((entry) => retireOrDisposeCachedRunner(entry)),
  )
  await state.options.mcp?.dispose?.()
  await state.extHost.shutdown().catch(() => {})
}

export interface DriverSharedState {
  options: VelaAgentDriverOptions
  db: VelaDatabase
  logger: VelaLogger
  models: ModelRegistry
  registrations?: OAuthRegistrationStore
  rawConfigProviders?: Record<string, ProviderConfig>
  memoryRegistry: MemoryRegistry
  extHost: RuntimeExtensionHost
  reloadable: Required<Pick<RuntimeReloadableConfig, 'offline'>> &
    Omit<RuntimeReloadableConfig, 'offline'>
  sessionOverrides: Map<string, RuntimeSessionOverride>
  specialModels: Map<string, RuntimeSpecialModelHandle>
  sessionRunners: Map<string, CachedSessionRunner>
  sessionRunnerLocks: Map<string, Promise<void>>
  sessionActiveTools: Map<string, string[] | undefined>
  sessionResourceSnapshots: Map<
    string,
    {
      key: string
      resources: TrustedRuntimeResources
      projectSettings?: ProjectSettings
    }
  >
  activeAbort: Map<string, AbortController>
  activeSteering: Map<string, ModelMessage[]>
  activeRunMeta: Map<string, ActiveRunMeta>
  sessionBackgrounds: Map<string, RuntimeBackgroundController>
  pendingBashBySession: Map<string, BashExecutionEntry[]>
  activeBash: Map<string, AbortController>
  activeBashPromises: Set<Promise<unknown>>
  activeDreams: Map<string, MemoryDream>
  pendingDreamTasks: Set<Promise<void>>
  activeMcpLeases: Set<RuntimeMcpLease>
  activeTurns: Set<Promise<DriverTurnResult>>
  disposeController: AbortController
  disposed: boolean
}

export interface PreparedSessionEnv {
  location: ExecutionLocation
  boundChannel?: string
  hasChannelBinding: boolean
  sessionKind: SessionRecord['kind']
  createdAt: string
  sessionName?: string
  effectiveEnv: Record<string, string | undefined>
  effectiveOffline: boolean
  activeModels: ModelRegistry
  override?: RuntimeSessionOverride
  modelInput?: ModelInput
  specialModel?: RuntimeSpecialModelHandle
  resolved?: ResolvedModel
  modelError?: string
  thinkingLevel: ThinkingLevel
  spillDir: string
  resolveEnv: () => Promise<ExecutionEnv>
  resources: TrustedRuntimeResources
  enabledModels?: string[]
  projectDefaultTools?: string[]
  registry: ToolRegistry
  extensionRunner: ExtensionRunner
  ensureSessionStarted: (extView: VelaSession) => Promise<void>
  extensionErrors: string[]
  mcpLease?: RuntimeMcpLease
  memoryStores: { local: MemoryStore; global: MemoryStore; dirs: MemoryDirs }
  memoryActive: boolean
  builder: SystemPromptBuilder
  runtimeSections: Record<string, string>
  releaseSession: () => Promise<void>
}

function resolveEffectiveEnv(
  hostEnv: Record<string, string | undefined> | undefined,
  override?: RuntimeSessionOverride,
): Record<string, string | undefined> {
  if (!override?.env) return hostEnv ?? {}
  return { ...(hostEnv ?? {}), ...override.env }
}

export function resolveSessionModels(
  state: DriverSharedState,
  override?: RuntimeSessionOverride,
): ModelRegistry {
  if (!override?.env) return state.models
  const effectiveEnv = resolveEffectiveEnv(state.options.hostEnv, override)
  const overlaid = loadModels({
    agentDir: state.options.agentDir,
    env: effectiveEnv,
    providers: state.rawConfigProviders ?? {},
  })
  const merged: Record<string, (typeof overlaid)[string]> = {
    ...state.models.providerDefinitions(),
    ...overlaid,
  }
  return new ModelRegistry(
    merged,
    state.models.credentials,
    state.registrations,
  )
}

export async function prepareSessionSetup(params: {
  state: DriverSharedState
  sessionId: string
  projectId: string | null
  runId?: string
  saved?: Awaited<ReturnType<SessionStore['loadSaved']>>
  store: SessionStore
  messages: ModelMessage[]
  signal: AbortSignal
  attachMcp?: boolean
  allowNoModel?: boolean
  buildSystem?: () => string
  wakeSession?: (sessionId: string) => void
  flushOutbox?: () => void
}): Promise<PreparedSessionEnv> {
  const {
    state,
    sessionId,
    projectId,
    runId,
    saved,
    signal,
    attachMcp = true,
    allowNoModel = false,
    wakeSession,
    flushOutbox,
  } = params
  const override = state.sessionOverrides.get(sessionId)
  const location: ExecutionLocation = resolveLocation(
    saved?.location ??
      (override?.cwd ? { environment: 'local', cwd: override.cwd } : undefined),
  )
  const resolvedChannelTools = state.options.getChannelTools?.(sessionId, runId)
  const boundChannel =
    resolvedChannelTools?.binding.channel ??
    getActiveChannelForSession(state.db, sessionId, runId) ??
    saved?.channel
  const hasChannelBinding = Boolean(boundChannel)
  const effectiveEnv = resolveEffectiveEnv(state.options.hostEnv, override)
  const effectiveOffline =
    override?.env?.VELA_OFFLINE !== undefined
      ? ['1', 'true', 'yes'].includes(override.env.VELA_OFFLINE.toLowerCase())
      : state.reloadable.offline
  const activeModels = resolveSessionModels(state, override)

  const sessionRow = state.db.get<{
    kind: string
    created_at: string
    name: string | null
  }>('SELECT kind, created_at, name FROM sessions WHERE id = ?', sessionId)
  const sessionKind = (sessionRow?.kind ??
    (projectId ? 'work' : 'chat')) as SessionRecord['kind']
  const networkMode = state.options.environments.networkMode(
    location.environment,
  )

  const spillDir = state.options.spillRoot
    ? join(state.options.spillRoot, sessionId, 'tool-results')
    : join(state.options.agentDir, 'sessions', sessionId, 'tool-results')
  const resolveEnv = async (): Promise<ExecutionEnv> => {
    if (location.environment === 'local') {
      return createSessionLocalExecutionEnv({
        cwd: location.cwd,
        tempRoot: spillDir,
      })
    }
    const resolvedEnv = await state.options.environments.resolve({
      sessionId,
      location,
    })
    if (!resolvedEnv) {
      throw new Error(
        `Execution environment unavailable for ${location.environment}:${location.cwd}`,
      )
    }
    return resolvedEnv
  }

  const memoryStores = resolveRuntimeMemoryStores({
    registry: state.memoryRegistry,
    agentDir: state.options.agentDir,
    projectId,
    cwd: location.cwd,
  })

  const approveApplies =
    override?.approve === false ||
    (override?.approve === true &&
      (!override.approveLocation ||
        (location.environment === 'local' &&
          canonicalLocalPath(location.cwd) ===
            canonicalLocalPath(override.approveLocation))))
  const trustOverride = approveApplies
    ? override!.approve
    : state.options.trustOverride
      ? await state.options.trustOverride(location)
      : undefined
  const savedTrustState = savedTrust(
    state.db,
    location,
    state.options.environments.dataDir,
  )
  const resourceSnapshotKey = JSON.stringify([
    location.environment,
    location.cwd,
    savedTrustState ?? null,
    trustOverride ?? null,
    override?.systemPrompt ?? state.options.systemPrompt ?? null,
    override?.appendSystemPrompt ?? state.options.appendSystemPrompt ?? null,
    Boolean(override?.noContextFiles),
    Boolean(override?.loadUntrustedContextFiles),
    effectiveEnv,
  ])
  let cachedSnapshot = state.sessionResourceSnapshots.get(sessionId)
  if (!cachedSnapshot || cachedSnapshot.key !== resourceSnapshotKey) {
    const resources = await loadTrustedRuntimeResources({
      db: state.db,
      agentDir: state.options.agentDir,
      trustDataDir: state.options.environments.dataDir,
      location,
      resolveEnv,
      signal,
      systemPrompt: override?.systemPrompt ?? state.options.systemPrompt,
      appendSystemPrompt:
        override?.appendSystemPrompt ?? state.options.appendSystemPrompt,
      hostContextFiles: override?.noContextFiles
        ? []
        : state.options.contextFiles,
      hostSkills: state.options.skills,
      hostPromptTemplates: state.options.promptTemplates,
      hostEnv: effectiveEnv,
      trustOverride,
      loadUntrustedContextFiles: override?.loadUntrustedContextFiles,
    })
    if (override?.noContextFiles) {
      resources.contextFiles = []
    }

    let projectSettings: ProjectSettings | undefined
    if (resources.trusted) {
      const env = await resolveEnv()
      projectSettings = await loadProjectSettings(env, {
        cwd: location.cwd,
        trusted: true,
        agentDir: state.options.agentDir,
        env: location.environment === 'local' ? effectiveEnv : {},
        signal,
      })
    }
    cachedSnapshot = {
      key: resourceSnapshotKey,
      resources,
      projectSettings,
    }
    state.sessionResourceSnapshots.set(sessionId, cachedSnapshot)
  }
  const { resources, projectSettings } = cachedSnapshot

  const specialModel = state.specialModels.get(sessionId)
  const modelInput: ModelInput | undefined =
    specialModel?.model ??
    override?.model ??
    saved?.model ??
    projectSettings?.settings.model ??
    state.reloadable.defaultModel ??
    activeModels.defaultRef(boundChannel)

  let resolved: ResolvedModel | undefined
  let modelError: string | undefined
  if (!modelInput) {
    if (!allowNoModel) {
      throw new Error(`No model configured for session ${sessionId}`)
    }
    modelError = `No model configured for session ${sessionId}`
  } else {
    try {
      resolved = resolveModelInput(activeModels, modelInput, () => boundChannel)
    } catch (error) {
      if (!allowNoModel) throw error
      modelError = error instanceof Error ? error.message : String(error)
    }
  }

  const thinkingLevel =
    override?.thinkingLevel ??
    saved?.thinkingLevel ??
    projectSettings?.settings.thinkingLevel ??
    state.reloadable.defaultThinkingLevel ??
    DEFAULT_THINKING_LEVEL

  const extensionConfig = state.reloadable.extensionConfig ?? {}
  const hostLease = await state.extHost.acquireHostSnapshot()
  const projectExtensions = projectSettings?.settings.extensions ?? []
  const extraExtensions = override?.extensions ?? []
  const noExtensions = Boolean(override?.noExtensions)
  const effectiveDisabledBuiltins = resolveEffectiveDisabledBuiltins({
    hostDisabled: hostLease.snapshot.disabledBuiltins,
    projectExtensions,
    extraExtensions,
    noExtensions,
  })
  const runnerKey = JSON.stringify([
    location.environment,
    location.cwd,
    resources.trusted,
    projectExtensions,
    extraExtensions,
    noExtensions,
    hostLease.snapshot.generation,
    extensionConfig,
  ])
  const cachedRunner = await withSessionRunnerLock(
    state,
    sessionId,
    async () => {
      let existing = state.sessionRunners.get(sessionId)
      if (existing && existing.key === runnerKey) {
        hostLease.release()
        existing.refs += 1
        return existing
      }
      if (existing) {
        state.sessionRunners.delete(sessionId)
        await retireOrDisposeCachedRunner(existing)
      }
      const sessionExtRegistry = new ToolRegistry(
        undefined,
        undefined,
        noExtensions ? undefined : hostLease.snapshot.registry,
      )
      let created:
        | Awaited<ReturnType<RuntimeExtensionHost['createSessionRunner']>>
        | undefined
      try {
        created = await state.extHost.createSessionRunner({
          cwd: location.cwd,
          trusted: resources.trusted,
          isLocalLocation: location.environment === 'local',
          projectExtensions,
          extraExtensions,
          noExtensions,
          extensionConfig,
          registry: sessionExtRegistry,
          hostSnapshot: hostLease.snapshot,
        })
      } catch (error) {
        hostLease.release()
        throw error
      }
      existing = {
        key: runnerKey,
        runner: created.runner,
        registry: sessionExtRegistry,
        errors: created.errors,
        releaseHost: hostLease.release,
        started: false,
        refs: 1,
      }
      state.sessionRunners.set(sessionId, existing)
      return existing
    },
  )
  let releasedRunner = false
  const releaseSession = async (): Promise<void> => {
    if (releasedRunner) return
    releasedRunner = true
    await releaseCachedSessionRunner(cachedRunner)
  }
  const extensionRunner = cachedRunner.runner
  const extensionErrors = cachedRunner.errors
  let refreshRuntimeSections = () => {}
  const ensureSessionStarted = async (extView: VelaSession): Promise<void> => {
    cachedRunner.lastView = extView
    if (cachedRunner.started) return
    cachedRunner.started = true
    await cachedRunner.runner.sessionStart(extView)
    refreshRuntimeSections()
  }

  const channelTools = adaptChannelTools(
    resolvedChannelTools,
    sessionId,
    projectId,
    state.db,
  )
  const extraTools =
    channelTools.length > 0
      ? [...(state.options.tools ?? []), ...channelTools]
      : state.options.tools

  const registry = createRuntimeSessionToolRegistry({
    spillDir,
    cwd: location.cwd,
    logger: state.logger,
    memoryGlobal: memoryStores.global,
    memoryLocal: () => memoryStores.local,
    webConfig: extensionConfig.web,
    hostEnv: effectiveEnv,
    offline: effectiveOffline,
    disabledBuiltins: effectiveDisabledBuiltins,
    ...(state.options.timers &&
    state.options.subscriptions &&
    state.options.eventBus
      ? {
          runtimeToolDeps: {
            db: state.db,
            blobs: state.options.blobs,
            eventBus: state.options.eventBus,
            timers: state.options.timers,
            subscriptions: state.options.subscriptions,
            scheduleSession:
              wakeSession ?? state.options.wakeSession ?? (() => {}),
            flushOutbox: flushOutbox ?? state.options.flushOutbox,
            getRunContext: (sid) => state.activeRunMeta.get(sid),
          },
        }
      : {}),
    extraTools,
    parentRegistry: cachedRunner.registry,
  })

  let mcpLease: RuntimeMcpLease | undefined
  if (attachMcp && state.options.mcp && !effectiveDisabledBuiltins.has('mcp')) {
    mcpLease = await state.options.mcp.attach({
      registry,
      agentDir: state.options.agentDir,
      cwd: location.cwd,
      environment: location.environment,
      trusted: resources.trusted,
      env: effectiveEnv,
      discoveredTools: saved?.discoveredTools,
      signal,
    })
    state.activeMcpLeases.add(mcpLease)
  }

  if (boundChannel) {
    registry.setChannel(boundChannel)
  }
  registry.setRestrictedNetwork(networkMode !== 'on')
  const baseModifiers = runtimeToolModifiers({
    kind: sessionKind,
    projectId,
    hasChannelBinding,
    networkMode,
  })
  applyRuntimeProjectToolSelection(
    state.db,
    registry,
    projectId,
    baseModifiers,
    { hasChannelBinding, sessionKind },
  )

  const ownerTools = state.reloadable.defaultTools
    ? [...state.reloadable.defaultTools]
    : undefined
  const projectDefaultTools = projectSettings?.settings.tools
  const mergedDefaultTools = mergeDefaultTools(ownerTools, projectDefaultTools)
  if (
    override?.tools !== undefined ||
    override?.noTools ||
    (override?.excludeTools && override.excludeTools.length > 0) ||
    mergedDefaultTools !== undefined
  ) {
    const candidateNames = new Set(registry.getAllTools().map((t) => t.name))
    if (saved?.discoveredTools.length) {
      for (const name of saved.discoveredTools) candidateNames.add(name)
    }
    if (!attachMcp && !effectiveDisabledBuiltins.has('mcp')) {
      for (const name of [
        ...(override?.tools ?? []),
        ...(override?.excludeTools ?? []),
        ...(mergedDefaultTools ?? []),
      ]) {
        if (name.startsWith('mcp_')) candidateNames.add(name)
      }
    }
    const loadout = selectTools(
      [...candidateNames],
      {
        tools: override?.tools,
        noTools: override?.noTools,
        excludeTools: override?.excludeTools,
      },
      mergedDefaultTools,
    )
    if (loadout?.selection) {
      const finalSelection =
        override?.tools === undefined && !override?.noTools
          ? preserveChannelControlTools(loadout.selection, {
              hasChannelBinding,
              sessionKind,
              projectId,
              excludeTools: override?.excludeTools,
            })
          : loadout.selection
      registry.setSelection(finalSelection)
    } else if (loadout?.modifiers) {
      registry.setDefaultToolModifiers([...baseModifiers, ...loadout.modifiers])
    }
  }
  // Project defaultTools (e.g. per-chat Lark `tools`) takes precedence over global/workspace tool lists
  // unless an explicit per-run override selected tools.
  if (override?.tools === undefined && !override?.noTools) {
    applyRuntimeProjectToolSelection(
      state.db,
      registry,
      projectId,
      baseModifiers,
      { hasChannelBinding, sessionKind, onlyIfConfigured: true },
    )
  }

  if (state.sessionActiveTools.has(sessionId)) {
    registry.setSelection(state.sessionActiveTools.get(sessionId))
  }

  if (saved?.discoveredTools.length) {
    registry.discoveredTools = new Set(saved.discoveredTools)
  }

  const pinnedDate = localDateString(
    new Date(sessionRow?.created_at ?? Date.now()),
  )
  const builder = createSessionPrompt(
    () => ({
      systemPrompt: resources.systemPrompt,
      appendSystemPrompt: resources.appendSystemPrompt,
      contextFiles: resources.contextFiles,
      skills: resources.skills,
      promptTemplates: resources.promptTemplates,
    }),
    () => location.cwd,
    () => undefined,
    location.environment === 'local' ? state.options.docsPaths : false,
    () => location.environment === 'local',
    () => state.options.environments.osFor(location.environment),
    () => pinnedDate,
  )
  let memoryActive = false
  let runtimeSections: Record<string, string> = {}
  refreshRuntimeSections = () => {
    const currentTools = registry.getActiveTools()
    const currentNames = new Set(currentTools.map((t) => t.name))
    memoryActive = currentNames.has('memory')
    runtimeSections = {
      ...buildRuntimePromptSections({
        kind: sessionKind,
        projectId,
        hasChannelBinding,
        activeTools: currentNames,
        githubRepositories: state.reloadable.githubRepositories,
      }),
      ...(memoryActive ? { memory: MEMORY_RULES } : {}),
    }
  }
  refreshRuntimeSections()

  return {
    location,
    boundChannel,
    hasChannelBinding,
    sessionKind,
    createdAt: sessionRow?.created_at ?? new Date().toISOString(),
    sessionName: sessionRow?.name ?? saved?.name,
    effectiveEnv,
    effectiveOffline,
    activeModels,
    override,
    modelInput,
    specialModel,
    resolved,
    modelError,
    thinkingLevel,
    spillDir,
    resolveEnv,
    resources,
    enabledModels:
      projectSettings?.settings.enabledModels ??
      (state.reloadable.enabledModels
        ? [...state.reloadable.enabledModels]
        : undefined),
    projectDefaultTools,
    registry,
    extensionRunner,
    ensureSessionStarted,
    extensionErrors,
    mcpLease,
    memoryStores,
    get memoryActive() {
      return memoryActive
    },
    builder,
    get runtimeSections() {
      return runtimeSections
    },
    releaseSession,
  }
}
