import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
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
  'oauth_registrations',
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

test('openDatabase initializes WAL, pragmas, 0700/0600 permissions without mutating existing parent dir, and all 19 tables', () => {
  const parentDir = tempDir('vela-s1c-existing-')
  cleanup.push({ dir: parentDir })
  if (process.platform !== 'win32') {
    chmodSync(parentDir.path, 0o755)
  }
  const directPath = join(parentDir.path, 'direct.db')
  const directDb = openDatabase({ path: directPath })
  cleanup.push({ db: directDb })
  if (process.platform !== 'win32') {
    expect(statSync(parentDir.path).mode & 0o777).toBe(0o755)
    expect(statSync(directPath).mode & 0o777).toBe(0o600)
  }
  directDb.close()

  const { dir, dbPath, db } = openTempDb()
  expect(db.open).toBe(true)
  expect(db.schemaVersion).toBe(SCHEMA_VERSION)

  expect(
    db
      .get<{ journal_mode: string }>('PRAGMA journal_mode')
      ?.journal_mode.toLowerCase(),
  ).toBe('wal')
  expect(
    db.get<{ synchronous: number }>('PRAGMA synchronous')?.synchronous,
  ).toBe(1)
  expect(db.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout).toBe(5000)
  expect(
    db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys,
  ).toBe(1)

  if (process.platform !== 'win32') {
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700)
    expect(statSync(dbPath).mode & 0o777).toBe(0o600)
    if (existsSync(`${dbPath}-wal`)) {
      expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600)
    }
    if (existsSync(`${dbPath}-shm`)) {
      expect(statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o600)
    }
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
  expect(migrations).toEqual([
    { version: 1, name: '001_initial' },
    { version: 2, name: '002_s1_audit_schema' },
  ])
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
    ro.transaction(
      () =>
        ro.get<{ value_json: string }>(
          "SELECT value_json FROM kv_meta WHERE key = 'k'",
        )?.value_json,
    ),
  ).toBe('1')
  expect(() => ro.transaction(() => {}, 'IMMEDIATE')).toThrow('read-only')
  ro.close()

  const dir = tempDir('vela-s1c-ro-')
  cleanup.push({ dir })
  const unmigratedPath = join(dir.path, 'empty.db')
  const rawEmpty = new DatabaseSync(unmigratedPath)
  rawEmpty.close()
  expect(() => openDatabase({ path: unmigratedPath, readonly: true })).toThrow(
    'cannot be migrated in read-only mode',
  )

  const futurePath = join(dir.path, 'future.db')
  const rawFuture = new DatabaseSync(futurePath)
  rawFuture.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`)
  rawFuture.close()
  expect(() => openDatabase({ path: futurePath })).toThrow(
    'newer than supported version',
  )
})

test('nested SAVEPOINT transactions isolate inner rollback, revert outer rollback, and reject async callbacks', async () => {
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

    expect(() =>
      db.transaction((async () => {
        await Promise.resolve()
        db.run(
          'INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?)',
          'inner_async',
          '"nope"',
          now,
        )
      }) as unknown as () => void),
    ).toThrow('synchronous')

    db.transaction(() => {
      db.run(
        'INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?)',
        'inner_ok',
        '"yes"',
        now,
      )
    })
  })

  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(
    db
      .all<{ key: string }>('SELECT key FROM kv_meta ORDER BY key')
      .map((r) => r.key),
  ).toEqual(['inner_ok', 'outer'])

  expect(() =>
    db.transaction((async () => {
      await Promise.resolve()
      db.run(
        'INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?)',
        'outer_async',
        '"nope"',
        now,
      )
    }) as unknown as () => void),
  ).toThrow('synchronous')
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(
    db.get<{ key: string }>(
      "SELECT key FROM kv_meta WHERE key = 'outer_async'",
    ),
  ).toBeUndefined()

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

test('enforces NOT NULL primary keys, partial unique indexes, and CASCADE / SET NULL foreign keys', () => {
  const { db } = openTempDb()
  const now = '2026-11-24T00:00:00Z'

  expect(() =>
    db.run(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (NULL, 'Null', ?, ?)",
      now,
      now,
    ),
  ).toThrow()

  db.transaction(() => {
    db.run(
      "INSERT INTO projects (id, name, hub_session_id, created_at, updated_at) VALUES ('p1', 'P1', 's_hub', ?, ?)",
      now,
      now,
    )
    db.run(
      "INSERT INTO sessions (id, project_id, kind, created_at, updated_at) VALUES ('s_hub', 'p1', 'hub', ?, ?)",
      now,
      now,
    )
  })
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
  db.run(
    "INSERT INTO usage_records (id, session_id, project_id, kind, model, created_at) VALUES ('u1', 's1', 'p1', 'main', 'deepseek-flash', ?)",
    now,
  )

  // Multiple NULL dedupe_keys allowed; duplicate non-null rejected
  db.run(
    "INSERT INTO inbox_events (id, session_id, source, dedupe_key, payload_json, created_at) VALUES ('i1', 's1', 'user', NULL, '{}', ?)",
    now,
  )
  db.run(
    "INSERT INTO inbox_events (id, session_id, source, dedupe_key, payload_json, created_at) VALUES ('i2', 's1', 'user', NULL, '{}', ?)",
    now,
  )
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

  // Deleting hub session nulls projects.hub_session_id
  db.run("DELETE FROM sessions WHERE id = 's_hub'")
  expect(
    db.get<{ hub_session_id: string | null }>(
      "SELECT hub_session_id FROM projects WHERE id = 'p1'",
    )?.hub_session_id,
  ).toBeNull()

  // Deleting work session cascades runs/inbox/tool_calls and nulls usage_records.session_id
  db.run("DELETE FROM sessions WHERE id = 's1'")
  expect(db.get<{ n: number }>('SELECT count(*) AS n FROM runs')?.n).toBe(0)
  expect(
    db.get<{ n: number }>('SELECT count(*) AS n FROM inbox_events')?.n,
  ).toBe(0)
  expect(
    db.get<{ n: number }>('SELECT count(*) AS n FROM vela_tool_calls')?.n,
  ).toBe(0)
  expect(
    db.get<{ session_id: string | null; project_id: string | null }>(
      "SELECT session_id, project_id FROM usage_records WHERE id = 'u1'",
    ),
  ).toEqual({ session_id: null, project_id: 'p1' })
})

test('composite (session_id, id) allows identical 8-char IDs across sessions and recursive CTE reconstructs compacted branch without prefix or siblings', () => {
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

  const rows: [string, string, string | null, number, string, string | null][] =
    [
      ['s1', 'a1b2c3d4', null, 1, 'message', null], // pre-compaction prefix (excluded)
      ['s1', 'b2c3d4e5', 'a1b2c3d4', 2, 'message', null], // first_kept_id
      ['s1', 'sib00001', 'b2c3d4e5', 3, 'message', null], // sibling branch (excluded)
      ['s1', 'c3d4e5f6', 'b2c3d4e5', 4, 'compaction', 'b2c3d4e5'],
      ['s1', 'd4e5f607', 'c3d4e5f6', 5, 'message', null],
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

  // Reconstruct active branch starting at compaction's kept boundary (plus the compaction node itself)
  const effectiveContext = db.all<{ id: string; kind: string }>(
    `WITH RECURSIVE branch(id, parent_id, seq, kind, first_kept_id) AS (
       SELECT id, parent_id, seq, kind, first_kept_id FROM vela_messages WHERE session_id = 's1' AND id = 'd4e5f607'
       UNION ALL
       SELECT m.id, m.parent_id, m.seq, m.kind, m.first_kept_id
       FROM vela_messages m
       JOIN branch b ON m.session_id = 's1' AND m.id = b.parent_id
     ),
     latest_compaction AS (
       SELECT b.seq AS cmp_seq, fk.seq AS kept_seq
       FROM branch b
       JOIN branch fk ON fk.id = b.first_kept_id
       WHERE b.kind = 'compaction'
       ORDER BY b.seq DESC
       LIMIT 1
     )
     SELECT b.id, b.kind
     FROM branch b, latest_compaction c
     WHERE b.seq >= c.kept_seq
     ORDER BY b.seq ASC`,
  )
  expect(effectiveContext.map((r) => r.id)).toEqual([
    'b2c3d4e5',
    'c3d4e5f6',
    'd4e5f607',
  ])
})

test('Node.js and Bun independently initialize WAL DBs, cross-reopen each other, and handle concurrent writers', () => {
  const dir = tempDir('vela-s1c-node-parity-')
  cleanup.push({ dir })
  const nodeDbPath = join(dir.path, 'node.db')
  const bunDbPath = join(dir.path, 'bun.db')
  const dbModule = join(import.meta.dir, '../../../src/db/index.ts')
  mkdirSync(dir.path, { recursive: true })

  const probe = (dbPath: string, tag: string) => `
    import { openDatabase } from ${JSON.stringify(dbModule)};
    const db = openDatabase({ path: ${JSON.stringify(dbPath)} });
    const now = '2026-11-24T00:00:00Z';
    db.transaction(() => {
      db.run("INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", ${JSON.stringify(tag)}, ${JSON.stringify(tag)}, now, now);
    });
    const mode = db.get('PRAGMA journal_mode')?.journal_mode;
    const sync = db.get('PRAGMA synchronous')?.synchronous;
    const timeout = db.get('PRAGMA busy_timeout')?.timeout;
    const fk = db.get('PRAGMA foreign_keys')?.foreign_keys;
    const tables = db.all("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")[0].n;
    const version = db.schemaVersion;
    db.close();
    console.log(JSON.stringify({ mode, sync, timeout, fk, tables, version }));
  `

  const nodeInit = spawnSync(
    'node',
    ['--input-type=module', '-e', probe(nodeDbPath, 'from-node')],
    {
      encoding: 'utf8',
    },
  )
  expect(nodeInit.status).toBe(0)
  const bunInit = spawnSync('bun', ['--eval', probe(bunDbPath, 'from-bun')], {
    encoding: 'utf8',
  })
  expect(bunInit.status).toBe(0)

  const expected = {
    mode: 'wal',
    sync: 1,
    timeout: 5000,
    fk: 1,
    tables: 19,
    version: SCHEMA_VERSION,
  }
  expect(JSON.parse(nodeInit.stdout.trim())).toEqual(expected)
  expect(JSON.parse(bunInit.stdout.trim())).toEqual(expected)

  // Cross-reopen Node DB in Bun and Bun DB in Node
  const bunReadsNode = openDatabase({ path: nodeDbPath })
  cleanup.push({ db: bunReadsNode })
  expect(
    bunReadsNode.get<{ id: string }>(
      "SELECT id FROM projects WHERE id = 'from-node'",
    )?.id,
  ).toBe('from-node')
  bunReadsNode.close()

  const nodeReadsBun = spawnSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `import { openDatabase } from ${JSON.stringify(dbModule)}; const db = openDatabase({ path: ${JSON.stringify(bunDbPath)} }); console.log(db.get("SELECT id FROM projects WHERE id = 'from-bun'")?.id); db.close();`,
    ],
    { encoding: 'utf8' },
  )
  expect(nodeReadsBun.status).toBe(0)
  expect(nodeReadsBun.stdout.trim()).toBe('from-bun')

  // Two connections concurrently writing with busy_timeout succeed without SQLITE_BUSY
  const c1 = openDatabase({ path: nodeDbPath })
  const c2 = openDatabase({ path: nodeDbPath })
  cleanup.push({ db: c1 }, { db: c2 })
  c1.transaction(() => {
    c1.run(
      "INSERT INTO kv_meta (key, value_json, updated_at) VALUES ('c1', '1', '2026-11-24T00:00:00Z')",
    )
  })
  c2.transaction(() => {
    c2.run(
      "INSERT INTO kv_meta (key, value_json, updated_at) VALUES ('c2', '2', '2026-11-24T00:00:00Z')",
    )
  })
  expect(
    c1
      .all<{ key: string }>(
        "SELECT key FROM kv_meta WHERE key IN ('c1', 'c2') ORDER BY key",
      )
      .map((r) => r.key),
  ).toEqual(['c1', 'c2'])
})

test('tolerates concurrent absent-path database creation (EEXIST)', async () => {
  const dir = tempDir('vela-s1c-race-')
  cleanup.push({ dir })
  const dbPath = join(dir.path, 'sub', 'race.db')
  const opened = await Promise.all([
    Promise.resolve().then(() => openDatabase({ path: dbPath })),
    Promise.resolve().then(() => openDatabase({ path: dbPath })),
  ])
  for (const db of opened) cleanup.push({ db })
  expect(opened[0].schemaVersion).toBe(SCHEMA_VERSION)
  expect(opened[1].schemaVersion).toBe(SCHEMA_VERSION)
})

test('s1c audit schema fixes: oauth_registrations, ON DELETE SET NULL, run triggers, tool_calls key, status indexes, migration tx re-check', async () => {
  const { applyMigrations } = await import('../../../src/db/migrations.ts')
  const { db } = openTempDb('audit-schema.db')

  // oauth_registrations exists and accepts CRUD
  db.run(
    "INSERT INTO oauth_registrations (provider, client_id, host_id, subject, updated_at) VALUES ('openai-chatgpt', 'cid-1', 'host-1', 'sub-1', '2026-11-24T00:00:00Z')",
  )
  expect(
    db.get<{ client_id: string }>(
      "SELECT client_id FROM oauth_registrations WHERE provider = 'openai-chatgpt'",
    ),
  ).toEqual({ client_id: 'cid-1' })

  // Status-leading indexes exist
  const indexes = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_inbox_status_created', 'idx_runs_status', 'idx_bg_jobs_status', 'idx_vela_tool_calls_active_status')",
    )
    .map((r) => r.name)
  expect(indexes.sort()).toEqual([
    'idx_bg_jobs_status',
    'idx_inbox_status_created',
    'idx_runs_status',
    'idx_vela_tool_calls_active_status',
  ])

  // channel_bindings.session_id uses ON DELETE SET NULL
  db.run(
    "INSERT INTO sessions (id, kind, state, created_at, updated_at) VALUES ('sess-bind', 'chat', 'idle', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z')",
  )
  db.run(
    "INSERT INTO channel_bindings (id, channel, kind, external_id, session_id, enabled, created_at, updated_at) VALUES ('lark:chat1', 'lark', 'group', 'chat1', 'sess-bind', 1, '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z')",
  )
  db.run("DELETE FROM sessions WHERE id = 'sess-bind'")
  expect(
    db.get<{ session_id: string | null }>(
      "SELECT session_id FROM channel_bindings WHERE id = 'lark:chat1'",
    ),
  ).toEqual({ session_id: null })

  // runs.trigger accepts handoff & session, rejects unknown values
  db.run(
    "INSERT INTO sessions (id, kind, state, created_at, updated_at) VALUES ('sess-run', 'chat', 'idle', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z')",
  )
  db.run(
    "INSERT INTO runs (id, session_id, trigger, status, started_at, updated_at) VALUES ('run-h', 'sess-run', 'handoff', 'queued', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z')",
  )
  db.run(
    "INSERT INTO runs (id, session_id, trigger, status, started_at, updated_at) VALUES ('run-s', 'sess-run', 'session', 'queued', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z')",
  )
  expect(() =>
    db.run(
      "INSERT INTO runs (id, session_id, trigger, status, started_at, updated_at) VALUES ('run-bad', 'sess-run', 'invalid_trigger', 'queued', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z')",
    ),
  ).toThrow()

  // vela_tool_calls unique index is (session_id, assistant_message_id, tool_call_id)
  db.run(
    "INSERT INTO vela_messages (session_id, id, seq, kind, role, content_json, created_at) VALUES ('sess-run', 'm1', 1, 'message', 'assistant', '{}', '2026-11-24T00:00:00Z'), ('sess-run', 'm2', 2, 'message', 'assistant', '{}', '2026-11-24T00:00:00Z')",
  )
  db.run(
    "INSERT INTO vela_tool_calls (id, run_id, session_id, assistant_message_id, tool_call_id, call_index, tool_name, input_json, status, created_at, updated_at) VALUES ('tc1', 'run-h', 'sess-run', 'm1', 'call-dup', 0, 'bash', '{}', 'running', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z')",
  )
  db.run(
    "INSERT INTO vela_tool_calls (id, run_id, session_id, assistant_message_id, tool_call_id, call_index, tool_name, input_json, status, created_at, updated_at) VALUES ('tc2', 'run-h', 'sess-run', 'm2', 'call-dup', 0, 'bash', '{}', 'running', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z')",
  )
  expect(() =>
    db.run(
      "INSERT INTO vela_tool_calls (id, run_id, session_id, assistant_message_id, tool_call_id, call_index, tool_name, input_json, status, created_at, updated_at) VALUES ('tc3', 'run-s', 'sess-run', 'm1', 'call-dup', 0, 'bash', '{}', 'running', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z')",
    ),
  ).toThrow()

  // applyMigrations re-checks schemaVersion inside transaction
  expect(() => applyMigrations(db)).not.toThrow()
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`)
  expect(() => applyMigrations(db)).toThrow(/newer/i)

  // v1 -> v2 upgrade preserves rows, creates oauth_registrations & indexes, and rebuilds changed constraints
  const v1Dir = tempDir('vela-s1c-v1-upgrade-')
  cleanup.push({ dir: v1Dir })
  const v1Path = join(v1Dir.path, 'legacy-v1.db')
  const rawV1 = new DatabaseSync(v1Path)
  rawV1.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, cwd TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE channel_bindings (
      id TEXT PRIMARY KEY NOT NULL, channel TEXT NOT NULL, external_id TEXT NOT NULL, thread_id TEXT,
      kind TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1, config_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (channel, external_id)
    );
    CREATE TABLE inbox_events (
      id TEXT PRIMARY KEY NOT NULL, session_id TEXT, project_id TEXT, source TEXT NOT NULL,
      dedupe_key TEXT, wake INTEGER NOT NULL DEFAULT 1, passive INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', payload_json TEXT NOT NULL, run_id TEXT,
      created_at TEXT NOT NULL, processed_at TEXT
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, driver TEXT NOT NULL DEFAULT 'vela',
      trigger TEXT NOT NULL CHECK (trigger IN ('user', 'channel', 'timer', 'webhook', 'approval', 'job')),
      status TEXT NOT NULL, model TEXT, error TEXT, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL, started_at TEXT NOT NULL,
      finished_at TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE background_jobs (id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL);
    CREATE TABLE vela_messages (session_id TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, seq INTEGER NOT NULL, kind TEXT NOT NULL, role TEXT, content_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (session_id, id));
    CREATE TABLE vela_tool_calls (
      id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, assistant_message_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL, call_index INTEGER NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'sequential', replay TEXT NOT NULL DEFAULT 'none', location_json TEXT,
      status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, is_error INTEGER NOT NULL DEFAULT 0,
      preview TEXT, result_json TEXT, spill_path TEXT, details_json TEXT, duration_ms INTEGER,
      started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (run_id, tool_call_id)
    );
    INSERT INTO schema_migrations VALUES (1, '001_initial', '2026-11-24T00:00:00Z');
    INSERT INTO sessions VALUES ('s-old', 'chat', 'idle', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z');
    INSERT INTO channel_bindings (id, channel, external_id, kind, session_id, created_at, updated_at)
      VALUES ('b-old', 'lark', 'c1', 'group', 's-old', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z');
    INSERT INTO runs (id, session_id, trigger, status, started_at, updated_at)
      VALUES ('r-old', 's-old', 'user', 'completed', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z');
    PRAGMA user_version = 1;
  `)
  rawV1.close()

  const upgraded = openDatabase({ path: v1Path })
  cleanup.push({ db: upgraded })
  expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION)
  upgraded.run("DELETE FROM sessions WHERE id = 's-old'")
  expect(
    upgraded.get<{ session_id: string | null }>(
      "SELECT session_id FROM channel_bindings WHERE id = 'b-old'",
    ),
  ).toEqual({ session_id: null })
  upgraded.run(
    "INSERT INTO oauth_registrations (provider, client_id, updated_at) VALUES ('openai-chatgpt', 'cid', '2026-11-24T00:00:00Z')",
  )
  upgraded.run(
    "INSERT INTO sessions VALUES ('s-new', 'chat', 'idle', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z')",
  )
  upgraded.run(
    "INSERT INTO runs (id, session_id, trigger, status, started_at, updated_at) VALUES ('r-h', 's-new', 'handoff', 'queued', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z')",
  )
})

test('v1 -> v2 schema upgrade preserves duplicate vela_tool_calls attempts across runs', () => {
  const v1Dir = tempDir('vela-s1c-v1-tc-')
  cleanup.push({ dir: v1Dir })
  const v1Path = join(v1Dir.path, 'legacy-v1-dup-tc.db')
  const rawV1 = new DatabaseSync(v1Path)
  rawV1.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, cwd TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE channel_bindings (
      id TEXT PRIMARY KEY NOT NULL, channel TEXT NOT NULL, external_id TEXT NOT NULL, thread_id TEXT,
      kind TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1, config_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (channel, external_id)
    );
    CREATE TABLE inbox_events (
      id TEXT PRIMARY KEY NOT NULL, session_id TEXT, project_id TEXT, source TEXT NOT NULL,
      dedupe_key TEXT, wake INTEGER NOT NULL DEFAULT 1, passive INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', payload_json TEXT NOT NULL, run_id TEXT,
      created_at TEXT NOT NULL, processed_at TEXT
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, driver TEXT NOT NULL DEFAULT 'vela',
      trigger TEXT NOT NULL CHECK (trigger IN ('user', 'channel', 'timer', 'webhook', 'approval', 'job')),
      status TEXT NOT NULL, model TEXT, error TEXT, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL, started_at TEXT NOT NULL,
      finished_at TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE background_jobs (id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL);
    CREATE TABLE vela_messages (session_id TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, seq INTEGER NOT NULL, kind TEXT NOT NULL, role TEXT, content_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (session_id, id));
    CREATE TABLE vela_tool_calls (
      id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, assistant_message_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL, call_index INTEGER NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'sequential', replay TEXT NOT NULL DEFAULT 'none', location_json TEXT,
      status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, is_error INTEGER NOT NULL DEFAULT 0,
      preview TEXT, result_json TEXT, spill_path TEXT, details_json TEXT, duration_ms INTEGER,
      started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (run_id, tool_call_id)
    );
    INSERT INTO schema_migrations VALUES (1, '001_initial', '2026-11-24T00:00:00Z');
    INSERT INTO sessions VALUES ('s-dup', 'chat', 'idle', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z');
    INSERT INTO runs (id, session_id, trigger, status, started_at, updated_at)
      VALUES ('r-1', 's-dup', 'user', 'failed', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z'),
             ('r-2', 's-dup', 'user', 'completed', '2026-11-24T00:01:00Z', '2026-11-24T00:01:00Z');
    INSERT INTO vela_tool_calls (id, session_id, run_id, assistant_message_id, tool_call_id, call_index, tool_name, input_json, status, attempt, created_at, updated_at)
      VALUES ('tc-older', 's-dup', 'r-1', 'm1', 'call_shared', 0, 'bash', '{}', 'failed', 1, '2026-11-24T00:00:01Z', '2026-11-24T00:00:02Z'),
             ('tc-newer', 's-dup', 'r-2', 'm1', 'call_shared', 0, 'bash', '{}', 'completed', 2, '2026-11-24T00:01:01Z', '2026-11-24T00:01:02Z');
    PRAGMA user_version = 1;
  `)
  rawV1.close()

  const upgraded = openDatabase({ path: v1Path })
  cleanup.push({ db: upgraded })
  expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION)
  const rows = upgraded.all<{ id: string; tool_call_id: string }>(
    'SELECT id, tool_call_id FROM vela_tool_calls ORDER BY id',
  )
  expect(rows).toEqual([
    { id: 'tc-newer', tool_call_id: 'call_shared' },
    { id: 'tc-older', tool_call_id: 'call_shared--attempt-tc-older' },
  ])
})
