import { resolveLocation, sameLocation } from '../execution/location.ts'
import type { ExecutionLocation } from '../execution/types.ts'
import type { SessionDeps } from './deps.ts'
import type { SessionStore } from './index.ts'

import type { InternalSessionOptions, SessionOptions } from './options.ts'

export function busyLocationError() {
  return Object.assign(new Error('Session is busy'), { code: 'SESSION_BUSY' })
}

export function restoredLocation(
  saved: ExecutionLocation | undefined,
  options: SessionOptions,
  cwd: string | undefined,
) {
  return resolveLocation(
    saved ??
      (options.location?.environment === 'local'
        ? options.location
        : undefined),
    cwd,
    options.cwd,
  )
}

/** A changed gateway binding is prepared by admission. Interrupted turns prepare the saved location on start. */
export function needsRestoredWorkspace(
  options: InternalSessionOptions,
  target: ExecutionLocation,
) {
  return (
    !options.host || !options.location || sameLocation(options.location, target)
  )
}

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
