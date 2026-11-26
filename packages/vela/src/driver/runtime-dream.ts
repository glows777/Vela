import type { VelaDatabase } from '../db/index.ts'
import type { ResolvedModel } from '../providers/models/index.ts'
import type { MemoryStore } from '../runtime/memory/index.ts'
import type { VelaLogger } from '../shared/logger.ts'
import type { ExecutionEnv } from './execution/types.ts'
import { type DreamScope, dreamKvKey, MemoryDream } from './memory/dream.ts'
import type { TokenTracker } from './usage/tracker.ts'

function resolveRuntimeDream(options: {
  db: VelaDatabase
  activeDreams: Map<string, MemoryDream>
  localStore: MemoryStore
  projectId: string | null
}): MemoryDream {
  const dreamScope: DreamScope = options.projectId
    ? { kind: 'project', projectId: options.projectId }
    : { kind: 'global' }
  const key = dreamKvKey(dreamScope)
  let dream = options.activeDreams.get(key)
  if (!dream) {
    dream = new MemoryDream(options.localStore, options.db, dreamScope)
    options.activeDreams.set(key, dream)
  }
  return dream
}

export function recordRuntimeDreamTurn(options: {
  db: VelaDatabase
  activeDreams: Map<string, MemoryDream>
  localStore: MemoryStore
  projectId: string | null
  sessionId: string
  userEntryId?: string
  hasHumanText?: boolean
}): void {
  if (!options.hasHumanText || !options.userEntryId) return
  resolveRuntimeDream(options).recordMessages(options.sessionId, [
    { messageId: options.userEntryId, time: Date.now() },
  ])
}

export function scheduleRuntimeAutoDream(options: {
  db: VelaDatabase
  activeDreams: Map<string, MemoryDream>
  pendingDreamTasks: Set<Promise<void>>
  localStore: MemoryStore
  projectId: string | null
  sessionId: string
  dreamEnabled?: boolean
  resolved: ResolvedModel
  tracker: TokenTracker
  resolveEnv: () => Promise<ExecutionEnv>
  signal: AbortSignal
  logger: VelaLogger
}): void {
  if (options.signal.aborted) return
  const dream = resolveRuntimeDream(options)
  if (options.dreamEnabled === false || !dream.due()) return
  const task = dream
    .run(
      {
        sessionId: options.sessionId,
        model: options.resolved.model,
        pricing: options.resolved.info.cost,
        checkPath: async (candidate) => {
          if (options.signal.aborted) return false
          const env = await options.resolveEnv()
          const abs = await env.absolutePath(candidate, options.signal)
          if (!abs.ok) return false
          const exists = await env.exists(abs.value, options.signal)
          return exists.ok && exists.value
        },
        recordUsage: (modelId, usage, meta, pricing) =>
          options.tracker.record(modelId, usage, meta, pricing),
      },
      options.signal,
    )
    .catch((error) => {
      if (
        options.signal.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        return
      }
      options.logger.warn(
        `[dream] ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    .then(() => undefined)
    .finally(() => {
      options.pendingDreamTasks.delete(task)
    })
  options.pendingDreamTasks.add(task)
}
