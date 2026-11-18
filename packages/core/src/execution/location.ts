import { isAbsolute, resolve } from 'node:path'
import type { ExecutionLocation } from './types.ts'

/** Nonlocal locations stay disabled until the host supports their isolation and artifact lifecycle. */
export function localCwd(
  location?: ExecutionLocation,
  base?: string,
  cwd?: string,
): string {
  if (location && (typeof location.cwd !== 'string' || !location.cwd.trim()))
    throw new Error('Invalid execution location: cwd is required')
  if (location && location.environment !== 'local')
    throw new Error(
      `Execution environment ${location.environment} is unavailable (only local locations are supported)`,
    )
  return resolve(base ?? process.cwd(), location?.cwd ?? cwd ?? '.')
}

/** Stored locations are absolute; reject malformed state before any session becomes executable. */
export function validateStoredLocation(location: unknown): void {
  if (
    !location ||
    typeof location !== 'object' ||
    typeof (location as ExecutionLocation).cwd !== 'string' ||
    !isAbsolute((location as ExecutionLocation).cwd)
  )
    throw new Error('Invalid saved execution location')
  localCwd(location as ExecutionLocation)
}

/** Wait for an adapter supplied by the host without leaving the caller blocked after cancellation. */
export async function abortable<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return pending
  let rejectAbort!: (reason: unknown) => void
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
