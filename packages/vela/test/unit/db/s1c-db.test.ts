import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from '../../../../../test/support/vela.ts'
import {
  openDatabase,
  SCHEMA_VERSION,
  type VelaDatabase,
} from '../../../src/db/index.ts'

const cleanup: { dir?: { cleanup(): void }; db?: VelaDatabase }[] = []

afterEach(() => {
  for (const item of cleanup.splice(0)) {
    item.db?.close()
    item.dir?.cleanup()
  }
})

function openTempDb(name = 'vela.db') {
  const dir = tempDir('vela-s1c-db-')
  const dbPath = join(dir.path, 'nested', name)
  const db = openDatabase({ path: dbPath })
  cleanup.push({ dir, db })
  return { dir: dir.path, dbPath, db }
}

const EXPECTED_TABLES = [
  'approvals',
  'background_jobs',
  'blobs',
  'channel_bindings',
  'events',
  'inbox_events',
  'kv_meta',
  'outbox',
  'projects',
  'runs',
  'schema_migrations',
  'sessions',
  'subscriptions',
  'timers',
  'trusted_paths',
  'usage_records',
  'vela_messages',
  'vela_tool_calls',
]

test('openDatabase initializes WAL, foreign keys, 0700/0600 permissions, and all 18 tables', () => {
  const { dir, dbPath, db } = openTempDb()
  expect(db.open).toBe(true)
  expect(db.schemaVersion).toBe(SCHEMA_VERSION)

  const journal = db.get<{ journal_mode: string }>('PRAGMA journal_mode')
  expect(journal?.journal_mode.toLowerCase()).toBe('wal')

  const fk = db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')
  expect(fk?.foreign_keys).toBe(1)

  if (process.platform !== 'win32') {
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700)
    expect(statSync(dbPath).mode & 0o777).toBe(0o600)
  }

  const tables = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((row) => row.name)
  expect(tables).toEqual(EXPECTED_TABLES)

  const migrations = db.all<{ version: number; name: string }>(
    'SELECT version, name FROM schema_migrations',
  )
  expect(migrations).toEqual([{ version: 1, name: '001_initial' }])

  // Rows are plain objects (not null-prototype)
  expect(Object.getPrototypeOf(migrations[0])).toBe(Object.prototype)

  db.close()
  expect(db.open).toBe(false)
  expect(() => db.get('SELECT 1')).toThrow('already closed')
})

test('openDatabase supports :memory:, idempotent re-open, readonly guards, and rejects newer schemas', () => {
  const mem = openDatabase({ path: ':memory:' })
  cleanup.push({ db: mem })
  expect(mem.schemaVersion).toBe(SCHEMA_VERSION)
  expect(
    mem.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys,
  ).toBe(1)

  const { dbPath, db } = openTempDb()
  db.run(
    "INSERT INTO kv_meta (key, value_json, updated_at) VALUES ('k', '1', '2026-11-24T00:00:00Z')",
  )
  db.close()

  const reopened = openDatabase({ path: dbPath })
  cleanup.push({ db: reopened })
  expect(reopened.schemaVersion).toBe(SCHEMA_VERSION)
  expect(
    reopened.get<{ value_json: string }>(
      "SELECT value_json FROM kv_meta WHERE key = 'k'",
    )?.value_json,
  ).toBe('1')
  reopened.close()

  const ro = openDatabase({ path: dbPath, readonly: true })
  cleanup.push({ db: ro })
  expect(
    ro.get<{ value_json: string }>(
      "SELECT value_json FROM kv_meta WHERE key = 'k'",
    )?.value_json,
  ).toBe('1')
  expect(
    ro.transaction(
      () =>
        ro.get<{ value_json: string }>(
          "SELECT value_json FROM kv_meta WHERE key = 'k'",
        )?.value_json,
    ),
  ).toBe('1')
  expect(() => ro.transaction(() => {}, 'IMMEDIATE')).toThrow('read-only')
  ro.close()

  // Unmigrated DB cannot open readonly
  const dir = tempDir('vela-s1c-ro-')
  cleanup.push({ dir })
  const unmigratedPath = join(dir.path, 'empty.db')
  const rawEmpty = new DatabaseSync(unmigratedPath)
  rawEmpty.close()
  expect(() => openDatabase({ path: unmigratedPath, readonly: true })).toThrow(
    'cannot be migrated in read-only mode',
  )

  // Newer schema version refuses downgrade
  const futurePath = join(dir.path, 'future.db')
  const rawFuture = new DatabaseSync(futurePath)
  rawFuture.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`)
  rawFuture.close()
  expect(() => openDatabase({ path: futurePath })).toThrow(
    'newer than supported version',
  )
})

test('nested SAVEPOINT transactions isolate inner rollback and revert all on outer rollback', () => {
  const { db } = openTempDb()
  const now = '2026-11-24T00:00:00Z'

  db.transaction(() => {
    db.run(
      'INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?)',
      'outer',
      '"ok"',
      now,
    )
    expect(() =>
      db.transaction(() => {
        db.run(
          'INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?)',
          'inner_fail',
          '"nope"',
          now,
        )
        throw new Error('boom-inner')
      }),
    ).toThrow('boom-inner')

    db.transaction(() => {
      db.run(
        'INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?)',
        'inner_ok',
        '"yes"',
        now,
      )
    })
  })

  expect(
    db
      .all<{ key: string }>('SELECT key FROM kv_meta ORDER BY key')
      .map((r) => r.key),
  ).toEqual(['inner_ok', 'outer'])

  expect(() =>
    db.transaction(() => {
      db.run(
        'INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?)',
        'outer_fail',
        '"nope"',
        now,
      )
      throw new Error('boom-outer')
    }),
  ).toThrow('boom-outer')

  expect(
    db.get<{ key: string }>("SELECT key FROM kv_meta WHERE key = 'outer_fail'"),
  ).toBeUndefined()
})

test('enforces partial unique index on inbox_events, unique bindings, and tool_calls', () => {
  const { db } = openTempDb()
  const now = '2026-11-24T00:00:00Z'

  db.run(
    "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P1', ?, ?)",
    now,
    now,
  )
  db.run(
    "INSERT INTO sessions (id, project_id, kind, created_at, updated_at) VALUES ('s1', 'p1', 'work', ?, ?)",
    now,
    now,
  )
  db.run(
    "INSERT INTO runs (id, session_id, project_id, trigger, status, started_at, updated_at) VALUES ('r1', 's1', 'p1', 'user', 'running', ?, ?)",
    now,
    now,
  )

  // Multiple NULL dedupe_keys allowed
  db.run(
    "INSERT INTO inbox_events (id, session_id, source, dedupe_key, payload_json, created_at) VALUES ('i1', 's1', 'user', NULL, '{}', ?)",
    now,
  )
  db.run(
    "INSERT INTO inbox_events (id, session_id, source, dedupe_key, payload_json, created_at) VALUES ('i2', 's1', 'user', NULL, '{}', ?)",
    now,
  )

  // Duplicate non-null (source, dedupe_key) rejected
  db.run(
    "INSERT INTO inbox_events (id, session_id, source, dedupe_key, payload_json, created_at) VALUES ('i3', 's1', 'lark', 'msg_1', '{}', ?)",
    now,
  )
  expect(() =>
    db.run(
      "INSERT INTO inbox_events (id, session_id, source, dedupe_key, payload_json, created_at) VALUES ('i4', 's1', 'lark', 'msg_1', '{}', ?)",
      now,
    ),
  ).toThrow()

  // Duplicate channel_bindings (channel, external_id) rejected
  db.run(
    "INSERT INTO channel_bindings (id, channel, external_id, kind, project_id, created_at, updated_at) VALUES ('b1', 'lark', 'oc_1', 'group', 'p1', ?, ?)",
    now,
    now,
  )
  expect(() =>
    db.run(
      "INSERT INTO channel_bindings (id, channel, external_id, kind, project_id, created_at, updated_at) VALUES ('b2', 'lark', 'oc_1', 'group', 'p1', ?, ?)",
      now,
      now,
    ),
  ).toThrow()

  // Duplicate vela_tool_calls (run_id, tool_call_id) rejected
  db.run(
    "INSERT INTO vela_tool_calls (id, session_id, run_id, assistant_message_id, tool_call_id, call_index, tool_name, input_json, status, created_at, updated_at) VALUES ('tc1', 's1', 'r1', 'm1', 'call_1', 0, 'read', '{}', 'pending', ?, ?)",
    now,
    now,
  )
  expect(() =>
    db.run(
      "INSERT INTO vela_tool_calls (id, session_id, run_id, assistant_message_id, tool_call_id, call_index, tool_name, input_json, status, created_at, updated_at) VALUES ('tc2', 's1', 'r1', 'm1', 'call_1', 1, 'read', '{}', 'pending', ?, ?)",
      now,
      now,
    ),
  ).toThrow()
})

test('composite (session_id, id) allows identical 8-char IDs across sessions and recursive CTE stops at compaction boundary', () => {
  const { db } = openTempDb()
  const now = '2026-11-24T00:00:00Z'
  for (const sid of ['s1', 's2']) {
    db.run(
      "INSERT INTO sessions (id, kind, created_at, updated_at) VALUES (?, 'chat', ?, ?)",
      sid,
      now,
      now,
    )
  }

  // Two sessions reuse the exact same short IDs without colliding
  const rows: [string, string, string | null, number, string, string | null][] =
    [
      ['s1', 'a1b2c3d4', null, 1, 'message', null],
      ['s1', 'b2c3d4e5', 'a1b2c3d4', 2, 'message', null],
      ['s1', 'c3d4e5f6', 'b2c3d4e5', 3, 'compaction', 'b2c3d4e5'],
      ['s1', 'd4e5f607', 'c3d4e5f6', 4, 'message', null],
      ['s2', 'a1b2c3d4', null, 1, 'message', null],
    ]
  for (const [sid, id, parentId, seq, kind, firstKept] of rows) {
    db.run(
      `INSERT INTO vela_messages (session_id, id, parent_id, seq, kind, role, content_json, first_kept_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?)`,
      sid,
      id,
      parentId,
      seq,
      kind,
      JSON.stringify({ role: 'user', content: `${sid}:${id}` }),
      firstKept,
      now,
    )
  }

  const branch = db.all<{ id: string; depth: number }>(
    `WITH RECURSIVE tree(id, parent_id, seq, depth) AS (
       SELECT id, parent_id, seq, 0 FROM vela_messages WHERE session_id = 's1' AND id = 'd4e5f607'
       UNION ALL
       SELECT m.id, m.parent_id, m.seq, t.depth + 1
       FROM vela_messages m
       JOIN tree t ON m.session_id = 's1' AND m.id = t.parent_id
     )
     SELECT id, depth FROM tree ORDER BY seq ASC`,
  )
  expect(branch.map((r) => r.id)).toEqual([
    'a1b2c3d4',
    'b2c3d4e5',
    'c3d4e5f6',
    'd4e5f607',
  ])
})

test('Node.js and Bun produce identical SQLite WAL and migration behavior', () => {
  const dir = tempDir('vela-s1c-node-parity-')
  cleanup.push({ dir })
  const dbPath = join(dir.path, 'parity.db')
  const dbModule = join(import.meta.dir, '../../../src/db/index.ts')
  mkdirSync(dir.path, { recursive: true })

  const script = `
    import { openDatabase } from ${JSON.stringify(dbModule)};
    const db = openDatabase({ path: ${JSON.stringify(dbPath)} });
    const now = '2026-11-24T00:00:00Z';
    db.transaction(() => {
      db.run("INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'Parity', ?, ?)", now, now);
      db.run("INSERT OR IGNORE INTO sessions (id, project_id, kind, created_at, updated_at) VALUES ('s1', 'p1', 'work', ?, ?)", now, now);
    });
    const mode = db.get('PRAGMA journal_mode')?.journal_mode;
    const tables = db.all("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")[0].n;
    const version = db.schemaVersion;
    db.close();
    console.log(JSON.stringify({ mode, tables, version }));
  `

  const nodeRun = spawnSync('node', ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  })
  expect(nodeRun.status).toBe(0)
  const nodeOut = JSON.parse(nodeRun.stdout.trim())

  const bunRun = spawnSync('bun', ['--eval', script], { encoding: 'utf8' })
  expect(bunRun.status).toBe(0)
  const bunOut = JSON.parse(bunRun.stdout.trim())

  expect(nodeOut).toEqual({ mode: 'wal', tables: 18, version: SCHEMA_VERSION })
  expect(bunOut).toEqual(nodeOut)
  expect(existsSync(dbPath)).toBe(true)
})
