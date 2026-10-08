import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

/** 同步 SQLite 的最小公共面：Bun 下是 bun:sqlite，Node 下是 node:sqlite。 */
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

// bun:sqlite 默认用系统 SQLite；sqlite-vec 需要一个支持扩展加载的动态库
// （macOS 的系统 SQLite 不支持，要用 Homebrew 的）。node:sqlite 自带的 SQLite 支持扩展加载。
const CUSTOM_SQLITE_CANDIDATES = [
  '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib', // Apple Silicon Mac
  '/usr/local/opt/sqlite/lib/libsqlite3.dylib', // Intel Mac
  '/usr/lib/x86_64-linux-gnu/libsqlite3.so.0', // Linux x64
  '/usr/lib/aarch64-linux-gnu/libsqlite3.so.0', // Linux ARM64
]

let customSqliteLoaded = false

function loadCustomSqlite(Database: { setCustomSQLite(path: string): void }): void {
  if (customSqliteLoaded) return
  const path = CUSTOM_SQLITE_CANDIDATES.find((p) => existsSync(p))
  if (!path) {
    throw new Error(
      '未找到支持 sqlite-vec 扩展加载的 SQLite 动态库：macOS 请安装 Homebrew SQLite（brew install sqlite），Linux 请确认系统 libsqlite3 路径',
    )
  }
  Database.setCustomSQLite(path)
  customSqliteLoaded = true
}

/** 打开一个允许加载扩展的数据库。 */
export function openSqlite(path: string): SqliteDatabase {
  if (isBun) {
    const { Database } = require('bun:sqlite')
    loadCustomSqlite(Database)
    return new Database(path)
  }
  const { DatabaseSync } = require('node:sqlite')
  return new DatabaseSync(path, { allowExtension: true })
}

/** 在一个事务里执行 fn（两个运行时的 transaction API 不同，统一用 BEGIN / COMMIT）。 */
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
