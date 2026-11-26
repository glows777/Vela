import { join } from 'node:path'
import type { VelaDatabase } from '../db/index.ts'
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
import { selectTools } from '../shared/tool-selection.ts'
import { loadProjectSettings } from './config/project-settings.ts'
import { createSessionLocalExecutionEnv } from './execution/local.ts'
import { resolveLocation } from './execution/location.ts'
import type { ExecutionEnv, ExecutionLocation } from './execution/types.ts'
import type { ExtensionRunner } from './extensions/runner.ts'
import type { MemoryDream } from './memory/dream.ts'
import type { ModelMessage } from './messages.ts'
import { localDateString } from './prompt/environment.ts'
import type { SystemPromptBuilder } from './prompt/index.ts'
import type { RuntimeBackgroundController } from './runtime-background.ts'
import type { RuntimeExtensionHost } from './runtime-extensions.ts'
import {
  buildRuntimePromptSections,
  runtimeToolModifiers,
} from './runtime-prompt.ts'
import {
  loadTrustedRuntimeResources,
  resolveRuntimeMemoryStores,
  type TrustedRuntimeResources,
} from './runtime-resources.ts'
import { createRuntimeSessionToolRegistry } from './runtime-tools.ts'
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
import type { ToolRegistry } from './tools/registry.ts'

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
  activeAbort: Map<string, AbortController>
  activeSteering: Map<string, ModelMessage[]>
  activeRunMeta: Map<string, ActiveRunMeta>
  sessionBackgrounds: Map<string, RuntimeBackgroundController>
  pendingBashBySession: Map<string, BashExecutionEntry[]>
  activeBash: Map<string, AbortController>
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
  extensionErrors: string[]
  mcpLease?: RuntimeMcpLease
  memoryStores: { local: MemoryStore; global: MemoryStore; dirs: MemoryDirs }
  memoryActive: boolean
  builder: SystemPromptBuilder
  runtimeSections: Record<string, string>
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
  const boundChannel =
    getActiveChannelForSession(state.db, sessionId, runId) ?? saved?.channel
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

  const spillDir = join(
    state.options.agentDir,
    'sessions',
    sessionId,
    'tool-results',
  )
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

  const specialModel = state.specialModels.get(sessionId)
  const modelInput: ModelInput | undefined =
    specialModel?.model ??
    override?.model ??
    saved?.model ??
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
    state.reloadable.defaultThinkingLevel ??
    DEFAULT_THINKING_LEVEL

  const memoryStores = resolveRuntimeMemoryStores({
    registry: state.memoryRegistry,
    agentDir: state.options.agentDir,
    projectId,
    cwd: location.cwd,
  })

  const trustOverride =
    override?.approve !== undefined
      ? override.approve
      : state.options.trustOverride
        ? await state.options.trustOverride(location)
        : undefined
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

  let projectSettings:
    | Awaited<ReturnType<typeof loadProjectSettings>>
    | undefined
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

  const extensionConfig = state.reloadable.extensionConfig ?? {}
  const registry = createRuntimeSessionToolRegistry({
    spillDir,
    cwd: location.cwd,
    logger: state.logger,
    memoryGlobal: memoryStores.global,
    memoryLocal: () => memoryStores.local,
    webConfig: extensionConfig.web,
    hostEnv: effectiveEnv,
    offline: effectiveOffline,
    disabledBuiltins: state.extHost.getDisabledBuiltins(),
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
    extraTools: state.options.tools,
    parentRegistry: override?.noExtensions
      ? undefined
      : state.extHost.hostRegistry,
  })

  const { runner: extensionRunner, errors: extensionErrors } =
    await state.extHost.createSessionRunner({
      cwd: location.cwd,
      trusted: resources.trusted,
      projectExtensions: projectSettings?.settings.extensions ?? [],
      extraExtensions: override?.extensions ?? [],
      noExtensions: Boolean(override?.noExtensions),
      extensionConfig,
      registry,
    })

  let mcpLease: RuntimeMcpLease | undefined
  if (attachMcp && state.options.mcp) {
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
  applyRuntimeProjectToolSelection(state.db, registry, projectId, baseModifiers)

  const ownerTools = state.reloadable.defaultTools
  const projectDefaultTools = projectSettings?.settings.tools
  const mergedDefaultTools =
    ownerTools !== undefined || projectDefaultTools !== undefined
      ? [...(ownerTools ?? []), ...(projectDefaultTools ?? [])]
      : undefined
  if (
    override?.tools !== undefined ||
    override?.noTools ||
    (override?.excludeTools && override.excludeTools.length > 0) ||
    mergedDefaultTools !== undefined
  ) {
    const loadout = selectTools(
      registry.getAllTools().map((t) => t.name),
      {
        tools: override?.tools,
        noTools: override?.noTools,
        excludeTools: override?.excludeTools,
      },
      mergedDefaultTools,
    )
    if (loadout?.selection) registry.setSelection(loadout.selection)
    else if (loadout?.modifiers)
      registry.setDefaultToolModifiers([...baseModifiers, ...loadout.modifiers])
  }

  if (saved?.discoveredTools.length) {
    registry.discoveredTools = new Set(saved.discoveredTools)
  }

  const activeTools = registry.getActiveTools()
  const activeToolNames = new Set(activeTools.map((t) => t.name))
  const memoryActive = activeToolNames.has('memory')

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
  const runtimeSections = {
    ...buildRuntimePromptSections({
      kind: sessionKind,
      projectId,
      hasChannelBinding,
      activeTools: activeToolNames,
    }),
    ...(memoryActive ? { memory: MEMORY_RULES } : {}),
  }

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
    extensionErrors,
    mcpLease,
    memoryStores,
    memoryActive,
    builder,
    runtimeSections,
  }
}
