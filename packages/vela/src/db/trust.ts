import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import type { ExecutionLocation } from '../shared/execution.ts'
import { openDatabase, type VelaDatabase } from './sqlite.ts'

const ENV_KEY_PREFIX = 'env:'

function canonicalDir(dir: string): string {
  const resolved = resolve(dir)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

function nonLocalTrustPrefix(environment: string): string {
  return `${ENV_KEY_PREFIX}${encodeURIComponent(environment)}:`
}

function isReadonlyWalOpenError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  if (code === 'SQLITE_CANTOPEN' || code === 'SQLITE_READONLY') return true
  const message = error instanceof Error ? error.message : String(error)
  return /unable to open|readonly|SQLITE_CANTOPEN|SQLITE_READONLY/i.test(
    message,
  )
}

/** Canonical `trusted_paths.path` key for local directories or `env:<encodedName>:<posixCwd>` non-local locations. */
export function trustLocationKey(target: string | ExecutionLocation): string {
  if (typeof target !== 'string' && target.environment !== 'local') {
    return `${nonLocalTrustPrefix(target.environment)}${posix.resolve('/', target.cwd)}`
  }
  const cwd = typeof target === 'string' ? target : target.cwd
  return canonicalDir(cwd)
}

function withTrustDb<T>(
  source: string | VelaDatabase,
  readonly: boolean,
  fn: (db: VelaDatabase) => T,
): T | undefined {
  if (typeof source !== 'string') return fn(source)
  const dbPath = join(source, 'vela.db')
  if (readonly && !existsSync(dbPath)) return undefined
  if (readonly) {
    try {
      const roDb = openDatabase({ path: dbPath, readonly: true })
      try {
        return fn(roDb)
      } finally {
        roDb.close()
      }
    } catch (error) {
      if (!isReadonlyWalOpenError(error)) throw error
      // WAL-mode SQLite databases fail SQLITE_OPEN_READONLY when -wal/-shm were removed after close.
    }
  }
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
): boolean | undefined {
  return withTrustDb(source, true, (db) => {
    const entries = readTrustRows(db)
    if (entries.size === 0) return undefined

    if (typeof target !== 'string' && target.environment !== 'local') {
      const prefix = nonLocalTrustPrefix(target.environment)
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
    const decisions: Record<string, boolean> = {}
    const byCanonical = new Map<string, boolean>()
    for (const [key, val] of entries) {
      if (key.startsWith(ENV_KEY_PREFIX)) continue
      decisions[key] = val
      const canon = canonicalDir(key)
      const prev = byCanonical.get(canon)
      byCanonical.set(canon, prev !== false && val !== false)
    }

    let curCanon = canonicalDir(cwd)
    let curRaw = resolve(cwd)
    let canonDone = false
    let rawDone = false
    while (!canonDone || !rawDone) {
      const matches: boolean[] = []
      if (!rawDone && typeof decisions[curRaw] === 'boolean') {
        matches.push(decisions[curRaw]!)
      }
      if (!canonDone) {
        const canonMatch = byCanonical.get(curCanon)
        if (typeof canonMatch === 'boolean') matches.push(canonMatch)
        if (typeof decisions[curCanon] === 'boolean') {
          matches.push(decisions[curCanon]!)
        }
      }
      if (matches.length > 0) return !matches.includes(false)
      const nextCanon = dirname(curCanon)
      const nextRaw = dirname(curRaw)
      if (nextCanon === curCanon) canonDone = true
      else curCanon = nextCanon
      if (nextRaw === curRaw) rawDone = true
      else curRaw = nextRaw
    }
    return undefined
  })
}

/** Persists a trust decision into `vela.db` (`trusted_paths`). */
export function saveTrust(
  source: string | VelaDatabase,
  target: string | ExecutionLocation,
  trusted: boolean,
): void {
  const key = trustLocationKey(target)
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
