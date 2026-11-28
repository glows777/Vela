import type { VelaDatabase } from '../db/index.ts'
import type { OAuthRegistrationStore } from '../providers/auth/types.ts'
import type { ModelRegistry } from '../providers/models/index.ts'
import type { ProviderConfig } from '../providers/models-config.ts'
import type { DriverTurnResult } from '../runtime/driver.ts'
import type { MemoryRegistry } from '../runtime/memory/index.ts'
import type { VelaLogger } from '../shared/logger.ts'
import type { ModelInput } from '../shared/provider-types.ts'
import type { ProjectSettings } from './config/project-settings.ts'
import type { ExtensionRunner } from './extensions/runner.ts'
import type { ExtensionSession } from './extensions/types.ts'
import type { MemoryDream } from './memory/dream.ts'
import type { ModelMessage } from './messages.ts'
import type { RuntimeBackgroundController } from './runtime-background.ts'
import type { RuntimeExtensionHost } from './runtime-extensions.ts'
import type { TrustedRuntimeResources } from './runtime-resources.ts'
import type {
  ActiveRunMeta,
  RuntimeMcpLease,
  RuntimeReloadableConfig,
  RuntimeSessionOverride,
  RuntimeSpecialModelHandle,
  VelaAgentDriverOptions,
} from './runtime-types.ts'
import type { BashExecutionEntry } from './session/entries.ts'
import type { ToolRegistry } from './tools/registry.ts'

export interface CachedSessionRunner {
  key: string
  runner: ExtensionRunner
  registry: ToolRegistry
  errors: string[]
  releaseHost: () => void
  started: boolean
  lastView?: ExtensionSession
  refs: number
  retired?: boolean
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
  specialModelSources: Map<
    string,
    { envModel?: string; envRecord?: string; defaultModel?: ModelInput }
  >
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

export async function releaseCachedSessionRunner(
  entry: CachedSessionRunner,
): Promise<void> {
  entry.refs = Math.max(0, entry.refs - 1)
  if (entry.retired && entry.refs === 0) {
    await disposeCachedSessionRunner(entry)
  }
}

export function withSessionRunnerLock<T>(
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
  state.specialModelSources.clear()
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
