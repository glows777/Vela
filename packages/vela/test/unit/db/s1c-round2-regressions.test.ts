import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../../../../../test/support/vela.ts'
import {
  migrateLegacyConfigFiles,
  parseConfig,
  removeConfigIfHashMatches,
  updateConfigFile,
} from '../../../src/config/index.ts'
import { migrateLegacyVelaDir, openDatabase } from '../../../src/db/index.ts'

const dirs: { cleanup(): void }[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

test('P1 #2: colliding session IDs allocate canonical IDs by (dataDir, id) before channel bindings in both orders', () => {
  for (const channelOnSecond of [true, false]) {
    const root = tempDir('vela-s1c-r2-collision-')
    dirs.push(root)
    const agentDir = join(root.path, 'agent')
    const dirA = join(agentDir, 'projects', 'aaa')
    const dirB = join(agentDir, 'projects', 'zzz')
    mkdirSync(join(dirA, 'sessions'), { recursive: true })
    mkdirSync(join(dirB, 'sessions'), { recursive: true })
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ lark: { chats: ['oc_b'] } }),
    )

    writeFileSync(
      join(dirA, 'sessions', 'named.jsonl'),
      `${[
        JSON.stringify({
          type: 'session',
          version: 2,
          id: 'named',
          timestamp: '2026-11-24T00:00:00Z',
        }),
        JSON.stringify({
          type: 'message',
          id: 'msg-a',
          parentId: null,
          timestamp: '2026-11-24T00:00:01Z',
          message: { role: 'user', content: 'private A content' },
        }),
      ].join('\n')}\n`,
    )
    writeFileSync(
      join(dirB, 'sessions', 'named.jsonl'),
      `${[
        JSON.stringify({
          type: 'session',
          version: 2,
          id: 'named',
          timestamp: '2026-11-24T00:00:00Z',
        }),
        JSON.stringify({
          type: 'message',
          id: 'msg-b',
          parentId: null,
          timestamp: '2026-11-24T00:00:01Z',
          message: { role: 'user', content: 'channel B content' },
        }),
      ].join('\n')}\n`,
    )

    const boundDir = channelOnSecond ? dirB : dirA
    mkdirSync(join(boundDir, 'channels'), { recursive: true })
    writeFileSync(
      join(boundDir, 'channels', 'index.json'),
      JSON.stringify({
        version: 1,
        records: [
          {
            key: 'lark-oc_b',
            channel: 'lark',
            chatId: 'oc_b',
            chatKind: 'group',
            requester: { id: 'ou_1', name: 'Alice' },
            task: 'Bound Hub',
            activeSessionId: 'named',
            previousSessionIds: [],
            state: 'done',
            pendingMessageIds: [],
            createdAt: '2026-11-24T00:00:00Z',
            updatedAt: '2026-11-24T00:00:02Z',
          },
        ],
      }),
    )

    const db = openDatabase({ path: join(agentDir, 'vela.db') })
    try {
      migrateLegacyVelaDir({ agentDir, db })
      const binding = db.get<{ session_id: string }>(
        "SELECT session_id FROM channel_bindings WHERE external_id = 'oc_b'",
      )
      expect(binding?.session_id).toBeTruthy()
      const projectHub = db.get<{ hub_session_id: string }>(
        "SELECT hub_session_id FROM projects WHERE id = 'lark-group:oc_b'",
      )
      expect(projectHub?.hub_session_id).toBe(binding?.session_id)

      const boundMsgs = db.all<{ id: string; content_json: string }>(
        'SELECT id, content_json FROM vela_messages WHERE session_id = ?',
        binding!.session_id,
      )
      expect(boundMsgs.map((m) => m.id)).toEqual([
        channelOnSecond ? 'msg-b' : 'msg-a',
      ])
    } finally {
      db.close()
    }
  }
})

test('P1 #3 & #4: Lark DM owner/listed-chat unification and hash-checked config.json rollback safety', () => {
  const root = tempDir('vela-s1c-r2-dm-lock-')
  dirs.push(root)
  const agentDir = join(root.path, 'agent')
  const channelsDir = join(agentDir, 'channels')
  mkdirSync(channelsDir, { recursive: true })

  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      extensionConfig: {
        lark: {
          owners: ['ou_kept'],
          chats: ['oc_listed_dm'],
        },
      },
    }),
  )
  writeFileSync(
    join(channelsDir, 'index.json'),
    JSON.stringify({
      version: 1,
      records: [
        {
          key: 'lark-ou_removed',
          channel: 'lark',
          chatId: 'ou_removed',
          chatKind: 'direct',
          requester: { id: 'ou_removed', name: 'Removed' },
          task: 'Revoked DM',
          activeSessionId: 'dm-removed-sess',
          previousSessionIds: [],
          state: 'done',
          pendingMessageIds: [],
        },
        {
          key: 'lark-ou_kept',
          channel: 'lark',
          chatId: 'ou_kept',
          chatKind: 'direct',
          requester: { id: 'ou_kept', name: 'Owner' },
          task: 'Active DM',
          activeSessionId: 'dm-kept-sess',
          previousSessionIds: [],
          state: 'done',
          pendingMessageIds: [],
        },
        {
          key: 'lark-oc_listed_dm',
          channel: 'lark',
          chatId: 'oc_listed_dm',
          chatKind: 'direct',
          requester: { id: 'ou_other', name: 'Other' },
          task: 'Listed DM',
          activeSessionId: 'dm-listed-sess',
          previousSessionIds: [],
          state: 'done',
          pendingMessageIds: [],
        },
      ],
    }),
  )

  const db = openDatabase({ path: join(agentDir, 'vela.db') })
  try {
    migrateLegacyVelaDir({ agentDir, db })
    expect(
      db.get<{ kind: string; enabled: number; session_id: string | null }>(
        "SELECT kind, enabled, session_id FROM channel_bindings WHERE external_id = 'ou_removed'",
      ),
    ).toEqual({ kind: 'direct', enabled: 0, session_id: 'dm-removed-sess' })
    expect(
      db.get<{ kind: string; enabled: number; session_id: string | null }>(
        "SELECT kind, enabled, session_id FROM channel_bindings WHERE external_id = 'ou_kept'",
      ),
    ).toEqual({ kind: 'direct', enabled: 1, session_id: 'dm-kept-sess' })
    expect(
      db.get<{
        kind: string
        enabled: number
        project_id: string | null
        session_id: string | null
      }>(
        "SELECT kind, enabled, project_id, session_id FROM channel_bindings WHERE external_id = 'oc_listed_dm'",
      ),
    ).toEqual({
      kind: 'direct',
      enabled: 1,
      project_id: null,
      session_id: 'dm-listed-sess',
    })
  } finally {
    db.close()
  }

  // P1 #4: removeConfigIfHashMatches preserves concurrent writes when config.json changed after creation
  const lockRoot = tempDir('vela-s1c-r2-cfg-hash-')
  dirs.push(lockRoot)
  const cfgAgent = join(lockRoot.path, 'agent')
  mkdirSync(cfgAgent, { recursive: true })
  writeFileSync(join(cfgAgent, 'settings.json'), '{"defaultModel":"openai/a"}')
  const created = migrateLegacyConfigFiles(cfgAgent)
  expect(created.createdConfig).toBe(true)
  expect(created.createdSha256).toBeTruthy()
  updateConfigFile(cfgAgent, (cur) => ({ ...cur, model: 'openai/updated' }))
  expect(removeConfigIfHashMatches(cfgAgent, created.createdSha256!)).toBe(
    false,
  )
  expect(existsSync(join(cfgAgent, 'config.json'))).toBe(true)
  expect(
    parseConfig(
      readFileSync(join(cfgAgent, 'config.json'), 'utf8'),
      join(cfgAgent, 'config.json'),
    ).model,
  ).toBe('openai/updated')
})

test('P2 #1,#10,#11,#14: incomplete discovery retries with cwd/env, relative trust ignored, symlink blobs blocked, reserved extensionConfig.mcp dropped safely', () => {
  const root = tempDir('vela-s1c-r2-incomplete-')
  dirs.push(root)
  const agentDir = join(root.path, 'agent')
  const cwd = join(root.path, 'workspace')
  const relDataDir = join(cwd, 'rel-data')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(join(relDataDir, 'sessions'), { recursive: true })
  mkdirSync(join(agentDir, 'local', 'p1', 's1'), { recursive: true })

  // Secret outside local root for symlink escape tests
  const outsideFile = join(root.path, 'outside-secret.txt')
  writeFileSync(outsideFile, 'do-not-leak')
  const outsideDir = join(root.path, 'outside-dir')
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(join(outsideDir, 'leak2'), 'do-not-leak-dir')

  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      dataDir: './rel-data',
      extensionConfig: {
        lark: { chats: ['$EXTRA_CHAT'] },
        mcp: {
          mcpServers: { ok: { command: 'echo', args: ['1'] } },
          sources: ['legacy-only'],
        },
      },
    }),
  )
  writeFileSync(
    join(agentDir, 'trust.json'),
    JSON.stringify({ '.': true, [cwd]: true }),
  )
  writeFileSync(
    join(agentDir, 'local', 'projects.json'),
    JSON.stringify({
      version: 1,
      projects: [{ id: 'p1', cwd, name: 'P1', sessionId: 's1' }],
    }),
  )
  writeFileSync(
    join(agentDir, 'local', 'p1.json'),
    JSON.stringify([
      {
        id: 'att-file-sym',
        sessionId: 's1',
        role: 'user',
        text: 'sym file',
        createdAt: '2026-11-24T00:00:00Z',
        file: { name: 'secret.txt', size: 11 },
      },
      {
        id: 'leak2',
        sessionId: 's-dir-sym',
        role: 'user',
        text: 'sym dir',
        createdAt: '2026-11-24T00:00:01Z',
        file: { name: 'leak2.txt', size: 15 },
      },
      {
        id: 'att-real',
        sessionId: 's1',
        role: 'user',
        text: 'legit file',
        createdAt: '2026-11-24T00:00:02Z',
        file: { name: 'ok.txt', size: 4 },
      },
    ]),
  )
  symlinkSync(outsideFile, join(agentDir, 'local', 'p1', 's1', 'att-file-sym'))
  symlinkSync(outsideDir, join(agentDir, 'local', 'p1', 's-dir-sym'))
  writeFileSync(join(agentDir, 'local', 'p1', 's1', 'att-real'), 'good')

  writeFileSync(
    join(relDataDir, 'sessions', 'rel-sess.jsonl'),
    `${[
      JSON.stringify({
        type: 'session',
        version: 2,
        id: 'rel-sess',
        timestamp: '2026-11-24T00:00:00Z',
      }),
      JSON.stringify({
        type: 'message',
        id: 'rm1',
        parentId: null,
        timestamp: '2026-11-24T00:00:01Z',
        message: { role: 'user', content: 'from rel' },
      }),
    ].join('\n')}\n`,
  )

  const db = openDatabase({ path: join(agentDir, 'vela.db') })
  try {
    // Pass 1 without cwd or env: skips relative dataDir & $EXTRA_CHAT, leaves completion marker unset
    const r1 = migrateLegacyVelaDir({ agentDir, db })
    expect(r1.skipped).toBe(false)
    expect(r1.warnings.some((w) => w.includes('settings.json'))).toBe(true)
    expect(
      r1.warnings.some((w) => w.includes('extensionConfig.mcp.sources')),
    ).toBe(true)
    expect(
      r1.warnings.some((w) => w.includes('non-absolute trust.json key "."')),
    ).toBe(true)
    expect(
      db
        .all<{ filename: string }>('SELECT filename FROM blobs')
        .map((b) => b.filename),
    ).toEqual(['ok.txt'])
    expect(
      db.get<{ path: string }>(
        'SELECT path FROM trusted_paths WHERE path = ?',
        process.cwd(),
      ),
    ).toBeUndefined()
    expect(
      db.get<{ id: string }>("SELECT id FROM sessions WHERE id = 'rel-sess'"),
    ).toBeUndefined()

    // Pass 2 with cwd + env finishes importing missing sources without duplicating blobs
    const r2 = migrateLegacyVelaDir({
      agentDir,
      db,
      cwd,
      env: { EXTRA_CHAT: 'oc_env_chat' },
    })
    expect(r2.skipped).toBe(false)
    expect(
      db.get<{ id: string }>("SELECT id FROM sessions WHERE id = 'rel-sess'")
        ?.id,
    ).toBe('rel-sess')
    expect(
      db.get<{ enabled: number }>(
        "SELECT enabled FROM channel_bindings WHERE external_id = 'oc_env_chat'",
      )?.enabled,
    ).toBe(1)
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM blobs')?.n).toBe(1)

    // Pass 3 is now an idempotent no-op
    const r3 = migrateLegacyVelaDir({ agentDir, db, cwd })
    expect(r3.skipped).toBe(true)
  } finally {
    db.close()
  }
})

test('P2 #2,#3,#4,#5,#6,#7,#12,#13: transcript guards, branch-local context_edit, routine catch-up & env interpolation', () => {
  const root = tempDir('vela-s1c-r2-details-')
  dirs.push(root)
  const agentDir = join(root.path, 'agent')
  mkdirSync(join(agentDir, 'sessions'), { recursive: true })
  mkdirSync(join(agentDir, 'channels'), { recursive: true })

  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      lark: {
        timezone: '$CUSTOM_TZ',
        chats: [
          {
            id: 'oc_env',
            model: '$MODEL_VAR',
            topicModel: '$TOPIC_VAR',
          },
        ],
      },
    }),
  )

  writeFileSync(
    join(agentDir, 'channels', 'index.json'),
    JSON.stringify({
      version: 1,
      records: [
        {
          key: 'lark-oc_env',
          channel: 'lark',
          chatId: 'oc_env',
          chatKind: 'group',
          task: 'Env Hub',
          activeSessionId: 'hub-sess',
          previousSessionIds: [],
          state: 'done',
          pendingMessageIds: [
            'om_consumed',
            'om_unconsumed',
            { id: 'om_passive', passive: true },
          ],
          createdAt: '2026-11-20T00:00:00Z',
          updatedAt: '2026-11-20T00:01:00Z',
        },
      ],
    }),
  )

  writeFileSync(
    join(agentDir, 'channels', 'routines.json'),
    JSON.stringify({
      version: 1,
      routines: [
        {
          id: 'rt-overdue-unfired',
          channel: 'lark',
          chatId: 'oc_env',
          targetKey: 'lark-oc_env',
          message: 'Overdue one-off catches up',
          schedule: { at: '2020-02-01T00:00:00Z' },
          createdAt: '2020-01-01T00:00:00Z',
          lastFiredAt: null,
        },
        {
          id: 'rt-missed-recurring',
          channel: 'lark',
          chatId: 'oc_env',
          targetKey: 'lark-oc_env',
          message: 'Missed recurring',
          schedule: { time: '09:00' },
          createdAt: '2020-01-01T00:00:00Z',
          lastFiredAt: '2026-11-20T09:00:00Z',
        },
        {
          id: 'rt-missing-topic',
          channel: 'lark',
          chatId: 'oc_env',
          targetKey: 'lark-oc_env-om_gone',
          message: 'Must not fall back to hub',
          schedule: { time: '10:00' },
          createdAt: '2026-11-20T00:00:00Z',
        },
      ],
    }),
  )

  writeFileSync(
    join(agentDir, 'channels', 'subscriptions.json'),
    JSON.stringify({
      version: 1,
      subscriptions: [
        {
          id: 'sub-missing-topic',
          source: 'github',
          key: 'github:x/y#pr/1',
          channel: 'lark',
          chatId: 'oc_env',
          targetKey: 'lark-oc_env-om_gone',
        },
      ],
    }),
  )

  // Hub transcript with consumed channel.input marker + trailing genuine location marker
  writeFileSync(
    join(agentDir, 'sessions', 'hub-sess.jsonl'),
    `${[
      JSON.stringify({
        type: 'session',
        version: 2,
        id: 'hub-sess',
        timestamp: '2026-11-20T00:00:00Z',
      }),
      JSON.stringify({
        type: 'message',
        id: 'a',
        parentId: null,
        timestamp: '2026-11-20T00:00:01Z',
        message: { role: 'user', content: 'first' },
      }),
      JSON.stringify({
        type: 'custom',
        id: 'ordinary-custom',
        parentId: 'a',
        customType: 'vela.session.location',
        timestamp: '2026-11-20T00:00:01.500Z',
        data: { environment: 'local', cwd: '/not-a-real-marker' },
      }),
      JSON.stringify({
        type: 'message',
        id: 'b',
        parentId: 'ordinary-custom',
        timestamp: '2026-11-20T00:00:02Z',
        message: { role: 'assistant', content: 'second' },
      }),
      JSON.stringify({
        type: 'custom',
        id: 'inp1',
        parentId: 'b',
        customType: 'channel.input',
        timestamp: '2026-11-20T00:00:02.500Z',
        data: { messageId: 'om_consumed' },
      }),
      JSON.stringify({
        type: 'custom',
        id: 'location:trailing',
        parentId: 'a',
        customType: 'vela.session.location',
        timestamp: '2026-11-20T00:00:03Z',
        data: { environment: 'docker', cwd: '/repo-moved' },
      }),
    ].join('\n')}\n`,
  )

  // Branch-local context_edit transcript
  writeFileSync(
    join(agentDir, 'sessions', 's-branch-edit.jsonl'),
    `${[
      JSON.stringify({
        type: 'session',
        version: 2,
        id: 's-branch-edit',
        timestamp: '2026-11-20T00:00:00Z',
      }),
      JSON.stringify({
        type: 'message',
        id: 'orig1',
        parentId: null,
        timestamp: '2026-11-20T00:00:01Z',
        message: { role: 'user', content: 'original content' },
      }),
      JSON.stringify({
        type: 'message',
        id: 'sib1',
        parentId: 'orig1',
        timestamp: '2026-11-20T00:00:02Z',
        message: { role: 'assistant', content: 'sibling leaf' },
      }),
      JSON.stringify({
        type: 'context_edit',
        id: 'edit_active',
        parentId: 'orig1',
        timestamp: '2026-11-20T00:00:03Z',
        targetId: 'orig1',
        replacement: { content: 'active edited' },
      }),
    ].join('\n')}\n`,
  )

  // V1 checkpoint with malformed member
  writeFileSync(
    join(agentDir, 'sessions', 'v1-corrupt-member.jsonl'),
    `${JSON.stringify({
      type: 'checkpoint',
      timestamp: '2026-11-19T00:00:00Z',
      messages: [
        { message: null },
        {
          timestamp: '2026-11-19T00:00:01Z',
          message: { role: 'user', content: 'good' },
        },
      ],
    })}\n`,
  )

  // 2,000-message linear transcript (O(N) cycle check)
  const linearLines: string[] = [
    JSON.stringify({
      type: 'session',
      version: 2,
      id: 's-linear-2k',
      timestamp: '2026-11-20T00:00:00Z',
    }),
  ]
  for (let i = 1; i <= 2000; i++) {
    linearLines.push(
      JSON.stringify({
        type: 'message',
        id: `m${i}`,
        parentId: i === 1 ? null : `m${i - 1}`,
        timestamp: '2026-11-20T00:00:01Z',
        message: { role: i % 2 === 1 ? 'user' : 'assistant', content: `m${i}` },
      }),
    )
  }
  writeFileSync(
    join(agentDir, 'sessions', 's-linear-2k.jsonl'),
    `${linearLines.join('\n')}\n`,
  )

  const db = openDatabase({ path: join(agentDir, 'vela.db') })
  try {
    const res = migrateLegacyVelaDir({
      agentDir,
      db,
      env: {
        CUSTOM_TZ: 'Europe/Berlin',
        MODEL_VAR: 'openai/gpt-5.5',
        TOPIC_VAR: 'deepseek/deepseek-flash',
      },
    })

    // Ordinary custom vela.session.location preserved, genuine location:trailing kept 'b' (or inp1->b) leaf!
    const hub = db.get<{ location_json: string; leaf_message_id: string }>(
      "SELECT location_json, leaf_message_id FROM sessions WHERE id = 'hub-sess'",
    )
    expect(JSON.parse(hub!.location_json)).toEqual({
      environment: 'docker',
      cwd: '/repo-moved',
    })
    expect(hub?.leaf_message_id).toBe('inp1')
    expect(
      db.get<{ id: string }>(
        "SELECT id FROM vela_messages WHERE session_id = 'hub-sess' AND id = 'ordinary-custom'",
      )?.id,
    ).toBe('ordinary-custom')

    // Pending messages: consumed + passive dropped/non-waking, unconsumed active waking
    expect(
      db.get<{ wake: number; status: string }>(
        "SELECT wake, status FROM inbox_events WHERE dedupe_key = 'lark:oc_env:om_consumed'",
      ),
    ).toEqual({ wake: 0, status: 'dropped' })
    expect(
      db.get<{ wake: number; passive: number; status: string }>(
        "SELECT wake, passive, status FROM inbox_events WHERE dedupe_key = 'lark:oc_env:om_passive'",
      ),
    ).toEqual({ wake: 0, passive: 1, status: 'dropped' })
    expect(
      db.get<{ wake: number; status: string }>(
        "SELECT wake, status FROM inbox_events WHERE dedupe_key = 'lark:oc_env:om_unconsumed'",
      ),
    ).toEqual({ wake: 1, status: 'pending' })

    // Routines catch-up + unresolved explicit target + interpolated project model/timezone
    const proj = db.get<{ default_model: string; config_json: string }>(
      "SELECT default_model, config_json FROM projects WHERE id = 'lark-group:oc_env'",
    )
    expect(proj?.default_model).toBe('openai/gpt-5.5')
    expect(JSON.parse(proj!.config_json).topicModel).toBe(
      'deepseek/deepseek-flash',
    )
    const rawCfg = readFileSync(join(agentDir, 'config.json'), 'utf8')
    expect(rawCfg).toContain('$MODEL_VAR')
    expect(rawCfg).toContain('$CUSTOM_TZ')

    const rtOverdue = db.get<{
      enabled: number
      next_fire_at: string | null
      timezone: string | null
    }>(
      "SELECT enabled, next_fire_at, timezone FROM timers WHERE id = 'rt-overdue-unfired'",
    )
    expect(rtOverdue).toEqual({
      enabled: 1,
      next_fire_at: '2020-02-01T00:00:00.000Z',
      timezone: 'Europe/Berlin',
    })
    const rtRecurring = db.get<{
      enabled: number
      next_fire_at: string | null
    }>(
      "SELECT enabled, next_fire_at FROM timers WHERE id = 'rt-missed-recurring'",
    )
    expect(rtRecurring?.enabled).toBe(1)
    expect(rtRecurring?.next_fire_at).toBeTruthy()
    expect(Date.parse(rtRecurring!.next_fire_at!)).toBeLessThanOrEqual(
      Date.now(),
    )

    const rtMissing = db.get<{ enabled: number; session_id: string | null }>(
      "SELECT enabled, session_id FROM timers WHERE id = 'rt-missing-topic'",
    )
    expect(rtMissing).toEqual({ enabled: 0, session_id: null })
    expect(
      db.get<{ id: string }>(
        "SELECT id FROM subscriptions WHERE id = 'sub-missing-topic'",
      ),
    ).toBeUndefined()
    expect(res.warnings.some((w) => w.includes('sub-missing-topic'))).toBe(true)

    // Sibling branch reconstructs original content while active branch keeps edit row
    const sibOrig = db.get<{ content_json: string }>(
      "SELECT content_json FROM vela_messages WHERE session_id = 's-branch-edit' AND id = 'orig1'",
    )
    expect(JSON.parse(sibOrig!.content_json)).toEqual({
      role: 'user',
      content: 'original content',
    })

    // V1 corrupt member skipped without throwing; 2k linear transcript imported
    expect(
      res.warnings.some((w) =>
        w.includes('Skipped malformed checkpoint message'),
      ),
    ).toBe(true)
    expect(
      db.get<{ n: number }>(
        "SELECT count(*) AS n FROM vela_messages WHERE session_id = 'v1-corrupt-member'",
      )?.n,
    ).toBe(1)
    expect(
      db.get<{ n: number }>(
        "SELECT count(*) AS n FROM vela_messages WHERE session_id = 's-linear-2k'",
      )?.n,
    ).toBe(2000)
  } finally {
    db.close()
  }
})

test('GitHub Codex fixes: retry allocation stability, deterministic V1 IDs, and binding reconciliation', () => {
  // 1. P1: preserve canonical session IDs across incomplete retries when an earlier dataDir joins later
  // 2. P2: deterministic synthetic IDs across incomplete retries on V1 checkpoints
  // 3. P2: reconcile channel_bindings on topic-before-hub order and env retry
  const root = tempDir('vela-s1c-gh-codex-')
  dirs.push(root)
  const agentDir = join(root.path, 'agent')
  const zzzDir = join(agentDir, 'projects', 'zzz')
  const cwd = join(root.path, 'aaa-workspace')
  const relDir = join(cwd, 'aaa-rel')
  mkdirSync(join(zzzDir, 'sessions'), { recursive: true })
  mkdirSync(join(relDir, 'sessions'), { recursive: true })
  mkdirSync(join(agentDir, 'channels'), { recursive: true })

  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      dataDir: './aaa-rel',
      extensionConfig: {
        lark: {
          chats: ['$LARK_ENV_CHAT'],
        },
      },
    }),
  )

  // Both zzzDir and relDir contain session id "named", plus zzzDir has a V1 checkpoint
  writeFileSync(
    join(zzzDir, 'sessions', 'named.jsonl'),
    `${[
      JSON.stringify({
        type: 'session',
        version: 2,
        id: 'named',
        timestamp: '2026-11-24T00:00:00Z',
      }),
      JSON.stringify({
        type: 'message',
        id: 'msg-1',
        parentId: null,
        timestamp: '2026-11-24T00:00:01Z',
        message: { role: 'user', content: 'from zzz' },
      }),
    ].join('\n')}\n`,
  )
  writeFileSync(
    join(zzzDir, 'sessions', 'v1-retry.jsonl'),
    `${JSON.stringify({
      type: 'checkpoint',
      timestamp: '2026-11-24T00:00:00Z',
      messages: [
        {
          timestamp: '2026-11-24T00:00:01Z',
          message: { role: 'user', content: 'v1 hello' },
        },
      ],
    })}\n`,
  )
  writeFileSync(
    join(relDir, 'sessions', 'named.jsonl'),
    `${[
      JSON.stringify({
        type: 'session',
        version: 2,
        id: 'named',
        timestamp: '2026-11-24T00:00:00Z',
      }),
      JSON.stringify({
        type: 'message',
        id: 'msg-1',
        parentId: null,
        timestamp: '2026-11-24T00:00:01Z',
        message: { role: 'user', content: 'from aaa rel' },
      }),
    ].join('\n')}\n`,
  )

  // Topic record appears BEFORE Hub record, and chat oc_delayed relies on $LARK_ENV_CHAT
  writeFileSync(
    join(agentDir, 'channels', 'index.json'),
    JSON.stringify({
      version: 1,
      records: [
        {
          key: 'lark-oc_delayed-om_r1',
          channel: 'lark',
          chatId: 'oc_delayed',
          chatKind: 'group',
          rootId: 'om_r1',
          threadId: 'omt_r1',
          task: 'Topic First',
          activeSessionId: 'topic-first-sess',
          previousSessionIds: [],
          state: 'done',
          pendingMessageIds: [],
        },
        {
          key: 'lark-oc_delayed',
          channel: 'lark',
          chatId: 'oc_delayed',
          chatKind: 'group',
          task: 'Hub Second',
          activeSessionId: 'hub-second-sess',
          previousSessionIds: [],
          state: 'done',
          pendingMessageIds: [],
        },
      ],
    }),
  )

  const db = openDatabase({ path: join(agentDir, 'vela.db') })
  try {
    // Pass 1 without cwd or env -> incomplete; zzz claims 'named', v1-retry imported, oc_delayed group disabled
    const p1 = migrateLegacyVelaDir({ agentDir, db })
    expect(p1.skipped).toBe(false)
    const v1Leaf1 = db.get<{ leaf_message_id: string | null }>(
      "SELECT leaf_message_id FROM sessions WHERE id = 'v1-retry'",
    )?.leaf_message_id
    expect(v1Leaf1).toBeTruthy()
    expect(
      db.get<{ enabled: number; session_id: string | null }>(
        "SELECT enabled, session_id FROM channel_bindings WHERE external_id = 'oc_delayed'",
      ),
    ).toEqual({ enabled: 0, session_id: 'hub-second-sess' })

    // Pass 2 with cwd + env -> discovers lexicographically earlier relDir('named') & enables oc_delayed
    const p2 = migrateLegacyVelaDir({
      agentDir,
      db,
      cwd,
      env: { LARK_ENV_CHAT: 'oc_delayed' },
    })
    expect(p2.skipped).toBe(false)

    // zzz keeps canonical 'named' with 'from zzz'; relDir gets disambiguated ID with 'from aaa rel'
    const origNamedMsg = db.get<{ content_json: string }>(
      "SELECT content_json FROM vela_messages WHERE session_id = 'named' AND id = 'msg-1'",
    )
    expect(JSON.parse(origNamedMsg!.content_json)).toEqual({
      role: 'user',
      content: 'from zzz',
    })
    const disambiguated = db.get<{ id: string }>(
      "SELECT id FROM sessions WHERE id LIKE 'named--%'",
    )
    expect(disambiguated?.id).toBeTruthy()
    const newRelMsg = db.get<{ content_json: string }>(
      "SELECT content_json FROM vela_messages WHERE session_id = ? AND id = 'msg-1'",
      disambiguated!.id,
    )
    expect(JSON.parse(newRelMsg!.content_json)).toEqual({
      role: 'user',
      content: 'from aaa rel',
    })

    // V1 checkpoint retry keeps deterministic leaf_message_id matching an existing row
    const v1Leaf2 = db.get<{ leaf_message_id: string | null }>(
      "SELECT leaf_message_id FROM sessions WHERE id = 'v1-retry'",
    )?.leaf_message_id
    expect(v1Leaf2).toBe(v1Leaf1)
    expect(
      db.get<{ id: string }>(
        "SELECT id FROM vela_messages WHERE session_id = 'v1-retry' AND id = ?",
        v1Leaf2!,
      )?.id,
    ).toBe(v1Leaf2!)

    // Group binding reconciled both hub session_id (from topic-before-hub) AND enabled = 1 (from env retry)
    expect(
      db.get<{ enabled: number; session_id: string | null }>(
        "SELECT enabled, session_id FROM channel_bindings WHERE external_id = 'oc_delayed'",
      ),
    ).toEqual({ enabled: 1, session_id: 'hub-second-sess' })

    // Pass 3 is idempotent no-op
    expect(migrateLegacyVelaDir({ agentDir, db, cwd }).skipped).toBe(true)
  } finally {
    db.close()
  }
})
