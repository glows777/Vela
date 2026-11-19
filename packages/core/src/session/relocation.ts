import { sameLocation } from '../execution/location.ts'
import type { ExecutionLocation } from '../execution/types.ts'
import type { SessionDeps } from './deps.ts'
import type { SessionStore } from './index.ts'

/** A live move stages and persists its target. A restored target is already durable and
 * must become the active authority even if its first resource load subsequently fails. */
export async function switchWorkspace<
  S extends {
    id: string
    location: Readonly<ExecutionLocation>
    store: SessionStore
  },
>(
  session: S,
  deps: SessionDeps<S>,
  target: Readonly<ExecutionLocation>,
  started: Promise<void> | undefined,
  activate: () => void,
  moveSignal?: AbortSignal,
) {
  const previous = session.location
  if (sameLocation(previous, target)) return
  const release = async (location: ExecutionLocation) => {
    try {
      await deps.discardWorkspace(session, location)
    } catch (error) {
      deps.logger.warn(`[session:${session.id}] releasing workspace: ${error}`)
    }
  }
  if (moveSignal) {
    try {
      await deps.prepareWorkspace(session, moveSignal, target)
      moveSignal.throwIfAborted()
      await session.store.persistLocation(target)
    } catch (error) {
      await release(target)
      throw error
    }
  }
  if (started) {
    try {
      await started
      await deps.extensions.sessionShutdown(session)
    } catch (error) {
      deps.logger.warn(
        `[session:${session.id}] shutdown during relocation: ${error}`,
      )
    }
  }
  activate()
  deps.bindWorkspace(session)
  await release(previous)
}
