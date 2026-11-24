import { INITIAL_SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts'

export interface MigrationDatabase {
  readonly path: string
  readonly schemaVersion: number
  exec(sql: string): void
  run(
    sql: string,
    ...params: (string | number | bigint | Uint8Array | null)[]
  ): unknown
  transaction<T>(fn: () => T, mode?: 'IMMEDIATE' | 'DEFERRED'): T
}

interface Migration {
  version: number
  name: string
  sql: string
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '001_initial',
    sql: INITIAL_SCHEMA_SQL,
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
    db.transaction(() => {
      db.exec(migration.sql)
      db.run(
        'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        migration.version,
        migration.name,
        new Date().toISOString(),
      )
      db.exec(`PRAGMA user_version = ${migration.version}`)
    }, 'IMMEDIATE')
  }
}
