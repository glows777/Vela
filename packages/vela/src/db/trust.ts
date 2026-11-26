import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import type { ExecutionLocation } from '../shared/execution.ts'
import { openDatabase, type VelaDatabase } from './sqlite.ts'

const ENV_KEY_PREFIX = 'env:'

export function canonicalLocalPath(dir: string): string {
  const resolved = resolve(dir)
  const missing: string[] = []
  let cur = resolved
  for (;;) {
    try {
      const real = realpathSync(cur)
      return missing.length ? join(real, ...missing.reverse()) : real
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return resolved
      missing.push(cur.slice(parent.length).replace(/^[\\/]+/, ''))
      cur = parent
    }
  }
}

function nonLocalTrustPrefix(environment: string, ownerScope?: string): string {
  const scope = ownerScope
    ? `${encodeURIComponent(canonicalLocalPath(ownerScope))}:`
    : ''
  return `${ENV_KEY_PREFIX}${scope}${encodeURIComponent(environment)}:`
}

function isReadonlyWalOpenError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  if (code === 'SQLITE_CANTOPEN' || code === 'SQLITE_READONLY') return true
  const message = error instanceof Error ? error.message : String(error)
  return /unable to open|readonly|SQLITE_CANTOPEN|SQLITE_READONLY/i.test(
    message,
  )
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT'
}

/**
 * Canonical `trusted_paths.path` key for local directories or non-local locations
 * (`env:<encodedName>:<posixCwd>`, optionally scoped to canonical owner `dataDir`).
 */
export function trustLocationKey(
  target: string | ExecutionLocation,
  ownerScope?: string,
): string {
  if (typeof target !== 'string' && target.environment !== 'local') {
    return `${nonLocalTrustPrefix(target.environment, ownerScope)}${posix.resolve('/', target.cwd)}`
  }
  const cwd = typeof target === 'string' ? target : target.cwd
  return canonicalLocalPath(cwd)
}

/**
 * Reads an existing SQLite database in read-only mode, falling back to `mustExist`
 * when WAL-mode SQLite databases lack `-wal`/`-shm` sidecars after a clean close.
 */
export function withReadonlyDb<T>(
  dbPath: string,
  fn: (db: VelaDatabase) => T,
): T | undefined {
  if (!existsSync(dbPath)) return undefined
  try {
    const roDb = openDatabase({ path: dbPath, readonly: true })
    try {
      return fn(roDb)
    } finally {
      roDb.close()
    }
  } catch (error) {
    if (!isReadonlyWalOpenError(error)) throw error
    if (!existsSync(dbPath)) return undefined
    // WAL-mode SQLite databases fail SQLITE_OPEN_READONLY when -wal/-shm were removed after close.
  }
  try {
    const existingDb = openDatabase({ path: dbPath, mustExist: true })
    try {
      return fn(existingDb)
    } finally {
      existingDb.close()
    }
  } catch (error) {
    if (isMissingFileError(error)) return undefined
    throw error
  }
}

function withTrustDb<T>(
  source: string | VelaDatabase,
  readonly: boolean,
  fn: (db: VelaDatabase) => T,
): T | undefined {
  if (typeof source !== 'string') return fn(source)
  const dbPath = join(source, 'vela.db')
  if (readonly) return withReadonlyDb(dbPath, fn)
  const db = openDatabase({ path: dbPath })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function readTrustRows(db: VelaDatabase): Map<string, boolean> {
  const rows = db.all<{ path: string; trusted: number }>(
    'SELECT path, trusted FROM trusted_paths',
  )
  const out = new Map<string, boolean>()
  for (const row of rows) {
    out.set(row.path, row.trusted === 1)
  }
  return out
}

/** The saved decision closest to `target` in `vela.db` (`trusted_paths`), or `undefined`. */
export function savedTrust(
  source: string | VelaDatabase,
  target: string | ExecutionLocation,
  ownerScope?: string,
): boolean | undefined {
  return withTrustDb(source, true, (db) => {
    const entries = readTrustRows(db)
    if (entries.size === 0) return undefined

    if (typeof target !== 'string' && target.environment !== 'local') {
      const prefix = nonLocalTrustPrefix(target.environment, ownerScope)
      let cur = posix.resolve('/', target.cwd)
      for (;;) {
        const match = entries.get(`${prefix}${cur}`)
        if (match !== undefined) return match
        const parent = posix.dirname(cur)
        if (parent === cur) return undefined
        cur = parent
      }
    }

    const cwd = typeof target === 'string' ? target : target.cwd
    let cur = canonicalLocalPath(cwd)
    for (;;) {
      const match = entries.get(cur)
      if (match !== undefined) return match
      const parent = dirname(cur)
      if (parent === cur) return undefined
      cur = parent
    }
  })
}

/** Persists a trust decision into `vela.db` (`trusted_paths`). */
export function saveTrust(
  source: string | VelaDatabase,
  target: string | ExecutionLocation,
  trusted: boolean,
  ownerScope?: string,
): void {
  const key = trustLocationKey(target, ownerScope)
  const now = new Date().toISOString()
  withTrustDb(source, false, (db) => {
    db.run(
      `INSERT INTO trusted_paths (path, trusted, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         trusted = excluded.trusted,
         updated_at = excluded.updated_at`,
      key,
      trusted ? 1 : 0,
      now,
    )
  })
}
