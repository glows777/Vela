import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../../../../../test/support/vela.ts'
import { migrateLegacyVelaDir, openDatabase } from '../../../src/db/index.ts'
import { convertV1ToEntries } from '../../../src/db/migrate-legacy-v1.ts'

const dirs: { cleanup(): void }[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

test('V1 legacy transcript synthetic IDs are deterministic independent of wall clock and preserve persisted timestamped IDs', () => {
  const lines = [
    {
      type: 'checkpoint',
      timestamp: '2026-11-24T00:00:00.000Z',
      messages: [
        {
          message: { role: 'user', content: 'hello' },
        },
        {
          timestamp: '2026-11-24T00:00:01.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
          },
        },
      ],
    },
  ]
  const origToIso = Date.prototype.toISOString
  let tick = 0
  Date.prototype.toISOString = () =>
    `2026-11-24T00:00:0${(tick++ % 9) + 1}.000Z`
  try {
    const r1 = convertV1ToEntries('v1-det', lines, '/tmp/v1.jsonl', [])
    const r2 = convertV1ToEntries('v1-det', lines, '/tmp/v1.jsonl', [])
    expect(r1.entries.length).toBe(2)
    expect(r1.entries.map((e) => e.id)).toEqual(r2.entries.map((e) => e.id))
  } finally {
    Date.prototype.toISOString = origToIso
  }
})

const envRef = (name: string) => `$${'{'}${name}}`

test('resolver safety, subscription collision, project cwd backfill, invalid/targetless routines, multi-dataDir scoping, unresolved env, custom_message array normalization', () => {
  const root = tempDir('vela-s1c-audit-')
  dirs.push(root)
  const agentDir = join(root.path, 'agent')
  const projectA = join(agentDir, 'projects', 'proj-a')
  const projectB = join(agentDir, 'projects', 'proj-b')
  const projectC = join(agentDir, 'projects', 'proj-c')
  mkdirSync(join(agentDir, 'channels'), { recursive: true })
  mkdirSync(join(agentDir, 'local'), { recursive: true })
  mkdirSync(join(projectA, 'channels'), { recursive: true })
  mkdirSync(join(projectA, 'local'), { recursive: true })
  mkdirSync(join(projectA, 'sessions'), { recursive: true })
  mkdirSync(join(projectB, 'channels'), { recursive: true })
  mkdirSync(join(projectC, 'channels'), { recursive: true })

  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      lark: {
        timezone: envRef('MISSING_TZ'),
        chats: [
          {
            id: envRef('MISSING_CHAT'),
            readUntagged: false,
            environment: envRef('MISSING_ENV'),
          },
          {
            id: 'oc_partial',
            readUntagged: false,
            environment: envRef('MISSING_ENV'),
          },
        ],
      },
    }),
  )

  // Unsafe local proj.id ('../escape') must not crash or escape local dir; proj.sessionId participates in collision check
  writeFileSync(
    join(projectA, 'local', 'projects.json'),
    JSON.stringify({
      projects: [
        { id: '../escape', name: 'Bad' },
        {
          id: 'proj-1',
          name: 'Proj 1',
          cwd: '/tmp/work-1',
          sessionId: 'shared-local-sess',
        },
      ],
    }),
  )
  // Custom message array with legacy 'reasoning' part tag
  writeFileSync(
    join(projectA, 'sessions', 'cm-sess.jsonl'),
    `${[
      JSON.stringify({
        type: 'session',
        version: 2,
        id: 'cm-sess',
        timestamp: '2026-11-24T00:00:00.000Z',
      }),
      JSON.stringify({
        type: 'custom_message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-11-24T00:00:01.000Z',
        customType: 'ext-note',
        display: true,
        content: [{ type: 'reasoning', text: 'legacy-thought' }],
      }),
    ].join('\n')}\n`,
  )

  // Multi-dataDir channel index sharing same channel key ('shared-key') and legacy handoff note
  writeFileSync(
    join(projectA, 'channels', 'index.json'),
    JSON.stringify({
      records: [
        {
          key: 'shared-key',
          channel: 'lark',
          chatId: 'oc_a',
          chatKind: 'direct',
          activeSessionId: 'sess-a',
        },
      ],
      notes: {
        'shared-group': ['handoff from A'],
      },
    }),
  )
  writeFileSync(
    join(projectB, 'channels', 'index.json'),
    JSON.stringify({
      records: [
        {
          key: 'shared-key',
          channel: 'lark',
          chatId: 'oc_b',
          chatKind: 'direct',
          activeSessionId: 'sess-b',
        },
      ],
      notes: {
        'shared-group': ['handoff from B'],
      },
    }),
  )

  // Subscriptions without targetKey colliding across dataDirs
  writeFileSync(
    join(projectA, 'channels', 'subscriptions.json'),
    JSON.stringify({
      subscriptions: [
        {
          id: 'sub-a',
          source: 'github',
          key: 'org/repo',
          channel: 'lark',
          chatId: 'oc_sub',
        },
      ],
    }),
  )
  writeFileSync(
    join(projectB, 'channels', 'subscriptions.json'),
    JSON.stringify({
      subscriptions: [
        {
          id: 'sub-b',
          source: 'github',
          key: 'org/repo2',
          channel: 'lark',
          chatId: 'oc_sub',
        },
      ],
    }),
  )

  // Invalid routine schedule + targetless routine must not be enabled
  writeFileSync(
    join(projectC, 'channels', 'routines.json'),
    JSON.stringify({
      routines: [
        {
          id: 'bad-sched',
          channel: 'lark',
          chatId: 'oc_a',
          message: 'bad',
          schedule: { time: '99:99' },
        },
        {
          id: 'no-target',
          channel: 'lark',
          chatId: 'oc_orphan',
          message: 'orphan',
          schedule: { time: '09:00' },
        },
      ],
    }),
  )

  const db = openDatabase({ path: join(agentDir, 'vela.db') })
  try {
    // Seed project without cwd so ensureProject COALESCE backfills it
    db.run(
      "INSERT INTO projects (id, name, cwd, created_at, updated_at) VALUES ('proj-1', 'Proj 1', NULL, '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z')",
    )

    // Seed pre-audit legacy-note:<group>:<idx> row and ensure retry reconciles without duplication
    db.run(
      "INSERT INTO inbox_events (id, source, dedupe_key, wake, passive, status, payload_json, created_at) VALUES ('old-note', 'handoff', 'legacy-note:shared-group:0', 0, 0, 'pending', ?, '2026-11-24T00:00:00Z')",
      JSON.stringify({
        type: 'handoff_note',
        groupKey: 'shared-group',
        text: 'handoff from A',
      }),
    )

    // Pass 1 without env -> unresolved ${MISSING_TZ}, ${MISSING_CHAT}, ${MISSING_ENV} keep migration incomplete
    const pass1 = migrateLegacyVelaDir({ agentDir, db })
    expect(pass1.skipped).toBe(false)
    expect(pass1.warnings.join('\n')).toMatch(/invalid schedule/i)
    expect(
      db.get<{ cwd: string | null }>(
        "SELECT cwd FROM projects WHERE id = 'proj-1'",
      ),
    ).toEqual({ cwd: '/tmp/work-1' })

    expect(
      db.get<{ id: string }>("SELECT id FROM timers WHERE id = 'bad-sched'"),
    ).toBeUndefined()
    // Targetless routine under unresolved channel timezone is deferred instead of pinned to host timezone
    expect(
      db.get<{ id: string }>("SELECT id FROM timers WHERE id = 'no-target'"),
    ).toBeUndefined()

    // Partial offline config_json has readUntagged=false without literal $MISSING_ENV
    const partialBinding1 = db.get<{ config_json: string | null }>(
      "SELECT config_json FROM channel_bindings WHERE external_id = 'oc_partial'",
    )
    expect(JSON.parse(partialBinding1!.config_json!)).toEqual({
      readUntagged: false,
    })

    // Both A and B handoff notes imported (legacy row rekeyed cleanly + second dir inserted -> total 2)
    const handoffRows = db.all<{
      dedupe_key: string | null
      payload_json: string
    }>(
      "SELECT dedupe_key, payload_json FROM inbox_events WHERE source = 'handoff' ORDER BY dedupe_key",
    )
    expect(handoffRows.length).toBe(2)

    // Disambiguated subscription fallback sessions
    const subRows = db.all<{ id: string; session_id: string | null }>(
      'SELECT id, session_id FROM subscriptions ORDER BY id',
    )
    expect(subRows.length).toBe(2)
    expect(subRows[0]?.session_id).not.toBe(subRows[1]?.session_id)

    // Custom message array normalized legacy 'reasoning' into legal user 'text'
    const cm = db.get<{ content_json: string }>(
      "SELECT content_json FROM vela_messages WHERE session_id = 'cm-sess' AND id = 'e1'",
    )
    expect(JSON.parse(cm!.content_json)).toEqual({
      customType: 'ext-note',
      display: true,
      content: [{ type: 'text', text: 'legacy-thought' }],
    })

    // Retry with env completes config_json backfill, unresolved chat binding, and deferred timer timezone
    const pass2 = migrateLegacyVelaDir({
      agentDir,
      db,
      env: {
        MISSING_TZ: 'UTC',
        MISSING_CHAT: 'oc_resolved',
        MISSING_ENV: 'docker',
      },
    })
    expect(pass2.skipped).toBe(false)
    expect(
      db.get<{ project_id: string | null }>(
        "SELECT project_id FROM channel_bindings WHERE external_id = 'oc_resolved'",
      ),
    ).toEqual({ project_id: 'lark-group:oc_resolved' })
    const partialBinding2 = db.get<{ config_json: string | null }>(
      "SELECT config_json FROM channel_bindings WHERE external_id = 'oc_partial'",
    )
    expect(JSON.parse(partialBinding2!.config_json!)).toEqual({
      readUntagged: false,
      environment: 'docker',
    })
    expect(
      db.get<{ timezone: string; enabled: number }>(
        "SELECT timezone, enabled FROM timers WHERE id = 'no-target'",
      ),
    ).toEqual({ timezone: 'UTC', enabled: 0 })
  } finally {
    db.close()
  }
})

test('V1 checkpoint retry after appended message shifting compaction seq preserves existing compaction ID and imports added message', () => {
  const dir = tempDir('vela-s1c-v1-shift-')
  dirs.push(dir)
  const agentDir = join(dir.path, 'agent')
  const sessDir = join(agentDir, 'sessions')
  mkdirSync(sessDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ lark: { timezone: '$PENDING_RETRY_TZ' } }),
  )
  const jsonlPath = join(sessDir, 'v1-shift.jsonl')
  writeFileSync(
    jsonlPath,
    `${JSON.stringify({
      type: 'checkpoint',
      timestamp: '2026-11-24T00:00:00.000Z',
      messages: [
        {
          timestamp: '2026-11-24T00:00:00.500Z',
          message: {
            role: 'user',
            content: '[Summary of the earlier conversation]\nearlier summary',
          },
        },
        {
          timestamp: '2026-11-24T00:00:01.000Z',
          message: { role: 'user', content: 'hello' },
        },
      ],
      summary: 'earlier summary',
    })}\n`,
  )

  const db = openDatabase({ path: join(dir.path, 'vela.db') })
  try {
    migrateLegacyVelaDir({ agentDir, db })
    const initialRows = db.all<{
      id: string
      seq: number
      kind: string
      content_json: string
    }>(
      "SELECT id, seq, kind, content_json FROM vela_messages WHERE session_id = 'v1-shift' ORDER BY seq",
    )
    expect(initialRows.map((r) => r.kind)).toEqual(['message', 'compaction'])
    const initialCompId = initialRows[1]!.id

    // Now simulate v1 checkpoint growing with another message before the compaction summary shifts seq
    writeFileSync(
      jsonlPath,
      `${JSON.stringify({
        type: 'checkpoint',
        timestamp: '2026-11-24T00:00:00.000Z',
        messages: [
          {
            timestamp: '2026-11-24T00:00:00.500Z',
            message: {
              role: 'user',
              content: '[Summary of the earlier conversation]\nearlier summary',
            },
          },
          {
            timestamp: '2026-11-24T00:00:01.000Z',
            message: { role: 'user', content: 'hello' },
          },
          {
            timestamp: '2026-11-24T00:00:02.000Z',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'added later' }],
            },
          },
        ],
        summary: 'earlier summary',
      })}\n`,
    )

    migrateLegacyVelaDir({
      agentDir,
      db,
      env: { PENDING_RETRY_TZ: 'UTC' },
    })
    const updatedRows = db.all<{
      id: string
      parent_id: string | null
      seq: number
      kind: string
      content_json: string
      first_kept_id: string | null
    }>(
      "SELECT id, parent_id, seq, kind, content_json, first_kept_id FROM vela_messages WHERE session_id = 'v1-shift' ORDER BY seq",
    )
    expect(updatedRows).toHaveLength(3)
    expect(updatedRows.map((r) => r.kind)).toEqual([
      'message',
      'message',
      'compaction',
    ])
    expect(updatedRows[0]!.parent_id).toBeNull()
    expect(updatedRows[1]!.parent_id).toBe(updatedRows[0]!.id)
    expect(updatedRows[1]!.content_json).toContain('added later')
    expect(updatedRows[2]!.id).toBe(initialCompId)
    expect(updatedRows[2]!.parent_id).toBe(updatedRows[1]!.id)
    expect(updatedRows[2]!.first_kept_id).toBe(updatedRows[0]!.id)
    expect(
      db.get<{ leaf_message_id: string | null }>(
        "SELECT leaf_message_id FROM sessions WHERE id = 'v1-shift'",
      )?.leaf_message_id,
    ).toBe(initialCompId)
  } finally {
    db.close()
  }
})

test('env: {} defers unresolved $TZ and $ENVIRONMENT like omitted env and allows retry with values', () => {
  const dir = tempDir('vela-s1c-empty-env-')
  dirs.push(dir)
  const agentDir = join(dir.path, 'agent')
  const channelsDir = join(agentDir, 'channels')
  mkdirSync(channelsDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      lark: {
        timezone: ['$', '{MISSING_CH_TZ}'].join(''),
        chats: [
          {
            id: 'oc_env_retry',
            readUntagged: true,
            environment: '$MISSING_CH_ENV',
          },
        ],
      },
    }),
  )
  writeFileSync(
    join(channelsDir, 'routines.json'),
    JSON.stringify({
      routines: [
        {
          id: 'r-tz-empty',
          channel: 'lark',
          chatId: 'oc_env_retry',
          message: 'ping',
          schedule: { time: '09:00' },
        },
      ],
    }),
  )

  const db = openDatabase({ path: join(dir.path, 'vela.db') })
  try {
    const pass1 = migrateLegacyVelaDir({ agentDir, db, env: {} })
    expect(pass1.skipped).toBe(false)
    expect(
      db.get<{ id: string }>("SELECT id FROM timers WHERE id = 'r-tz-empty'"),
    ).toBeUndefined()
    const binding1 = db.get<{ config_json: string | null }>(
      "SELECT config_json FROM channel_bindings WHERE external_id = 'oc_env_retry'",
    )
    expect(JSON.parse(binding1!.config_json!)).toEqual({ readUntagged: true })

    const pass2 = migrateLegacyVelaDir({
      agentDir,
      db,
      env: { MISSING_CH_TZ: 'UTC', MISSING_CH_ENV: 'docker' },
    })
    expect(pass2.skipped).toBe(false)
    expect(
      db.get<{ timezone: string }>(
        "SELECT timezone FROM timers WHERE id = 'r-tz-empty'",
      ),
    ).toEqual({ timezone: 'UTC' })
    const binding2 = db.get<{ config_json: string | null }>(
      "SELECT config_json FROM channel_bindings WHERE external_id = 'oc_env_retry'",
    )
    expect(JSON.parse(binding2!.config_json!)).toEqual({
      readUntagged: true,
      environment: 'docker',
    })
  } finally {
    db.close()
  }
})

test('legacy-note reconciliation avoids cross-directory stealing and reconciles matching dual keys', () => {
  const dir = tempDir('vela-s1c-notes-')
  dirs.push(dir)
  const agentDirA = join(dir.path, 'agent-a')
  const channelsA = join(agentDirA, 'channels')
  mkdirSync(channelsA, { recursive: true })
  writeFileSync(
    join(channelsA, 'index.json'),
    JSON.stringify({
      records: [],
      notes: {
        'lark-oc_shared': ['note-from-a'],
        'lark-oc_reconcile': ['shared-note'],
      },
    }),
  )

  const db = openDatabase({ path: join(dir.path, 'vela.db') })
  try {
    const dirAHash = createHash('sha256')
      .update(agentDirA)
      .digest('hex')
      .slice(0, 8)
    // Pre-seed unrelated un-scoped note for lark-oc_shared, and a processed un-scoped + pending scoped duplicate for lark-oc_reconcile
    db.run(
      "INSERT INTO inbox_events (id, source, dedupe_key, status, payload_json, created_at) VALUES ('other-dir-note', 'handoff', 'legacy-note:lark-oc_shared:0', 'pending', ?, '2026-11-24T00:00:00Z')",
      JSON.stringify({
        type: 'handoff_note',
        groupKey: 'lark-oc_shared',
        text: 'different-dir-note',
      }),
    )
    db.run(
      "INSERT INTO inbox_events (id, source, dedupe_key, status, processed_at, payload_json, created_at) VALUES ('old-reconcile', 'handoff', 'legacy-note:lark-oc_reconcile:0', 'done', '2026-11-24T01:00:00Z', ?, '2026-11-24T00:00:00Z')",
      JSON.stringify({
        type: 'handoff_note',
        groupKey: 'lark-oc_reconcile',
        text: 'shared-note',
      }),
    )
    db.run(
      "INSERT INTO inbox_events (id, source, dedupe_key, status, payload_json, created_at) VALUES ('scoped-reconcile', 'handoff', ?, 'pending', ?, '2026-11-24T00:00:00Z')",
      `legacy-note:${dirAHash}:lark-oc_reconcile:0`,
      JSON.stringify({
        type: 'handoff_note',
        groupKey: 'lark-oc_reconcile',
        text: 'shared-note',
      }),
    )

    migrateLegacyVelaDir({ agentDir: agentDirA, db })

    // Unrelated dir note was NOT overwritten/stolen; agentA wrote its own scoped note
    expect(
      db.get<{ payload_json: string }>(
        "SELECT payload_json FROM inbox_events WHERE dedupe_key = 'legacy-note:lark-oc_shared:0'",
      )?.payload_json,
    ).toContain('different-dir-note')
    expect(
      db.get<{ payload_json: string }>(
        'SELECT payload_json FROM inbox_events WHERE dedupe_key = ?',
        `legacy-note:${dirAHash}:lark-oc_shared:0`,
      )?.payload_json,
    ).toContain('note-from-a')

    // Dual matching keys reconciled into scoped row and removed old un-scoped duplicate
    expect(
      db.get<{ status: string; processed_at: string | null }>(
        "SELECT status, processed_at FROM inbox_events WHERE id = 'scoped-reconcile'",
      ),
    ).toEqual({ status: 'done', processed_at: '2026-11-24T01:00:00Z' })
    expect(
      db.get<{ id: string }>(
        "SELECT id FROM inbox_events WHERE id = 'old-reconcile'",
      ),
    ).toBeUndefined()
  } finally {
    db.close()
  }
})
