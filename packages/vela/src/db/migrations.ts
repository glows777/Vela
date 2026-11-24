import { INITIAL_SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts'

export interface MigrationDatabase {
  readonly path: string
  readonly schemaVersion: number
  exec(sql: string): void
  run(
    sql: string,
    ...params: (string | number | bigint | Uint8Array | null)[]
  ): unknown
  get<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: (string | number | bigint | Uint8Array | null)[]
  ): T | undefined
  transaction<T>(fn: () => T, mode?: 'IMMEDIATE' | 'DEFERRED'): T
}

interface Migration {
  version: number
  name: string
  disableForeignKeys?: boolean
  migrate(db: MigrationDatabase): void
}

const V2_DDL_FIXES = `
CREATE TABLE IF NOT EXISTS oauth_registrations (
  provider TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL,
  host_id TEXT,
  subject TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_status_created
  ON inbox_events (status, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_status
  ON runs (status);
CREATE INDEX IF NOT EXISTS idx_bg_jobs_status
  ON background_jobs (status);
CREATE INDEX IF NOT EXISTS idx_vela_tool_calls_active_status
  ON vela_tool_calls (status);
`

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '001_initial',
    migrate: (db) => {
      db.exec(INITIAL_SCHEMA_SQL)
    },
  },
  {
    version: 2,
    name: '002_s1_audit_schema',
    disableForeignKeys: true,
    migrate: (db) => {
      db.exec(V2_DDL_FIXES)

      const bindingSql = db.get<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channel_bindings'",
      )?.sql
      if (
        bindingSql &&
        /session_id\b[^,]*ON DELETE CASCADE/i.test(bindingSql)
      ) {
        db.exec(`
          CREATE TABLE channel_bindings_new (
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
            updated_at TEXT NOT NULL,
            UNIQUE (channel, external_id)
          );
          INSERT INTO channel_bindings_new (
            id, channel, external_id, thread_id, kind, project_id, session_id,
            enabled, config_json, created_at, updated_at
          ) SELECT id, channel, external_id, thread_id, kind, project_id, session_id,
            enabled, config_json, created_at, updated_at FROM channel_bindings;
          DROP TABLE channel_bindings;
          ALTER TABLE channel_bindings_new RENAME TO channel_bindings;
          CREATE INDEX IF NOT EXISTS idx_channel_bindings_project
            ON channel_bindings (project_id);
          CREATE INDEX IF NOT EXISTS idx_channel_bindings_session
            ON channel_bindings (session_id);
        `)
      }

      const runsSql = db.get<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'",
      )?.sql
      if (runsSql && !runsSql.includes("'handoff'")) {
        db.exec(`
          CREATE TABLE runs_new (
            id TEXT PRIMARY KEY NOT NULL,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
            driver TEXT NOT NULL DEFAULT 'vela',
            trigger TEXT NOT NULL CHECK (trigger IN ('user', 'channel', 'timer', 'webhook', 'approval', 'job', 'handoff', 'session')),
            status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_human', 'completed', 'stopped', 'failed', 'interrupted')),
            model TEXT,
            error TEXT,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_write_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd REAL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            updated_at TEXT NOT NULL
          );
          INSERT INTO runs_new SELECT * FROM runs;
          DROP TABLE runs;
          ALTER TABLE runs_new RENAME TO runs;
          CREATE INDEX IF NOT EXISTS idx_runs_session_status
            ON runs (session_id, status);
          CREATE INDEX IF NOT EXISTS idx_runs_status
            ON runs (status);
        `)
      }

      const toolCallsSql = db.get<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vela_tool_calls'",
      )?.sql
      if (
        toolCallsSql &&
        /UNIQUE\s*\(\s*run_id\s*,\s*tool_call_id\s*\)/i.test(toolCallsSql)
      ) {
        db.exec(`
          CREATE TABLE vela_tool_calls_new (
            id TEXT PRIMARY KEY NOT NULL,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            assistant_message_id TEXT NOT NULL,
            tool_call_id TEXT NOT NULL,
            call_index INTEGER NOT NULL,
            tool_name TEXT NOT NULL,
            input_json TEXT NOT NULL,
            execution_mode TEXT NOT NULL DEFAULT 'sequential' CHECK (execution_mode IN ('parallel', 'sequential')),
            replay TEXT NOT NULL DEFAULT 'none' CHECK (replay IN ('safe', 'none')),
            location_json TEXT,
            status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'awaiting_approval', 'completed', 'failed', 'skipped', 'interrupted')),
            attempt INTEGER NOT NULL DEFAULT 0,
            is_error INTEGER NOT NULL DEFAULT 0 CHECK (is_error IN (0, 1)),
            preview TEXT,
            result_json TEXT,
            spill_path TEXT,
            details_json TEXT,
            duration_ms INTEGER,
            started_at TEXT,
            finished_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (session_id, assistant_message_id, tool_call_id)
          );
          INSERT INTO vela_tool_calls_new SELECT * FROM vela_tool_calls;
          DROP TABLE vela_tool_calls;
          ALTER TABLE vela_tool_calls_new RENAME TO vela_tool_calls;
          CREATE INDEX IF NOT EXISTS idx_vela_tool_calls_status
            ON vela_tool_calls (session_id, status);
          CREATE INDEX IF NOT EXISTS idx_vela_tool_calls_active_status
            ON vela_tool_calls (status);
          CREATE INDEX IF NOT EXISTS idx_vela_tool_calls_msg
            ON vela_tool_calls (session_id, assistant_message_id, call_index);
        `)
      }
    },
  },
]

export function applyMigrations(
  db: MigrationDatabase,
  options: { readonly?: boolean } = {},
): void {
  const current = db.schemaVersion
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Database "${db.path}" has schema version ${current}, which is newer than supported version ${SCHEMA_VERSION}`,
    )
  }
  const pending = MIGRATIONS.filter((migration) => migration.version > current)
  if (pending.length === 0) return

  if (options.readonly) {
    throw new Error(
      `Database "${db.path}" is at schema version ${current} (requires ${SCHEMA_VERSION}) and cannot be migrated in read-only mode`,
    )
  }

  for (const migration of pending) {
    let reenableFk = false
    if (migration.disableForeignKeys) {
      const fk = db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')
      if (fk?.foreign_keys) {
        db.exec('PRAGMA foreign_keys = OFF')
        reenableFk = true
      }
    }
    try {
      db.transaction(() => {
        const liveVersion = db.schemaVersion
        if (liveVersion > SCHEMA_VERSION) {
          throw new Error(
            `Database "${db.path}" has schema version ${liveVersion}, which is newer than supported version ${SCHEMA_VERSION}`,
          )
        }
        if (liveVersion >= migration.version) return
        migration.migrate(db)
        if (migration.disableForeignKeys) {
          const fkViolation = db.get<Record<string, unknown>>(
            'PRAGMA foreign_key_check',
          )
          if (fkViolation) {
            throw new Error(
              `Foreign key integrity check failed during migration ${migration.name}: ${JSON.stringify(fkViolation)}`,
            )
          }
        }
        db.run(
          'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
          migration.version,
          migration.name,
          new Date().toISOString(),
        )
        db.exec(`PRAGMA user_version = ${migration.version}`)
      }, 'IMMEDIATE')
    } finally {
      if (reenableFk) db.exec('PRAGMA foreign_keys = ON')
    }
  }
}
