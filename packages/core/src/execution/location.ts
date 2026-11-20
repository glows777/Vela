import { isAbsolute, resolve } from 'node:path'
import type { ExecutionLocation } from './types.ts'

/** Local paths follow host rules. A remote cwd is already in its environment's namespace. */
export function resolveLocation(
  location: ExecutionLocation | undefined,
  base?: string,
  cwd?: string,
): Readonly<ExecutionLocation> {
  if (
    location !== undefined &&
    (!location ||
      typeof location.environment !== 'string' ||
      !location.environment.trim() ||
      typeof location.cwd !== 'string' ||
      !location.cwd.trim() ||
      location.cwd.includes('\0'))
  )
    throw Error('Invalid execution location')
  if (location && location.environment !== 'local') {
    if (!location.cwd.startsWith('/'))
      throw Error(
        'Invalid execution location: expected absolute environment cwd',
      )
    return Object.freeze({
      environment: location.environment,
      cwd: location.cwd,
    })
  }
  return Object.freeze({
    environment: 'local',
    cwd: resolve(base ?? process.cwd(), location?.cwd ?? cwd ?? '.'),
  })
}

export function validateStoredLocation(
  input: unknown,
): asserts input is ExecutionLocation {
  const loc = input as ExecutionLocation | undefined
  if (
    !loc ||
    typeof loc.cwd !== 'string' ||
    !(loc.environment === 'local'
      ? isAbsolute(loc.cwd)
      : loc.cwd.startsWith('/'))
  )
    throw Error('Invalid saved execution location')
  resolveLocation(loc)
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

export function sameLocation(
  left: ExecutionLocation,
  right: ExecutionLocation,
) {
  return left.environment === right.environment && left.cwd === right.cwd
}
