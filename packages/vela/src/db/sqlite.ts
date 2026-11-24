import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { applyMigrations } from './migrations.ts'

export type SqlParam = SQLInputValue

export interface OpenDatabaseOptions {
  /** File path or `':memory:'` for an ephemeral in-memory database. */
  path: string
  /** Open an existing database read-only (disables WAL setup and schema upgrades). */
  readonly?: boolean
}

export interface RunResult {
  changes: number
  lastInsertRowid: number | bigint
}

function normalizeRow<T extends Record<string, unknown>>(
  row: Record<string, unknown> | undefined,
): T | undefined {
  return row === undefined ? undefined : ({ ...row } as T)
}

function quoteSavepoint(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/**
 * Thin cross-runtime SQLite wrapper backed by built-in `node:sqlite` (works natively
 * in Node >= 22.18, Bun >= 1.4, and Electron without native addons or shared libraries).
 */
export class VelaDatabase {
  readonly path: string
  readonly readonly: boolean
  private readonly raw: DatabaseSync
  private closed = false
  private txDepth = 0
  private savepointSeq = 0

  constructor(raw: DatabaseSync, path: string, readonly = false) {
    this.raw = raw
    this.path = path
    this.readonly = readonly
  }

  get open(): boolean {
    return !this.closed
  }

  get schemaVersion(): number {
    const row = this.get<{ user_version: number }>('PRAGMA user_version')
    return typeof row?.user_version === 'number' ? row.user_version : 0
  }

  exec(sql: string): void {
    this.assertOpen()
    this.raw.exec(sql)
  }

  run(sql: string, ...params: SqlParam[]): RunResult {
    this.assertOpen()
    const result = this.raw.prepare(sql).run(...params)
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    }
  }

  get<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: SqlParam[]
  ): T | undefined {
    this.assertOpen()
    const row = this.raw.prepare(sql).get(...params) as
      | Record<string, unknown>
      | undefined
    return normalizeRow<T>(row)
  }

  all<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: SqlParam[]
  ): T[] {
    this.assertOpen()
    const rows = this.raw.prepare(sql).all(...params) as Record<
      string,
      unknown
    >[]
    return rows.map((row) => ({ ...row }) as T)
  }

  /**
   * Executes `fn` atomically. Outermost call uses `BEGIN IMMEDIATE` by default so write
   * transactions never fail mid-flight on lock upgrade; nested calls use SQLite `SAVEPOINT`s.
   */
  transaction<T>(
    fn: () => T,
    mode: 'IMMEDIATE' | 'DEFERRED' = this.readonly ? 'DEFERRED' : 'IMMEDIATE',
  ): T {
    this.assertOpen()
    if (this.readonly && mode === 'IMMEDIATE') {
      throw new Error(
        'Cannot start an IMMEDIATE write transaction on a read-only database',
      )
    }
    const depth = this.txDepth
    if (depth === 0) {
      this.raw.exec(`BEGIN ${mode}`)
      this.txDepth = 1
      try {
        const result = fn()
        this.raw.exec('COMMIT')
        return result
      } catch (error) {
        try {
          this.raw.exec('ROLLBACK')
        } catch {}
        throw error
      } finally {
        this.txDepth = 0
      }
    }

    const sp = quoteSavepoint(`vela_sp_${++this.savepointSeq}`)
    this.raw.exec(`SAVEPOINT ${sp}`)
    this.txDepth = depth + 1
    try {
      const result = fn()
      this.raw.exec(`RELEASE SAVEPOINT ${sp}`)
      return result
    } catch (error) {
      try {
        this.raw.exec(`ROLLBACK TO SAVEPOINT ${sp}`)
        this.raw.exec(`RELEASE SAVEPOINT ${sp}`)
      } catch {}
      throw error
    } finally {
      this.txDepth = depth
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.raw.close()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`SQLite database "${this.path}" is already closed`)
    }
  }
}

/**
 * Opens `vela.db` (or `':memory:'`), configures WAL + foreign keys + busy timeout,
 * enforces `0600` file permissions on disk, and applies forward schema migrations.
 */
export function openDatabase(options: OpenDatabaseOptions): VelaDatabase {
  const isMemory = options.path === ':memory:'
  const readonly = options.readonly === true

  if (!isMemory && !readonly) {
    const dir = dirname(options.path)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }

  const raw = readonly
    ? new DatabaseSync(options.path, { readOnly: true })
    : new DatabaseSync(options.path)
  const db = new VelaDatabase(raw, options.path, readonly)

  try {
    if (!isMemory) {
      db.exec('PRAGMA busy_timeout = 5000')
      if (!readonly) {
        db.exec('PRAGMA journal_mode = WAL')
        db.exec('PRAGMA synchronous = NORMAL')
      }
    }
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA temp_store = MEMORY')

    applyMigrations(db, { readonly })

    if (!isMemory && !readonly && existsSync(options.path)) {
      chmodSync(options.path, 0o600)
    }
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
