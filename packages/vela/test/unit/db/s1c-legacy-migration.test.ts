import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../../../../../test/support/vela.ts'
import { parseConfig } from '../../../src/config/index.ts'
import { migrateLegacyVelaDir, openDatabase } from '../../../src/db/index.ts'
import { loadConfig } from '../../../src/load-config.ts'

const dirs: { cleanup(): void }[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

function snapshotFiles(
  paths: string[],
): Map<string, { text: string; mtimeMs: number }> {
  const snap = new Map<string, { text: string; mtimeMs: number }>()
  for (const file of paths) {
    snap.set(file, {
      text: readFileSync(file, 'utf8'),
      mtimeMs: statSync(file).mtimeMs,
    })
  }
  return snap
}

test('migrateLegacyVelaDir performs complete idempotent read-only migration without mutating source files', () => {
  const root = tempDir('vela-s1c-mig-')
  dirs.push(root)
  const agentDir = join(root.path, 'agent')
  const repoCwd = join(root.path, 'repo-a')
  const projectDataDir = join(agentDir, 'projects', '--repo-a--11223344')
  const larkAssetDir = join(projectDataDir, 'channels', 'feishu-oc_team1')

  mkdirSync(join(agentDir, 'sessions'), { recursive: true })
  mkdirSync(join(repoCwd, '.vela'), { recursive: true })
  mkdirSync(join(projectDataDir, 'local', 'proj-1', 'local-only-session'), {
    recursive: true,
  })
  mkdirSync(join(projectDataDir, 'channels'), { recursive: true })
  mkdirSync(larkAssetDir, { recursive: true })
  mkdirSync(join(projectDataDir, 'sessions', 's-v2'), { recursive: true })
  mkdirSync(join(projectDataDir, 'sessions', 's-dup'), { recursive: true })
  mkdirSync(join(projectDataDir, 'tool-results'), { recursive: true })
  mkdirSync(join(projectDataDir, 'usage'), { recursive: true })

  const legacySettings = {
    defaultModel: 'deepseek/deepseek-flash',
    defaultThinkingLevel: 'high',
    defaultTools: ['read', 'write', 'bash'],
    bashForegroundTimeoutSeconds: 90,
    bashForegroundTimeoutMaxSeconds: 600,
    environments: {
      box: { image: 'node:24', network: 'on' },
    },
    extensionConfig: {
      lark: {
        appId: 'cli_legacy',
        appSecret: '$LARK_SECRET',
        chats: [
          {
            id: 'oc_team1',
            model: 'anthropic/claude-opus-4-8',
            topicModel: 'deepseek/deepseek-flash',
            tools: ['read', 'bash'],
            readUntagged: true,
          },
        ],
      },
      web: { tavilyKey: '$TAVILY_KEY' },
      memory: { dream: true },
      local: { port: 8788 },
      channel: {
        eventReceiver: { port: 9090 },
        eventDefaultTarget: { channel: 'lark', chatId: 'oc_team1' },
      },
      mcp: {
        mcpServers: {
          shared: { command: 'echo', args: ['from-settings'] },
          onlySettings: { command: 'echo', args: ['ok'] },
        },
      },
      background: {},
      todo: {},
      customExt: { flag: 42 },
    },
  }
  const legacyModels = {
    providers: {
      custom: {
        api: 'openai-completions',
        baseUrl: 'https://example.invalid/v1',
        models: [{ id: 'm1', contextWindow: 64000 }],
      },
    },
  }
  const legacyMcp = {
    mcpServers: {
      shared: { command: 'echo', args: ['from-mcp-json'] },
    },
  }
  const legacyTrust = { [repoCwd]: true, '/tmp/untrusted': false }

  const localProjects = {
    version: 1,
    deploymentId: 'dep-uuid-1',
    projects: [
      {
        id: 'proj-1',
        cwd: repoCwd,
        name: 'repo-a',
        sessionId: 'local-proj_1',
        channel: 'local',
      },
    ],
  }
  const localMessages = [
    {
      id: 'lmsg-1',
      sessionId: 'local-only-session',
      role: 'user',
      text: 'See attached spec',
      createdAt: '2026-11-20T10:00:00Z',
      file: { name: 'spec.txt', size: 11 },
    },
  ]
  const channelIndex = {
    version: 1,
    createdAt: '2026-11-20T09:00:00Z',
    records: [
      {
        key: 'lark-oc_team1',
        channel: 'lark',
        storageKey: 'feishu-oc_team1',
        chatId: 'oc_team1',
        chatKind: 'group',
        requester: { id: 'ou_1', name: 'Alice' },
        task: 'Team Hub',
        activeSessionId: 'lark-oc_team1',
        previousSessionIds: ['lark-oc_team1-old'],
        state: 'done',
        pendingMessageIds: [],
        createdAt: '2026-11-20T09:00:00Z',
        updatedAt: '2026-11-20T09:05:00Z',
      },
      {
        key: 'lark-oc_team1-om_root1',
        channel: 'lark',
        storageKey: 'feishu-oc_team1',
        chatId: 'oc_team1',
        chatKind: 'group',
        rootId: 'om_root1',
        threadId: 'omt_1',
        requester: { id: 'ou_1', name: 'Alice' },
        task: 'Fix bug',
        activeSessionId: 'topic-sess-1',
        previousSessionIds: [],
        state: 'waiting',
        waitingReason: 'Need approval',
        pendingMessageIds: [],
        createdAt: '2026-11-20T09:10:00Z',
        updatedAt: '2026-11-20T09:15:00Z',
      },
      {
        key: 'lark-ou_dm',
        channel: 'lark',
        chatId: 'ou_dm',
        chatKind: 'direct',
        requester: { id: 'ou_dm', name: 'Bob' },
        task: 'DM chat',
        activeSessionId: 'dm-sess-1',
        previousSessionIds: [],
        state: 'running',
        pendingMessageIds: [],
        createdAt: '2026-11-20T09:20:00Z',
        updatedAt: '2026-11-20T09:25:00Z',
      },
    ],
    notes: {
      'lark-oc_team1': ['Topic om_root1 waiting for approval'],
    },
  }
  const legacyRoutines = {
    version: 1,
    routines: [
      {
        id: 'rt-1',
        channel: 'lark',
        chatId: 'oc_team1',
        targetKey: 'lark-oc_team1',
        creator: { id: 'ou_1', name: 'Alice' },
        message: 'Daily standup check',
        schedule: { time: '09:30', days: ['mon', 'wed'] },
        createdAt: '2026-11-20T08:00:00Z',
        lastFiredAt: null,
      },
    ],
  }
  const legacySubscriptions = {
    version: 1,
    subscriptions: [
      {
        id: 'sub-1',
        source: 'github',
        key: 'github:glows777/Vela#pr/100',
        targetKey: 'lark-oc_team1-om_root1',
        channel: 'lark',
        chatId: 'oc_team1',
        creator: { id: 'ou_1', name: 'Alice' },
      },
    ],
  }

  // V2 transcript testing: control entries interleaved with kept entries, label, context_edit,
  // AI SDK legacy part tags, compaction.firstKeptEntryId pointing to a stripped control entry,
  // and a damaged trailing line.
  const v2Transcript = [
    JSON.stringify({
      type: 'session',
      version: 2,
      id: 's-v2',
      timestamp: '2026-11-20T10:00:00Z',
      cwd: repoCwd,
    }),
    JSON.stringify({
      type: 'model_change',
      id: 'c1',
      parentId: null,
      timestamp: '2026-11-20T10:00:01Z',
      model: 'deepseek/deepseek-flash',
    }),
    JSON.stringify({
      type: 'message',
      id: 'm1',
      parentId: 'c1',
      timestamp: '2026-11-20T10:00:02Z',
      message: { role: 'user', content: 'hello' },
    }),
    JSON.stringify({
      type: 'thinking_level_change',
      id: 'c2',
      parentId: 'm1',
      timestamp: '2026-11-20T10:00:03Z',
      thinkingLevel: 'high',
    }),
    JSON.stringify({
      type: 'message',
      id: 'm2',
      parentId: 'c2',
      timestamp: '2026-11-20T10:00:04Z',
      producedBy: 'deepseek/deepseek-flash',
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'hmm' },
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'read',
            input: { path: 'a.ts' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'label',
      id: 'l1',
      parentId: 'm2',
      timestamp: '2026-11-20T10:00:05Z',
      targetId: 'm1',
      label: 'checkpoint-1',
    }),
    JSON.stringify({
      type: 'compaction',
      id: 'cmp1',
      parentId: 'l1',
      timestamp: '2026-11-20T10:00:06Z',
      summary: 'Earlier summary',
      firstKeptEntryId: 'c2',
      tokensBefore: 12000,
    }),
    JSON.stringify({
      type: 'bash_execution',
      id: 'b1',
      parentId: 'cmp1',
      timestamp: '2026-11-20T10:00:07Z',
      command: 'pwd',
      output: '/tmp',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: true,
    }),
    JSON.stringify({
      type: 'session_info',
      id: 'info1',
      parentId: 'b1',
      timestamp: '2026-11-20T10:00:08Z',
      name: 'Renamed V2 Session',
    }),
    JSON.stringify({
      type: 'context_edit',
      id: 'ce1',
      parentId: 'info1',
      timestamp: '2026-11-20T10:00:09Z',
      targetId: 'm1',
      replacement: { content: 'edited hello' },
    }),
    '{"type":"message","id":"truncated',
  ].join('\n')

  // V1 checkpoint transcript
  const v1Transcript = [
    JSON.stringify({
      type: 'checkpoint',
      timestamp: '2026-11-19T08:00:00Z',
      model: 'openai/gpt-5.5',
      thinkingLevel: 'medium',
      name: 'V1 Session',
      messages: [
        {
          timestamp: '2026-11-19T08:00:01Z',
          message: { role: 'user', content: 'from v1' },
        },
      ],
    }),
  ].join('\n')

  // 0.5.0 flat file vs directory precedence
  const flatOnly =
    JSON.stringify({
      type: 'session',
      version: 2,
      id: 's-flat',
      timestamp: '2026-11-19T07:00:00Z',
    }) +
    '\n' +
    JSON.stringify({
      type: 'message',
      id: 'fm1',
      parentId: null,
      timestamp: '2026-11-19T07:00:01Z',
      message: { role: 'user', content: 'flat' },
    })

  const dirWinner =
    JSON.stringify({
      type: 'session',
      version: 2,
      id: 's-dup',
      timestamp: '2026-11-19T07:00:00Z',
    }) +
    '\n' +
    JSON.stringify({
      type: 'message',
      id: 'dm1',
      parentId: null,
      timestamp: '2026-11-19T07:00:01Z',
      message: { role: 'user', content: 'from-dir' },
    })
  const flatLoser =
    JSON.stringify({
      type: 'session',
      version: 2,
      id: 's-dup',
      timestamp: '2026-11-19T07:00:00Z',
    }) +
    '\n' +
    JSON.stringify({
      type: 'message',
      id: 'fl1',
      parentId: null,
      timestamp: '2026-11-19T07:00:01Z',
      message: { role: 'user', content: 'from-flat-stale' },
    })

  const trackedFiles = [
    join(agentDir, 'settings.json'),
    join(agentDir, 'models.json'),
    join(agentDir, 'mcp.json'),
    join(agentDir, 'trust.json'),
    join(agentDir, 'auth.json'),
    join(agentDir, 'AGENTS.md'),
    join(agentDir, 'MEMORY.md'),
    join(repoCwd, '.vela', 'settings.json'),
    join(projectDataDir, 'local', 'projects.json'),
    join(projectDataDir, 'local', 'proj-1.json'),
    join(projectDataDir, 'local', 'proj-1', 'local-only-session', 'lmsg-1'),
    join(projectDataDir, 'channels', 'index.json'),
    join(projectDataDir, 'channels', 'routines.json'),
    join(projectDataDir, 'channels', 'subscriptions.json'),
    join(larkAssetDir, 'AGENTS.md'),
    join(projectDataDir, 'sessions', 's-v2', 'transcript.jsonl'),
    join(projectDataDir, 'sessions', 's-dup', 'transcript.jsonl'),
    join(projectDataDir, 'sessions', 's-dup.jsonl'),
    join(projectDataDir, 'sessions', 's-flat.jsonl'),
    join(agentDir, 'sessions', 's-v1.jsonl'),
    join(projectDataDir, 'tool-results', 'history.jsonl'),
    join(projectDataDir, 'usage', 'requests.jsonl'),
  ]

  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(legacySettings))
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify(legacyModels))
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify(legacyMcp))
  writeFileSync(join(agentDir, 'trust.json'), JSON.stringify(legacyTrust))
  writeFileSync(
    join(agentDir, 'auth.json'),
    '{"openai":{"type":"api_key","key":"sk-test"}}',
  )
  writeFileSync(join(agentDir, 'AGENTS.md'), '# User Instructions')
  writeFileSync(join(agentDir, 'MEMORY.md'), '# Memory')
  writeFileSync(
    join(repoCwd, '.vela', 'settings.json'),
    '{"defaultModel":"openai/gpt-5.5"}',
  )
  writeFileSync(
    join(projectDataDir, 'local', 'projects.json'),
    JSON.stringify(localProjects),
  )
  writeFileSync(
    join(projectDataDir, 'local', 'proj-1.json'),
    JSON.stringify(localMessages),
  )
  writeFileSync(
    join(projectDataDir, 'local', 'proj-1', 'local-only-session', 'lmsg-1'),
    'hello-world',
  )
  writeFileSync(
    join(projectDataDir, 'channels', 'index.json'),
    JSON.stringify(channelIndex),
  )
  writeFileSync(
    join(projectDataDir, 'channels', 'routines.json'),
    JSON.stringify(legacyRoutines),
  )
  writeFileSync(
    join(projectDataDir, 'channels', 'subscriptions.json'),
    JSON.stringify(legacySubscriptions),
  )
  writeFileSync(join(larkAssetDir, 'AGENTS.md'), '# Team Group')
  writeFileSync(
    join(projectDataDir, 'sessions', 's-v2', 'transcript.jsonl'),
    v2Transcript,
  )
  writeFileSync(
    join(projectDataDir, 'sessions', 's-dup', 'transcript.jsonl'),
    dirWinner,
  )
  writeFileSync(join(projectDataDir, 'sessions', 's-dup.jsonl'), flatLoser)
  writeFileSync(join(projectDataDir, 'sessions', 's-flat.jsonl'), flatOnly)
  writeFileSync(join(agentDir, 'sessions', 's-v1.jsonl'), v1Transcript)
  writeFileSync(
    join(projectDataDir, 'tool-results', 'history.jsonl'),
    '{"ignored":true}\n',
  )
  writeFileSync(
    join(projectDataDir, 'usage', 'requests.jsonl'),
    '{"ignored":true}\n',
  )

  const beforeSnap = snapshotFiles(trackedFiles)

  const db = openDatabase({ path: join(agentDir, 'vela.db') })
  try {
    const res1 = migrateLegacyVelaDir({ agentDir, db })
    expect(res1.skipped).toBe(false)
    expect(res1.summary.configMigrated).toBe(true)
    expect(res1.summary.trustedPaths).toBe(2)
    expect(res1.summary.projects).toBe(2) // proj-1 + lark-group:oc_team1
    expect(res1.summary.blobs).toBe(1)
    expect(res1.summary.timers).toBe(1)
    expect(res1.summary.subscriptions).toBe(1)
    expect(res1.summary.inboxEvents).toBe(1)
    expect(
      res1.warnings.some((w) => w.includes('Skipped unparsable line')),
    ).toBe(true)

    // Generated config.json passes strict schema + precedence checks
    const configPath = join(agentDir, 'config.json')
    expect(existsSync(configPath)).toBe(true)
    const flattened = parseConfig(readFileSync(configPath, 'utf8'), configPath)
    expect(flattened.model).toBe('deepseek/deepseek-flash')
    expect(flattened.thinkingLevel).toBe('high')
    expect(flattened.tools).toEqual(['read', 'write', 'bash'])
    expect(flattened.providers?.custom?.models?.[0]?.id).toBe('m1')
    expect(flattened.mcpServers).toEqual({
      shared: { command: 'echo', args: ['from-mcp-json'] },
      onlySettings: { command: 'echo', args: ['ok'] },
    })
    expect(flattened.webhooks).toEqual({ port: 9090 })
    expect(flattened.eventDefaultTarget).toEqual({
      channel: 'lark',
      chatId: 'oc_team1',
    })
    expect(flattened.extensionConfig).toEqual({ customExt: { flag: 42 } })

    // Verify loadConfig reads migrated config.json cleanly
    const loaded = loadConfig({
      agentDir,
      cwd: root.path,
      env: { LARK_SECRET: 's', TAVILY_KEY: 't' },
    })
    expect(loaded.settings.model).toBe('deepseek/deepseek-flash')

    // Verify projects & data_dir anchor
    const larkProject = db.get<{
      data_dir: string | null
      hub_session_id: string | null
    }>(
      "SELECT data_dir, hub_session_id FROM projects WHERE id = 'lark-group:oc_team1'",
    )
    expect(larkProject?.data_dir).toBe(larkAssetDir)
    expect(larkProject?.hub_session_id).toBe('lark-oc_team1')

    const localProject = db.get<{
      data_dir: string | null
      hub_session_id: string | null
    }>("SELECT data_dir, hub_session_id FROM projects WHERE id = 'proj-1'")
    expect(localProject?.data_dir).toBe(projectDataDir)
    expect(localProject?.hub_session_id).toBeNull()

    // Verify tree re-chaining + label + context_edit + AI SDK part normalization + compaction.first_kept_id
    const v2Sess = db.get<{
      name: string
      model: string
      thinking_level: string
      leaf_message_id: string
    }>(
      "SELECT name, model, thinking_level, leaf_message_id FROM sessions WHERE id = 's-v2'",
    )
    expect(v2Sess).toEqual({
      name: 'Renamed V2 Session',
      model: 'deepseek/deepseek-flash',
      thinking_level: 'high',
      leaf_message_id: 'b1',
    })

    const m1 = db.get<{
      parent_id: string | null
      label: string | null
      content_json: string
    }>(
      "SELECT parent_id, label, content_json FROM vela_messages WHERE session_id = 's-v2' AND id = 'm1'",
    )
    expect(m1?.parent_id).toBeNull() // skipped c1
    expect(m1?.label).toBe('checkpoint-1')
    expect(JSON.parse(m1!.content_json)).toEqual({
      role: 'user',
      content: 'edited hello',
    })

    const m2 = db.get<{ parent_id: string | null; content_json: string }>(
      "SELECT parent_id, content_json FROM vela_messages WHERE session_id = 's-v2' AND id = 'm2'",
    )
    expect(m2?.parent_id).toBe('m1') // skipped c2
    const m2Parsed = JSON.parse(m2!.content_json)
    expect(m2Parsed.content[0].type).toBe('thinking')
    expect(m2Parsed.content[1].type).toBe('tool_call')

    const cmp1 = db.get<{
      parent_id: string | null
      first_kept_id: string | null
    }>(
      "SELECT parent_id, first_kept_id FROM vela_messages WHERE session_id = 's-v2' AND id = 'cmp1'",
    )
    expect(cmp1?.parent_id).toBe('m2') // skipped l1
    expect(cmp1?.first_kept_id).toBe('m2') // c2 remapped to next kept node m2!

    const b1 = db.get<{ parent_id: string | null; include_in_context: number }>(
      "SELECT parent_id, include_in_context FROM vela_messages WHERE session_id = 's-v2' AND id = 'b1'",
    )
    expect(b1?.parent_id).toBe('cmp1')
    expect(b1?.include_in_context).toBe(0) // !! / excludeFromContext

    // Verify recursive CTE from leaf_message_id is unbroken
    const cteIds = db
      .all<{ id: string }>(
        `WITH RECURSIVE tree(id, parent_id, seq) AS (
           SELECT id, parent_id, seq FROM vela_messages WHERE session_id = 's-v2' AND id = ?
           UNION ALL
           SELECT m.id, m.parent_id, m.seq FROM vela_messages m
           JOIN tree t ON m.session_id = 's-v2' AND m.id = t.parent_id
         )
         SELECT id FROM tree ORDER BY seq ASC`,
        v2Sess!.leaf_message_id,
      )
      .map((r) => r.id)
    expect(cteIds).toEqual(['m1', 'm2', 'cmp1', 'b1'])

    // Verify directory transcript won over stale flat .jsonl
    const dupMsg = db.get<{ content_json: string }>(
      "SELECT content_json FROM vela_messages WHERE session_id = 's-dup'",
    )
    expect(JSON.parse(dupMsg!.content_json).content).toBe('from-dir')

    // Verify V1 checkpoint & fallback local message + blob linkage
    expect(
      db.get<{ name: string }>("SELECT name FROM sessions WHERE id = 's-v1'")
        ?.name,
    ).toBe('V1 Session')
    const blob = db.get<{ session_id: string | null; storage_path: string }>(
      'SELECT session_id, storage_path FROM blobs',
    )
    expect(blob?.session_id).toBe('local-only-session')
    expect(blob?.storage_path).toMatch(/^[0-9a-f-]+\.txt$/)
    expect(
      readFileSync(join(agentDir, 'blobs', blob!.storage_path), 'utf8'),
    ).toBe('hello-world')

    // Verify topic & DM bindings + waiting state
    const topicSess = db.get<{
      kind: string
      state: string
      waiting_reason: string | null
    }>(
      "SELECT kind, state, waiting_reason FROM sessions WHERE id = 'topic-sess-1'",
    )
    expect(topicSess).toEqual({
      kind: 'topic',
      state: 'waiting_human',
      waiting_reason: 'Need approval',
    })
    const dmSess = db.get<{ kind: string; state: string }>(
      "SELECT kind, state FROM sessions WHERE id = 'dm-sess-1'",
    )
    expect(dmSess).toEqual({ kind: 'chat', state: 'idle' })

    // Re-running is idempotent no-op
    const res2 = migrateLegacyVelaDir({ agentDir, db })
    expect(res2.skipped).toBe(true)
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM sessions')?.n).toBe(
      res1.summary.sessions,
    )

    // Verify every single legacy source file & project .vela/settings.json is byte-identical & mtime-unchanged
    const afterSnap = snapshotFiles(trackedFiles)
    for (const file of trackedFiles) {
      expect(afterSnap.get(file)).toEqual(beforeSnap.get(file))
    }
  } finally {
    db.close()
  }
})

test('failed migration rolls back DB and copied blobs, and redacts JSON parse secrets', () => {
  const root = tempDir('vela-s1c-rollback-')
  dirs.push(root)
  const agentDir = join(root.path, 'agent')
  const projectDataDir = join(agentDir, 'projects', '--proj--1')
  mkdirSync(join(projectDataDir, 'local', 'p1', 's1'), { recursive: true })
  mkdirSync(join(projectDataDir, 'channels'), { recursive: true })

  writeFileSync(join(agentDir, 'config.json'), '{}')
  writeFileSync(
    join(projectDataDir, 'local', 'projects.json'),
    JSON.stringify({
      version: 1,
      deploymentId: 'd1',
      projects: [
        {
          id: 'p1',
          cwd: '/tmp/p1',
          name: 'p1',
          sessionId: 'local-p1',
          channel: 'local',
        },
      ],
    }),
  )
  writeFileSync(
    join(projectDataDir, 'local', 'p1.json'),
    JSON.stringify([
      {
        id: 'm1',
        sessionId: 's1',
        role: 'user',
        text: 'hi',
        createdAt: '2026-11-24T00:00:00Z',
        file: { name: 'a.txt', size: 2 },
      },
    ]),
  )
  writeFileSync(join(projectDataDir, 'local', 'p1', 's1', 'm1'), 'ok')
  // Corrupt channels/index.json containing a secret-like token
  writeFileSync(
    join(projectDataDir, 'channels', 'index.json'),
    '{ "secret": "sk-super-secret-value", badJson }',
  )

  const db = openDatabase({ path: join(agentDir, 'vela.db') })
  try {
    let caught: unknown
    try {
      migrateLegacyVelaDir({ agentDir, db })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    expect(msg).toContain('is not valid JSON')
    expect(msg).not.toContain('sk-super-secret-value')
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM projects')?.n).toBe(
      0,
    )
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM blobs')?.n).toBe(0)
    // Copied blob cleaned up on rollback
    expect(
      existsSync(join(agentDir, 'blobs'))
        ? readdirSync(join(agentDir, 'blobs')).length
        : 0,
    ).toBe(0)
  } finally {
    db.close()
  }
})

test('CLI startup automatically migrates legacy settings.json/models.json/mcp.json to config.json while keeping loadConfig pure read', () => {
  const root = tempDir('vela-s1c-cli-')
  dirs.push(root)
  const agentDir = join(root.path, 'agent')
  const cwd = join(root.path, 'work')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })

  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      defaultModel: 'openai/gpt-5.5',
      defaultThinkingLevel: 'low',
    }),
  )
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        custom: {
          api: 'openai-completions',
          baseUrl: 'https://example.invalid/v1',
          apiKey: 'test-key',
          models: [{ id: 'demo-model' }],
        },
      },
    }),
  )
  writeFileSync(
    join(agentDir, 'mcp.json'),
    JSON.stringify({ mcpServers: { echo: { command: 'echo', args: ['1'] } } }),
  )

  // Direct loadConfig still fails fast before startup migration runs
  expect(() => loadConfig({ agentDir, cwd })).toThrow(
    'found legacy config file(s)',
  )

  const cliEntry = join(import.meta.dir, '../../../src/cli/main.ts')
  const run = spawnSync(
    'bun',
    ['run', cliEntry, '--list-models', 'demo-model'],
    {
      cwd,
      env: { ...process.env, HOME: root.path, VELA_DIR: agentDir },
      encoding: 'utf8',
    },
  )
  expect(run.status).toBe(0)
  expect(run.stdout).toContain('demo-model')
  expect(run.stderr).toContain('Migrated settings.json, models.json, mcp.json')
  expect(existsSync(join(agentDir, 'config.json'))).toBe(true)
  expect(existsSync(join(agentDir, 'settings.json'))).toBe(true)
  expect(existsSync(join(agentDir, 'models.json'))).toBe(true)
  expect(existsSync(join(agentDir, 'mcp.json'))).toBe(true)
})
