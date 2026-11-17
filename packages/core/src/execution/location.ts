import { isAbsolute, resolve } from 'node:path'
import type { ExecutionLocation } from './types.ts'

/** E1 accepts only local until execution-side calls use the selected environment. */
export function localCwd(
  location?: ExecutionLocation,
  base?: string,
  cwd?: string,
): string {
  if (location && (typeof location.cwd !== 'string' || !location.cwd.trim()))
    throw new Error('Invalid execution location: cwd is required')
  if (location && location.environment !== 'local')
    throw new Error(
      `Execution environment ${location.environment} is unavailable before E2`,
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
