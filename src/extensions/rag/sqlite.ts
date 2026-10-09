import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

/** Minimal common surface of synchronous SQLite: bun:sqlite on Bun, node:sqlite on Node. */
export interface SqliteStatement {
  run(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}

export interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  loadExtension(path: string): void
  close(): void
}

const require = createRequire(import.meta.url)
const isBun = typeof process.versions.bun === 'string'

// bun:sqlite uses the system SQLite by default; sqlite-vec needs a library that supports loading
// extensions (the macOS system SQLite does not; use Homebrew's). node:sqlite's bundled SQLite supports it.
const CUSTOM_SQLITE_CANDIDATES = [
  '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib', // Apple Silicon Mac
  '/usr/local/opt/sqlite/lib/libsqlite3.dylib', // Intel Mac
  '/usr/lib/x86_64-linux-gnu/libsqlite3.so.0', // Linux x64
  '/usr/lib/aarch64-linux-gnu/libsqlite3.so.0', // Linux ARM64
]

let customSqliteLoaded = false

function loadCustomSqlite(Database: {
  setCustomSQLite(path: string): void
}): void {
  if (customSqliteLoaded) return
  const path = CUSTOM_SQLITE_CANDIDATES.find((p) => existsSync(p))
  if (!path) {
    throw new Error(
      'No SQLite library that can load the sqlite-vec extension was found. On macOS, install Homebrew SQLite (brew install sqlite); on Linux, check the system libsqlite3 path',
    )
  }
  Database.setCustomSQLite(path)
  customSqliteLoaded = true
}

/** Opens a database that allows loading extensions. */
export function openSqlite(path: string): SqliteDatabase {
  if (isBun) {
    const { Database } = require('bun:sqlite')
    loadCustomSqlite(Database)
    return new Database(path)
  }
  const { DatabaseSync } = require('node:sqlite')
  return new DatabaseSync(path, { allowExtension: true })
}

/** Runs fn in a transaction (the two runtimes' transaction APIs differ, so use BEGIN / COMMIT). */
export function transaction(db: SqliteDatabase, fn: () => void): void {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
