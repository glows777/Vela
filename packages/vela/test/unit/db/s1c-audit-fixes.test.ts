import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../../../../../test/support/vela.ts'
import { migrateLegacyVelaDir, openDatabase } from '../../../src/db/index.ts'
import { convertV1ToEntries } from '../../../src/db/migrate-legacy-v1.ts'

const dirs: { cleanup(): void }[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

test('V1 legacy transcript synthetic IDs are deterministic independent of wall clock', () => {
  const lines = [
    {
      type: 'session',
      version: 1,
      id: 'v1-det',
      timestamp: '2026-11-24T00:00:00.000Z',
      cwd: '/tmp/proj',
    },
    {
      role: 'user',
      content: 'hello',
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
    },
  ]
  const origToIso = Date.prototype.toISOString
  let tick = 0
  Date.prototype.toISOString = () =>
    `2026-11-24T00:00:0${(tick++ % 9) + 1}.000Z`
  try {
    const r1 = convertV1ToEntries('v1-det', lines, '/tmp/v1.jsonl', [])
    const r2 = convertV1ToEntries('v1-det', lines, '/tmp/v1.jsonl', [])
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
        chats: [{ id: envRef('MISSING_CHAT'), workDir: '/tmp/w' }],
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

    // Pass 1 without env -> unresolved ${MISSING_TZ} and ${MISSING_CHAT} keep migration incomplete
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
    expect(
      db.get<{ enabled: number }>(
        "SELECT enabled FROM timers WHERE id = 'no-target'",
      ),
    ).toEqual({ enabled: 0 })

    // Both A and B handoff notes imported (distinct per-dataDir dedupeKey)
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

    // Custom message normalized 'reasoning' -> 'thinking'
    const cm = db.get<{ content_json: string }>(
      "SELECT content_json FROM vela_messages WHERE session_id = 'cm-sess' AND id = 'e1'",
    )
    expect(JSON.parse(cm!.content_json)).toEqual({
      customType: 'ext-note',
      display: true,
      content: [{ type: 'thinking', text: 'legacy-thought' }],
    })

    // Unresolved ${MISSING_TZ} was NOT written as literal '$MISSING_TZ'
    const noTargetTimer = db.get<{ timezone: string }>(
      "SELECT timezone FROM timers WHERE id = 'no-target'",
    )
    expect(noTargetTimer?.timezone).not.toContain(envRef('MISSING_TZ'))

    // Retry with env completes the previously incomplete config/timezone resolution
    const pass2 = migrateLegacyVelaDir({
      agentDir,
      db,
      env: { MISSING_TZ: 'UTC', MISSING_CHAT: 'oc_resolved' },
    })
    expect(pass2.skipped).toBe(false)
    expect(
      db.get<{ project_id: string | null }>(
        "SELECT project_id FROM channel_bindings WHERE external_id = 'oc_resolved'",
      ),
    ).toEqual({ project_id: 'lark-group:oc_resolved' })
  } finally {
    db.close()
  }
})
