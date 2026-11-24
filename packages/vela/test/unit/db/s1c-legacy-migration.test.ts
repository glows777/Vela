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
  const projectDataDirB = join(agentDir, 'projects', '--repo-b--55667788')
  const larkAssetDir = join(projectDataDir, 'channels', 'feishu-oc_team1')

  mkdirSync(join(agentDir, 'sessions'), { recursive: true })
  mkdirSync(join(repoCwd, '.vela'), { recursive: true })
  mkdirSync(join(projectDataDir, 'local', 'proj-1', 'local-only-session'), {
    recursive: true,
  })
  mkdirSync(join(projectDataDir, 'local', 'proj-1', 's-v2'), {
    recursive: true,
  })
  mkdirSync(join(projectDataDir, 'channels'), { recursive: true })
  mkdirSync(larkAssetDir, { recursive: true })
  mkdirSync(join(projectDataDir, 'sessions', 's-v2'), { recursive: true })
  mkdirSync(join(projectDataDir, 'sessions', 's-dup'), { recursive: true })
  mkdirSync(join(projectDataDirB, 'sessions', 's-dup'), { recursive: true })
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
        timezone: 'Asia/Shanghai',
        owners: ['ou_dm'],
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
      {
        id: '../unsafe-escape',
        cwd: '/tmp/escape',
        name: 'bad',
        sessionId: 'bad',
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
    {
      id: 'lmsg-out',
      sessionId: 's-v2',
      role: 'assistant',
      text: 'report.pdf',
      createdAt: '2026-11-20T10:05:00Z',
      file: { name: 'report.pdf', size: 12 },
    },
  ]

  // Note: hub record appears BEFORE any topic record (tests #2 FK ordering)
  // plus a Local channel record matching proj-1 (tests #3 no duplicate project)
  // plus a removed Lark chat oc_removed not in lark.chats (tests #4 enabled=0)
  // plus pendingMessageIds and legacyKey (tests #14 and #24)
  const channelIndex = {
    version: 1,
    createdAt: '2026-11-20T09:00:00Z',
    records: [
      {
        key: 'local-proj_1',
        channel: 'local',
        chatId: 'proj-1',
        chatKind: 'group',
        requester: { id: 'local-user', name: 'You' },
        task: 'Local work',
        activeSessionId: 'local-proj_1',
        previousSessionIds: [],
        state: 'done',
        pendingMessageIds: [],
        createdAt: '2026-11-20T08:50:00Z',
        updatedAt: '2026-11-20T08:55:00Z',
      },
      {
        key: 'lark-oc_hub_first',
        legacyKey: 'legacy-hub-alias',
        channel: 'lark',
        storageKey: 'feishu-oc_team1',
        chatId: 'oc_team1',
        chatKind: 'group',
        requester: { id: 'ou_1', name: 'Alice' },
        task: 'Team Hub',
        activeSessionId: 'lark-oc_team1',
        previousSessionIds: ['lark-oc_team1-old'],
        state: 'done',
        pendingMessageIds: [{ id: 'om_pending_1', passive: true }],
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
        key: 'lark-oc_removed-om_old',
        channel: 'lark',
        storageKey: '../bad-escape',
        chatId: 'oc_removed',
        chatKind: 'group',
        rootId: 'om_old',
        threadId: 'omt_old',
        requester: { id: 'ou_1', name: 'Alice' },
        task: 'Old removed group topic',
        activeSessionId: 'removed-topic-sess',
        previousSessionIds: [],
        state: 'done',
        pendingMessageIds: [],
        createdAt: '2026-11-20T09:18:00Z',
        updatedAt: '2026-11-20T09:19:00Z',
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
      'lark-oc_hub_first': ['Topic om_root1 waiting for approval'],
    },
  }
  const legacyRoutines = {
    version: 1,
    routines: [
      {
        id: 'rt-1',
        channel: 'lark',
        chatId: 'oc_team1',
        targetKey: 'legacy-hub-alias',
        creator: { id: 'ou_1', name: 'Alice' },
        message: 'Daily standup check',
        schedule: { time: '09:30', days: ['mon', 'wed'] },
        createdAt: '2026-11-20T08:00:00Z',
        lastFiredAt: null,
      },
      {
        id: 'rt-past',
        channel: 'lark',
        chatId: 'oc_team1',
        targetKey: 'legacy-hub-alias',
        creator: { id: 'ou_1', name: 'Alice' },
        message: 'Expired one-off',
        schedule: { at: '2020-01-01T00:00:00Z' },
        createdAt: '2019-12-31T00:00:00Z',
        lastFiredAt: '2020-01-01T00:00:00Z',
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

  // V2 transcript testing:
  // - vela.session.location marker folded into sessions.location_json & omitted from tree
  // - branch-scoped context_edit (sibling branch edit does NOT touch m1 on active branch!)
  // - tool_search result populates discovered_tools_json
  // - malformed message: null skipped safely
  // - damaged trailing line containing a secret is redacted
  const v2Transcript = [
    JSON.stringify({
      type: 'session',
      version: 2,
      id: 's-v2',
      timestamp: '2026-11-20T10:00:00Z',
      cwd: repoCwd,
      location: { environment: 'local', cwd: repoCwd },
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
    // Sibling branch off m1 with a context_edit targeting m1 (must NOT affect active branch)
    JSON.stringify({
      type: 'context_edit',
      id: 'ce_sib',
      parentId: 'm1',
      timestamp: '2026-11-20T10:00:02.500Z',
      targetId: 'm1',
      replacement: null,
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
            toolName: 'tool_search',
            input: { query: 'mcp' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'm2_res',
      parentId: 'm2',
      timestamp: '2026-11-20T10:00:04.500Z',
      message: {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc1',
            toolName: 'tool_search',
            output: {
              type: 'text',
              value:
                'Loaded 1 tool. They are available from your next call:\n- mcp__demo__echo: Echo tool',
            },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'label',
      id: 'l1',
      parentId: 'm2_res',
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
      type: 'custom',
      customType: 'vela.session.location',
      id: 'location:1',
      parentId: 'b1',
      timestamp: '2026-11-20T10:00:07.500Z',
      data: { environment: 'docker-box', cwd: '/workspace' },
    }),
    JSON.stringify({
      type: 'session_info',
      id: 'info1',
      parentId: 'location:1',
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
    JSON.stringify({
      type: 'message',
      id: 'bad_null_msg',
      parentId: 'ce1',
      timestamp: '2026-11-20T10:00:09.500Z',
      message: null,
    }),
    '{"type":"message","id":"sk-jsonl-secret-value',
  ].join('\n')

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

  const flatOnly = `${[
    JSON.stringify({
      type: 'session',
      version: 2,
      id: 's-flat',
      timestamp: '2026-11-19T07:00:00Z',
    }),
    JSON.stringify({
      type: 'message',
      id: 'fm1',
      parentId: null,
      timestamp: '2026-11-19T07:00:01Z',
      message: { role: 'user', content: 'flat' },
    }),
  ].join('\n')}\n`

  const dirWinner = `${[
    JSON.stringify({
      type: 'session',
      version: 2,
      id: 's-dup',
      timestamp: '2026-11-19T07:00:00Z',
    }),
    JSON.stringify({
      type: 'message',
      id: 'dm1',
      parentId: null,
      timestamp: '2026-11-19T07:00:01Z',
      message: { role: 'user', content: 'from-dir' },
    }),
  ].join('\n')}\n`

  const dirProjectB = `${[
    JSON.stringify({
      type: 'session',
      version: 2,
      id: 's-dup',
      timestamp: '2026-11-19T07:30:00Z',
    }),
    JSON.stringify({
      type: 'message',
      id: 'dm2',
      parentId: null,
      timestamp: '2026-11-19T07:30:01Z',
      message: { role: 'user', content: 'from-project-b' },
    }),
  ].join('\n')}\n`

  const flatLoser = `${[
    JSON.stringify({
      type: 'session',
      version: 2,
      id: 's-dup',
      timestamp: '2026-11-19T07:00:00Z',
    }),
    JSON.stringify({
      type: 'message',
      id: 'fl1',
      parentId: null,
      timestamp: '2026-11-19T07:00:01Z',
      message: { role: 'user', content: 'from-flat-stale' },
    }),
  ].join('\n')}\n`

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
    join(projectDataDir, 'local', 'proj-1', 's-v2', 'lmsg-out'),
    join(projectDataDir, 'channels', 'index.json'),
    join(projectDataDir, 'channels', 'routines.json'),
    join(projectDataDir, 'channels', 'subscriptions.json'),
    join(larkAssetDir, 'AGENTS.md'),
    join(projectDataDir, 'sessions', 's-v2', 'transcript.jsonl'),
    join(projectDataDir, 'sessions', 's-dup', 'transcript.jsonl'),
    join(projectDataDirB, 'sessions', 's-dup', 'transcript.jsonl'),
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
    join(projectDataDir, 'local', 'proj-1', 's-v2', 'lmsg-out'),
    'outbound-pdf-bytes',
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
  writeFileSync(
    join(projectDataDirB, 'sessions', 's-dup', 'transcript.jsonl'),
    dirProjectB,
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
    expect(res1.summary.projects).toBe(3) // proj-1 + lark-group:oc_team1 + lark-group:oc_removed
    expect(res1.summary.blobs).toBe(2)
    expect(res1.summary.timers).toBe(2)
    expect(res1.summary.subscriptions).toBe(1)
    expect(res1.summary.inboxEvents).toBe(2) // 1 handoff note + 1 pendingMessageId

    // Redacted JSONL warnings never leak raw line contents
    expect(
      res1.warnings.some((w) => w.includes('Skipped unparsable line')),
    ).toBe(true)
    expect(res1.warnings.some((w) => w.includes('sk-jsonl-secret-value'))).toBe(
      false,
    )
    expect(res1.warnings.some((w) => w.includes('unsafe storageKey'))).toBe(
      true,
    )

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

    const loaded = loadConfig({
      agentDir,
      cwd: root.path,
      env: { LARK_SECRET: 's', TAVILY_KEY: 't' },
    })
    expect(loaded.settings.model).toBe('deepseek/deepseek-flash')

    // Local project had no duplicate channel-group:local:proj-1 & kept hub_session_id null
    expect(
      db.get<{ id: string }>(
        "SELECT id FROM projects WHERE id = 'channel-group:local:proj-1'",
      ),
    ).toBeUndefined()
    const localProject = db.get<{
      data_dir: string | null
      hub_session_id: string | null
    }>("SELECT data_dir, hub_session_id FROM projects WHERE id = 'proj-1'")
    expect(localProject).toEqual({
      data_dir: projectDataDir,
      hub_session_id: null,
    })

    // Removed Lark group binding stays disabled (enabled = 0), active group & owner DM stay enabled = 1
    expect(
      db.get<{ enabled: number }>(
        "SELECT enabled FROM channel_bindings WHERE external_id = 'oc_team1'",
      )?.enabled,
    ).toBe(1)
    expect(
      db.get<{ enabled: number; kind: string }>(
        "SELECT enabled, kind FROM channel_bindings WHERE external_id = 'oc_team1:om_root1'",
      ),
    ).toEqual({ enabled: 1, kind: 'group' })
    expect(
      db.get<{ enabled: number; kind: string }>(
        "SELECT enabled, kind FROM channel_bindings WHERE external_id = 'ou_dm'",
      ),
    ).toEqual({ enabled: 1, kind: 'direct' })
    expect(
      db.get<{ enabled: number }>(
        "SELECT enabled FROM channel_bindings WHERE external_id = 'oc_removed:om_old'",
      )?.enabled,
    ).toBe(0)
    expect(
      db.get<{ data_dir: string | null }>(
        "SELECT data_dir FROM projects WHERE id = 'lark-group:oc_removed'",
      )?.data_dir,
    ).toBeNull()

    // Passive pendingMessageId was imported non-waking / dropped
    expect(
      db.get<{ wake: number; passive: number; status: string }>(
        "SELECT wake, passive, status FROM inbox_events WHERE dedupe_key = 'lark:oc_team1:om_pending_1'",
      ),
    ).toEqual({ wake: 0, passive: 1, status: 'dropped' })

    // Verify V2 session metadata: folded vela.session.location, discovered_tools_json, leaf_message_id
    const v2Sess = db.get<{
      name: string
      model: string
      thinking_level: string
      location_json: string
      discovered_tools_json: string | null
      leaf_message_id: string
    }>(
      "SELECT name, model, thinking_level, location_json, discovered_tools_json, leaf_message_id FROM sessions WHERE id = 's-v2'",
    )
    expect(v2Sess).toEqual({
      name: 'Renamed V2 Session',
      model: 'deepseek/deepseek-flash',
      thinking_level: 'high',
      location_json: JSON.stringify({
        environment: 'docker-box',
        cwd: '/workspace',
      }),
      discovered_tools_json: JSON.stringify(['mcp__demo__echo']),
      leaf_message_id: 'ce1',
    })

    // Original m1 is preserved (not mutated by active branch context_edit), and both ce1 and ce_sib rows exist
    const m1 = db.get<{
      parent_id: string | null
      label: string | null
      include_in_context: number
      content_json: string
    }>(
      "SELECT parent_id, label, include_in_context, content_json FROM vela_messages WHERE session_id = 's-v2' AND id = 'm1'",
    )
    expect(m1?.parent_id).toBeNull()
    expect(m1?.label).toBe('checkpoint-1')
    expect(m1?.include_in_context).toBe(1)
    expect(JSON.parse(m1!.content_json)).toEqual({
      role: 'user',
      content: 'hello',
    })
    const ce1Row = db.get<{
      kind: string
      parent_id: string | null
      content_json: string
    }>(
      "SELECT kind, parent_id, content_json FROM vela_messages WHERE session_id = 's-v2' AND id = 'ce1'",
    )
    expect(ce1Row?.kind).toBe('context_edit')
    expect(ce1Row?.parent_id).toBe('b1')
    expect(JSON.parse(ce1Row!.content_json)).toEqual({
      targetId: 'm1',
      replacement: { content: 'edited hello' },
    })

    const cmp1 = db.get<{
      parent_id: string | null
      first_kept_id: string | null
    }>(
      "SELECT parent_id, first_kept_id FROM vela_messages WHERE session_id = 's-v2' AND id = 'cmp1'",
    )
    expect(cmp1?.parent_id).toBe('m2_res')
    expect(cmp1?.first_kept_id).toBe('m2')

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
    expect(cteIds).toEqual(['m1', 'm2', 'm2_res', 'cmp1', 'b1', 'ce1'])

    // Verify colliding session id across distinct project dataDirs was disambiguated, not dropped
    const dupSessions = db.all<{ id: string }>(
      "SELECT id FROM sessions WHERE id LIKE 's-dup%' ORDER BY id",
    )
    expect(dupSessions.length).toBe(2)

    // Verify timers materialized timezone & next_fire_at (and expired one-off disabled)
    const rt1 = db.get<{
      timezone: string | null
      next_fire_at: string | null
      enabled: number
      session_id: string | null
    }>(
      "SELECT timezone, next_fire_at, enabled, session_id FROM timers WHERE id = 'rt-1'",
    )
    expect(rt1?.timezone).toBe('Asia/Shanghai')
    expect(rt1?.next_fire_at).toBeTruthy()
    expect(rt1?.enabled).toBe(1)
    expect(rt1?.session_id).toBe('lark-oc_team1')

    const rtPast = db.get<{ next_fire_at: string | null; enabled: number }>(
      "SELECT next_fire_at, enabled FROM timers WHERE id = 'rt-past'",
    )
    expect(rtPast).toEqual({ next_fire_at: null, enabled: 0 })

    // Verify inbound + outbound blobs
    const blobs = db.all<{
      session_id: string | null
      direction: string
      storage_path: string
      filename: string
    }>(
      'SELECT session_id, direction, storage_path, filename FROM blobs ORDER BY filename',
    )
    expect(blobs).toHaveLength(2)
    expect(blobs[0]?.direction).toBe('outbound')
    expect(blobs[0]?.session_id).toBe('s-v2')
    expect(blobs[1]?.direction).toBe('inbound')
    expect(blobs[1]?.session_id).toBe('local-only-session')

    // Re-running is idempotent no-op
    const res2 = migrateLegacyVelaDir({ agentDir, db })
    expect(res2.skipped).toBe(true)
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM sessions')?.n).toBe(
      res1.summary.sessions,
    )

    const afterSnap = snapshotFiles(trackedFiles)
    for (const file of trackedFiles) {
      expect(afterSnap.get(file)).toEqual(beforeSnap.get(file))
    }
  } finally {
    db.close()
  }
})

test('clamps sibling-branch compaction firstKeptEntryId and breaks cyclic parent references cleanly', () => {
  const root = tempDir('vela-s1c-tree-guards-')
  dirs.push(root)
  const agentDir = join(root.path, 'agent')
  const sessionsDir = join(agentDir, 'sessions', 's-guard')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(join(agentDir, 'config.json'), '{}')

  const transcript = [
    JSON.stringify({
      type: 'session',
      version: 2,
      id: 's-guard',
      timestamp: '2026-11-24T00:00:00Z',
    }),
    JSON.stringify({
      type: 'message',
      id: 'root',
      parentId: null,
      timestamp: '2026-11-24T00:00:01Z',
      message: { role: 'user', content: 'root' },
    }),
    JSON.stringify({
      type: 'message',
      id: 'sib',
      parentId: 'root',
      timestamp: '2026-11-24T00:00:02Z',
      message: { role: 'assistant', content: 'sibling' },
    }),
    JSON.stringify({
      type: 'compaction',
      id: 'cmp_bad',
      parentId: 'root',
      timestamp: '2026-11-24T00:00:03Z',
      summary: 'sum',
      firstKeptEntryId: 'sib',
      tokensBefore: 100,
    }),
    JSON.stringify({
      type: 'message',
      id: 'cyc_a',
      parentId: 'cyc_b',
      timestamp: '2026-11-24T00:00:04Z',
      message: { role: 'user', content: 'a' },
    }),
    JSON.stringify({
      type: 'message',
      id: 'cyc_b',
      parentId: 'cyc_a',
      timestamp: '2026-11-24T00:00:05Z',
      message: { role: 'assistant', content: 'b' },
    }),
  ].join('\n')

  writeFileSync(join(sessionsDir, 'transcript.jsonl'), transcript)
  const db = openDatabase({ path: join(agentDir, 'vela.db') })
  try {
    const res = migrateLegacyVelaDir({ agentDir, db })
    expect(
      res.warnings.some((w) => w.includes('out-of-branch compaction')),
    ).toBe(true)
    expect(res.warnings.some((w) => w.includes('cyclic parent'))).toBe(true)
    const cmp = db.get<{ first_kept_id: string | null }>(
      "SELECT first_kept_id FROM vela_messages WHERE session_id = 's-guard' AND id = 'cmp_bad'",
    )
    expect(cmp?.first_kept_id).toBe('cmp_bad')
  } finally {
    db.close()
  }
})

test('failed migration rolls back DB, newly created config.json, and copied blobs, and redacts JSON parse secrets', () => {
  const root = tempDir('vela-s1c-rollback-')
  dirs.push(root)
  const agentDir = join(root.path, 'agent')
  const projectDataDir = join(agentDir, 'projects', '--proj--1')
  mkdirSync(join(projectDataDir, 'local', 'p1', 's1'), { recursive: true })
  mkdirSync(join(projectDataDir, 'channels'), { recursive: true })

  // Start without config.json so migration creates it and must roll it back on DB failure
  writeFileSync(
    join(agentDir, 'settings.json'),
    '{"defaultModel":"openai/gpt-5.5"}',
  )
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
    expect(existsSync(join(agentDir, 'config.json'))).toBe(false)
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM projects')?.n).toBe(
      0,
    )
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM blobs')?.n).toBe(0)
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
