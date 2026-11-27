import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { types } from 'node:util'
import { applyMigrations } from './migrations.ts'

export type SqlParam = SQLInputValue

export interface OpenDatabaseOptions {
  /** File path or `':memory:'` for an ephemeral in-memory database. */
  path: string
  /** Open an existing database read-only (disables WAL setup and schema upgrades). */
  readonly?: boolean
  /** Require an existing database file on disk without creating one if absent. */
  mustExist?: boolean
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

function assertSyncResult<T>(value: T): T {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  ) {
    throw new Error('SQLite transactions must be synchronous')
  }
  return value
}

function ensurePrivateDir(dir: string): void {
  const missing: string[] = []
  let cur = resolve(dir)
  while (!existsSync(cur)) {
    missing.push(cur)
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  if (missing.length === 0) return
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const created of missing) {
    chmodSync(created, 0o700)
  }
}

function chmodIfExists(path: string, mode: number): void {
  if (existsSync(path)) chmodSync(path, mode)
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
  private commitHooks: Array<() => void> = []

  constructor(raw: DatabaseSync, path: string, readonly = false) {
    this.raw = raw
    this.path = path
    this.readonly = readonly
  }

  get open(): boolean {
    return !this.closed
  }

  get inTransaction(): boolean {
    return this.txDepth > 0
  }

  /** Runs `fn` immediately if outside a transaction, or right after the outermost COMMIT succeeds. */
  afterCommit(fn: () => void): void {
    if (this.txDepth === 0) {
      fn()
      return
    }
    this.commitHooks.push(fn)
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
   * Executes `fn` synchronously and atomically. Outermost call uses `BEGIN IMMEDIATE` by default
   * so write transactions never fail mid-flight on lock upgrade; nested calls use SQLite `SAVEPOINT`s.
   */
  transaction<T>(
    fn: () => T,
    mode: 'IMMEDIATE' | 'DEFERRED' = this.readonly ? 'DEFERRED' : 'IMMEDIATE',
  ): T {
    this.assertOpen()
    if (types.isAsyncFunction(fn) || fn.constructor?.name === 'AsyncFunction') {
      throw new Error('SQLite transactions must be synchronous')
    }
    if (this.readonly && mode === 'IMMEDIATE') {
      throw new Error(
        'Cannot start an IMMEDIATE write transaction on a read-only database',
      )
    }
    const depth = this.txDepth
    if (depth === 0) {
      this.raw.exec(`BEGIN ${mode}`)
      this.txDepth = 1
      let committed = false
      try {
        const result = assertSyncResult(fn())
        this.raw.exec('COMMIT')
        committed = true
        return result
      } catch (error) {
        try {
          this.raw.exec('ROLLBACK')
        } catch {}
        throw error
      } finally {
        this.txDepth = 0
        const hooks = this.commitHooks.splice(0)
        if (committed) {
          for (const hook of hooks) {
            try {
              hook()
            } catch {}
          }
        }
      }
    }

    const hookMark = this.commitHooks.length
    const sp = quoteSavepoint(`vela_sp_${++this.savepointSeq}`)
    this.raw.exec(`SAVEPOINT ${sp}`)
    this.txDepth = depth + 1
    try {
      const result = assertSyncResult(fn())
      this.raw.exec(`RELEASE SAVEPOINT ${sp}`)
      return result
    } catch (error) {
      this.commitHooks.length = hookMark
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
 * Transparently repairs pre-S3b v1 databases whose `channel_bindings` table still carries
 * the legacy table-level `UNIQUE (channel, external_id)` constraint without bumping SCHEMA_VERSION.
 */
function repairChannelBindingsPartialIndexes(db: VelaDatabase): void {
  const table = db.get<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channel_bindings'`,
  )
  const hasThreadIndex = db.get<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_channel_bindings_thread'`,
  )
  const hasRootIndex = db.get<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_channel_bindings_root'`,
  )
  if (
    !table ||
    (!/UNIQUE\s*\(\s*channel\s*,\s*external_id\s*\)/i.test(table.sql) &&
      hasThreadIndex &&
      hasRootIndex)
  ) {
    return
  }
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE channel_bindings_v1_repaired (
          id TEXT PRIMARY KEY NOT NULL,
          channel TEXT NOT NULL,
          external_id TEXT NOT NULL,
          thread_id TEXT,
          kind TEXT NOT NULL CHECK (kind IN ('group', 'direct')),
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          config_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO channel_bindings_v1_repaired (
          id, channel, external_id, thread_id, kind, project_id,
          session_id, enabled, config_json, created_at, updated_at
        )
        SELECT id, channel, external_id, thread_id, kind, project_id,
               session_id, enabled, config_json, created_at, updated_at
        FROM channel_bindings;
        DROP TABLE channel_bindings;
        ALTER TABLE channel_bindings_v1_repaired RENAME TO channel_bindings;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_bindings_root
          ON channel_bindings (channel, external_id)
          WHERE thread_id IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_bindings_thread
          ON channel_bindings (channel, external_id, thread_id)
          WHERE thread_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_channel_bindings_project
          ON channel_bindings (project_id);
        CREATE INDEX IF NOT EXISTS idx_channel_bindings_session
          ON channel_bindings (session_id);
      `)
    })
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

/**
 * Transparently upgrades pre-S3-fix v1 databases so `inbox_events.project_id` uses `ON DELETE SET NULL`,
 * and `subscriptions` deduplicates and enforces `(source, event_key, session_id)` uniqueness without
 * bumping `SCHEMA_VERSION`.
 */
function repairV1InboxAndSubscriptions(db: VelaDatabase): void {
  const hasInboxEvents = Boolean(
    db.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbox_events'`,
    ),
  )
  const inboxFk = hasInboxEvents
    ? db
        .all<{ from: string; table: string; on_delete: string }>(
          "PRAGMA foreign_key_list('inbox_events')",
        )
        .find((fk) => fk.from === 'project_id' && fk.table === 'projects')
    : undefined
  const needsInboxFkRepair = Boolean(
    inboxFk && inboxFk.on_delete.toUpperCase() !== 'SET NULL',
  )
  const hasSubscriptions = Boolean(
    db.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subscriptions'`,
    ),
  )
  const needsSubsRepair =
    hasSubscriptions &&
    !db.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_subscriptions_unique'`,
    )
  if (!needsInboxFkRepair && !needsSubsRepair) return

  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.transaction(() => {
      if (needsInboxFkRepair) {
        db.exec(`
          CREATE TABLE inbox_events_v1_repaired (
            id TEXT PRIMARY KEY NOT NULL,
            session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
            project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
            source TEXT NOT NULL,
            dedupe_key TEXT,
            wake INTEGER NOT NULL DEFAULT 1 CHECK (wake IN (0, 1)),
            passive INTEGER NOT NULL DEFAULT 0 CHECK (passive IN (0, 1)),
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'dropped')),
            payload_json TEXT NOT NULL,
            run_id TEXT,
            created_at TEXT NOT NULL,
            processed_at TEXT
          );
          INSERT INTO inbox_events_v1_repaired (
            id, session_id, project_id, source, dedupe_key, wake,
            passive, status, payload_json, run_id, created_at, processed_at
          )
          SELECT id, session_id, project_id, source, dedupe_key, wake,
                 passive, status, payload_json, run_id, created_at, processed_at
          FROM inbox_events;
          DROP TABLE inbox_events;
          ALTER TABLE inbox_events_v1_repaired RENAME TO inbox_events;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_source_dedupe
            ON inbox_events (source, dedupe_key)
            WHERE dedupe_key IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_inbox_session_status
            ON inbox_events (session_id, status, created_at);
          CREATE INDEX IF NOT EXISTS idx_inbox_status_created
            ON inbox_events (status, created_at);
        `)
      }
      if (needsSubsRepair) {
        db.exec(`
          DELETE FROM subscriptions
          WHERE id != (
            SELECT s2.id FROM subscriptions s2
            WHERE s2.source = subscriptions.source
              AND s2.event_key = subscriptions.event_key
              AND s2.session_id = subscriptions.session_id
            ORDER BY s2.created_at ASC, s2.rowid ASC
            LIMIT 1
          );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_unique
            ON subscriptions (source, event_key, session_id);
        `)
      }
    }, 'IMMEDIATE')
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

function isSqliteCantOpenError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const errcode = (error as { errcode?: unknown }).errcode
  return errcode === 14 || /unable to open database file/i.test(error.message)
}

function initializeOpenedDatabase(
  raw: DatabaseSync,
  options: OpenDatabaseOptions,
  isMemory: boolean,
  readonly: boolean,
): VelaDatabase {
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
    if (!readonly) {
      repairChannelBindingsPartialIndexes(db)
      repairV1InboxAndSubscriptions(db)
    }

    if (!isMemory && !readonly) {
      chmodIfExists(options.path, 0o600)
      chmodIfExists(`${options.path}-wal`, 0o600)
      chmodIfExists(`${options.path}-shm`, 0o600)
    }
    return db
  } catch (error) {
    db.close()
    const msg = error instanceof Error ? error.message : String(error)
    if (
      !isMemory &&
      /not a database|database disk image is malformed|encrypted or is not a database/i.test(
        msg,
      )
    ) {
      throw new Error(
        `[config] ${options.path} is not a valid SQLite database: ${msg}`,
        { cause: error },
      )
    }
    throw error
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
    if (options.mustExist) {
      const fd = openSync(options.path, 'r+')
      closeSync(fd)
      chmodSync(options.path, 0o600)
    } else {
      ensurePrivateDir(dirname(options.path))
      if (!existsSync(options.path)) {
        try {
          const fd = openSync(options.path, 'wx', 0o600)
          closeSync(fd)
          chmodSync(options.path, 0o600)
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
        }
      } else {
        chmodSync(options.path, 0o600)
      }
    }
  }

  const raw = readonly
    ? new DatabaseSync(options.path, { readOnly: true })
    : new DatabaseSync(options.path)

  try {
    return initializeOpenedDatabase(raw, options, isMemory, readonly)
  } catch (error) {
    // Cleanly checkpointed + closed WAL databases unlink -wal/-shm; readonly open then hits
    // SQLITE_CANTOPEN unless SQLite skips shm creation via immutable=1 when no sidecars exist.
    if (
      readonly &&
      !isMemory &&
      isSqliteCantOpenError(error) &&
      existsSync(options.path) &&
      !existsSync(`${options.path}-wal`) &&
      !existsSync(`${options.path}-shm`)
    ) {
      const immutableUri = pathToFileURL(resolve(options.path))
      immutableUri.searchParams.set('mode', 'ro')
      immutableUri.searchParams.set('immutable', '1')
      const immutableRaw = new DatabaseSync(immutableUri, { readOnly: true })
      return initializeOpenedDatabase(immutableRaw, options, isMemory, readonly)
    }
    throw error
  }
}
