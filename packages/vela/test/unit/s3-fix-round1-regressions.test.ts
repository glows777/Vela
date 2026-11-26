import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SCHEMA_VERSION } from '../../src/db/schema.ts'
import { openDatabase } from '../../src/db/sqlite.ts'
import { createRuntimeSessionToolRegistry } from '../../src/driver/runtime-tools.ts'
import { SessionStore } from '../../src/driver/session/index.ts'
import { ToolRegistry } from '../../src/driver/tools/registry.ts'
import { TokenTracker } from '../../src/driver/usage/tracker.ts'
import { VelaDriver } from '../../src/driver/vela-driver.ts'
import { loadMcpServers } from '../../src/mcp/config.ts'
import { McpConnection } from '../../src/mcp/connection.ts'
import { McpPool } from '../../src/mcp/pool.ts'
import { createRuntimeMcpAdapter } from '../../src/mcp/runtime-adapter.ts'
import { ingestChannelMessageInRuntime } from '../../src/runtime/channel-ingress.ts'
import { createEnvironmentRegistryForTest } from '../../src/runtime/environments.ts'
import {
  type ChannelAdapter,
  type ChannelInboundMessage,
  type DriverTurnRequest,
  VelaRuntimeEngine,
} from '../../src/runtime/index.ts'
import {
  enqueueOutboxInTx,
  OutboxDispatcher,
} from '../../src/runtime/outbox.ts'
import { silentLogger } from '../../src/shared/logger.ts'
import { createFauxModel, fauxText } from '../../src/testing/core/index.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

test('P1-1 & P1-6: group channel ingress creates/links hub session without touching work session and dedupes legacy keys', async () => {
  const dir = tempDir('vela-r1-p1-1-')
  const db = openDatabase({ path: join(dir, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: dir })

  const project = runtime.projects.create({
    id: 'proj-1',
    name: 'Proj 1',
    cwd: dir,
  })
  const work = runtime.sessions.create({
    id: 'work-private',
    projectId: project.id,
    kind: 'work',
    location: { environment: 'local', cwd: dir },
  })
  runtime.bindings.upsert({
    channel: 'feishu',
    externalId: 'chat-group-1',
    kind: 'group',
    projectId: project.id,
    sessionId: null,
    enabled: true,
  })

  const woken: string[] = []
  const adapter: ChannelAdapter = {
    name: 'feishu',
    start: async () => {},
    stop: async () => {},
    deliver: async () => ({}),
  }
  const baseMsg: ChannelInboundMessage = {
    channel: 'feishu',
    dedupeKey: 'msg-1',
    externalChatId: 'chat-group-1',
    kind: 'group',
    senderId: 'u1',
    senderName: 'Alice',
    text: 'hello group',
    timestamp: new Date().toISOString(),
  }

  await ingestChannelMessageInRuntime({
    db,
    blobs: runtime.blobs,
    projects: runtime.projects,
    sessions: runtime.sessions,
    bindings: runtime.bindings,
    adapter,
    msg: baseMsg,
    executeShortcut: async () => ({ text: '' }),
    scheduleSession: (sid) => woken.push(sid),
  })

  const updatedProject = runtime.projects.get(project.id)
  expect(updatedProject?.hubSessionId).toBeTruthy()
  const hubId = updatedProject!.hubSessionId!
  expect(hubId).not.toBe(work.id)
  expect(runtime.sessions.get(hubId)?.kind).toBe('hub')
  expect(woken).toEqual([hubId])

  // P1-6: pre-existing unprefixed channel dedupe_key prevents duplicate enqueue for the same channel
  db.run(
    `INSERT INTO inbox_events (id, session_id, project_id, source, dedupe_key, wake, passive, status, payload_json, created_at)
     VALUES (?, ?, ?, 'channel', ?, 1, 0, 'pending', ?, ?)`,
    'legacy-inbox-1',
    hubId,
    project.id,
    'legacy-key-1',
    JSON.stringify({ channel: 'feishu', text: 'legacy' }),
    new Date().toISOString(),
  )
  await ingestChannelMessageInRuntime({
    db,
    blobs: runtime.blobs,
    projects: runtime.projects,
    sessions: runtime.sessions,
    bindings: runtime.bindings,
    adapter,
    msg: { ...baseMsg, dedupeKey: 'legacy-key-1', text: 'retried legacy' },
    executeShortcut: async () => ({ text: '' }),
    scheduleSession: (sid) => woken.push(sid),
  })
  const sameChannelCount = db.get<{ c: number }>(
    `SELECT count(*) AS c FROM inbox_events WHERE session_id = ?`,
    hubId,
  )!.c
  expect(sameChannelCount).toBe(2)

  // Different channel with the same raw dedupeKey is NOT conflated
  const slackAdapter: ChannelAdapter = { ...adapter, name: 'slack' }
  runtime.bindings.upsert({
    channel: 'slack',
    externalId: 'slack-group-1',
    kind: 'group',
    projectId: project.id,
    sessionId: null,
    enabled: true,
  })
  await ingestChannelMessageInRuntime({
    db,
    blobs: runtime.blobs,
    projects: runtime.projects,
    sessions: runtime.sessions,
    bindings: runtime.bindings,
    adapter: slackAdapter,
    msg: {
      ...baseMsg,
      channel: 'slack',
      externalChatId: 'slack-group-1',
      dedupeKey: 'legacy-key-1',
      text: 'from slack',
    },
    executeShortcut: async () => ({ text: '' }),
    scheduleSession: (sid) => woken.push(sid),
  })
  const afterSlackCount = db.get<{ c: number }>(
    `SELECT count(*) AS c FROM inbox_events WHERE session_id = ?`,
    hubId,
  )!.c
  expect(afterSlackCount).toBe(3)

  await runtime.dispose()
  db.close()
})

test('P1-2: SessionStore.appendCompaction discards stale compaction after concurrent branch reset', () => {
  const dir = tempDir('vela-r1-p1-2-')
  const db = openDatabase({ path: join(dir, 'vela.db') })
  const store = new SessionStore('sess-compact', db, {
    cwd: dir,
    location: { environment: 'local', cwd: dir },
  })
  const userEntry = store.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
  })
  store.flush()
  const originalLeaf = db.get<{ leaf_message_id: string | null }>(
    'SELECT leaf_message_id FROM sessions WHERE id = ?',
    'sess-compact',
  )?.leaf_message_id
  expect(originalLeaf).toBe(userEntry.id)

  // Simulate concurrent restart updating leaf_message_id in SQLite
  db.run(
    'UPDATE sessions SET leaf_message_id = NULL WHERE id = ?',
    'sess-compact',
  )
  expect(() =>
    store.appendCompaction(
      { role: 'user', content: [{ type: 'text', text: '[summary]' }] },
      'summary',
      undefined,
      100,
    ),
  ).toThrow(/Discarded stale compaction/)

  const afterLeaf = db.get<{ leaf_message_id: string | null }>(
    'SELECT leaf_message_id FROM sessions WHERE id = ?',
    'sess-compact',
  )?.leaf_message_id
  expect(afterLeaf).toBeNull()
  db.close()
})

test('P1-3: openDatabase repairs legacy v1 inbox_events FK and duplicate subscriptions while keeping SCHEMA_VERSION = 1', () => {
  const dir = tempDir('vela-r1-p1-3-')
  const dbPath = join(dir, 'vela.db')

  // Seed a current DB, then replace inbox_events & subscriptions with pre-S3-fix schemas
  const initDb = openDatabase({ path: dbPath })
  initDb.close()

  const raw = new Database(dbPath)
  raw.exec('PRAGMA foreign_keys = OFF')
  raw.exec(`
    DROP TABLE inbox_events;
    CREATE TABLE inbox_events (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id),
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
    DROP INDEX IF EXISTS idx_subscriptions_unique;
    INSERT INTO projects (id, name, cwd, created_at, updated_at)
      VALUES ('p1', 'P1', '${dir.replaceAll("'", "''")}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO sessions (id, project_id, kind, state, location_json, driver, created_at, updated_at)
      VALUES ('s1', 'p1', 'work', 'idle', '{"environment":"local","cwd":"."}', 'vela', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO inbox_events (id, session_id, project_id, source, payload_json, created_at)
      VALUES ('in1', 's1', 'p1', 'user', '{"text":"hi"}', '2026-01-01T00:00:00Z');
    INSERT INTO subscriptions (id, source, event_key, project_id, session_id, created_at)
      VALUES
        ('sub-1', 'webhook', 'ci.fail', 'p1', 's1', '2026-01-01T00:00:00Z'),
        ('sub-2', 'webhook', 'ci.fail', 'p1', 's1', '2026-01-02T00:00:00Z');
  `)
  raw.close()

  const repaired = openDatabase({ path: dbPath })
  expect(
    repaired.get<{ version: number }>(
      'SELECT max(version) AS version FROM schema_migrations',
    )?.version,
  ).toBe(SCHEMA_VERSION)

  const subs = repaired.all<{ id: string }>('SELECT id FROM subscriptions')
  expect(subs.map((s) => s.id)).toEqual(['sub-1'])

  const uniqueIdx = repaired.get<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_subscriptions_unique'`,
  )
  expect(uniqueIdx?.name).toBe('idx_subscriptions_unique')

  // Deleting project succeeds and sets inbox_events.project_id = NULL without failing FK
  repaired.run('DELETE FROM projects WHERE id = ?', 'p1')
  expect(
    repaired.get<{ project_id: string | null }>(
      'SELECT project_id FROM inbox_events WHERE id = ?',
      'in1',
    )?.project_id,
  ).toBeNull()
  repaired.close()
})

test('P1-4: rolled-back TX1 inside onTerminalCommitInTx marks run failed instead of completed', async () => {
  const dir = tempDir('vela-r1-p1-4-')
  const db = openDatabase({ path: join(dir, 'vela.db') })
  const store = new SessionStore('s-tx-fail', db, {
    cwd: dir,
    location: { environment: 'local', cwd: dir },
  })
  const registry = new ToolRegistry(dir)
  const tracker = new TokenTracker(() => {})
  const driver = new VelaDriver({
    sessionId: 's-tx-fail',
    db,
    store,
    registry,
    tracker,
  })
  const model = createFauxModel({ responses: [fauxText('final reply')] })
  const claim = driver.claim({ model, trigger: 'user' })
  const userMsg = {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'hello' }],
  }

  await expect(
    driver.run({
      model,
      systemPrompt: 'sys',
      messages: [userMsg],
      newMessages: [userMsg],
      claim,
      onTerminalCommitInTx: () => {
        throw new Error('simulated tx1 failure')
      },
    }),
  ).rejects.toThrow(/simulated tx1 failure/)

  const runRow = db.get<{ status: string }>(
    'SELECT status FROM runs WHERE id = ?',
    claim.runId,
  )
  expect(runRow?.status).toBe('failed')
  const assistantCount = db.get<{ c: number }>(
    `SELECT count(*) AS c FROM vela_messages WHERE session_id = ? AND role = 'assistant'`,
    's-tx-fail',
  )!.c
  expect(assistantCount).toBe(0)
  db.close()
})

test('P1-5: prompt submitted during stopSession wakes after fence lifts, and overlapping restartSession keeps fence until reset completes', async () => {
  const dir = tempDir('vela-r1-p1-5-')
  const db = openDatabase({ path: join(dir, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: dir })

  let turn1Started!: () => void
  const turn1StartedPromise = new Promise<void>((r) => {
    turn1Started = r
  })
  let abortRelease!: () => void
  const abortGate = new Promise<void>((r) => {
    abortRelease = r
  })
  const runs: string[] = []
  let turn1Finish!: () => void
  const turn1Blocked = new Promise<void>((r) => {
    turn1Finish = r
  })

  runtime.registerDriver({
    name: 'vela',
    capabilities: {
      recovery: 'step',
      executionEnv: 'self',
      steer: false,
      approval: false,
    },
    async runTurn(req: DriverTurnRequest) {
      const text = req.inputs.map((i) => JSON.stringify(i.payload)).join(',')
      runs.push(text)
      if (runs.length === 1) {
        turn1Started()
        req.abortSignal.addEventListener('abort', () => turn1Finish(), {
          once: true,
        })
        await turn1Blocked
        return { status: 'stopped' }
      }
      return { status: 'completed', replyText: 'ok-after-stop' }
    },
    async abort() {
      await abortGate
    },
  })

  const s = runtime.sessions.create({
    id: 's-stop-wake',
    kind: 'chat',
    location: { environment: 'local', cwd: dir },
  })
  runtime.submitPrompt({ sessionId: s.id, text: 'turn-1' })
  await turn1StartedPromise

  const stopPromise = runtime.stopSession(s.id, 'user stop')
  await Promise.resolve()
  // Submitted while stopSession holds the stop fence
  runtime.submitPrompt({ sessionId: s.id, text: 'turn-2-queued' })
  expect(runs).toHaveLength(1)

  // Overlapping restartSession also acquires a refcounted stop fence
  const restartPromise = runtime.restartSession(s.id)
  abortRelease()
  expect(await stopPromise).toBe(true)
  await restartPromise
  await runtime.waitForIdle(s.id)
  // Both turn-1 and post-restart work were drained/handled without wedging
  expect(runtime.sessions.get(s.id)?.state).toBe('idle')

  // Single stopSession wake case: new prompt submitted during stopSession runs automatically on completion
  let gate2!: () => void
  const gate2Promise = new Promise<void>((r) => {
    gate2 = r
  })
  let started3!: () => void
  const started3Promise = new Promise<void>((r) => {
    started3 = r
  })
  const seenPrompts: string[] = []
  let abortedFirst = false
  let waitAbort!: () => void
  const abortBlocked = new Promise<void>((r) => {
    waitAbort = r
  })
  const runtime2 = new VelaRuntimeEngine({
    db: openDatabase({ path: join(dir, 'vela2.db') }),
    agentDir: dir,
  })
  runtime2.registerDriver({
    name: 'vela',
    capabilities: {
      recovery: 'step',
      executionEnv: 'self',
      steer: false,
      approval: false,
    },
    async runTurn(req: DriverTurnRequest) {
      const txt = req.inputs.map((i) => String(i.payload.text ?? '')).join('|')
      seenPrompts.push(txt)
      if (!abortedFirst) {
        abortedFirst = true
        started3()
        req.abortSignal.addEventListener('abort', () => gate2(), { once: true })
        await gate2Promise
        return { status: 'stopped' }
      }
      return { status: 'completed', replyText: 'ran-turn-2' }
    },
    async abort() {
      await abortBlocked
    },
  })
  const s2 = runtime2.sessions.create({
    id: 's2-wake',
    kind: 'chat',
    location: { environment: 'local', cwd: dir },
  })
  runtime2.submitPrompt({ sessionId: s2.id, text: 'first' })
  await started3Promise
  const stop2 = runtime2.stopSession(s2.id, 'stop')
  await Promise.resolve()
  runtime2.submitPrompt({ sessionId: s2.id, text: 'queued-during-stop' })
  expect(seenPrompts).toEqual(['first'])
  waitAbort()
  await stop2
  await runtime2.waitForIdle(s2.id)
  expect(seenPrompts).toEqual(['first', 'queued-during-stop'])

  await runtime.dispose()
  await runtime2.dispose()
  db.close()
})

test('P1-7 & P1-8: outbox nextPendingWakeAt skips followers behind backoff head, and unregisterChannel stops adapter before drain', async () => {
  const dir = tempDir('vela-r1-p1-7-8-')
  const db = openDatabase({ path: join(dir, 'vela.db') })
  const s1 = 's-out-1'
  const s2 = 's-out-2'
  for (const sid of [s1, s2]) {
    db.run(
      `INSERT INTO sessions (id, kind, state, location_json, driver, created_at, updated_at)
       VALUES (?, 'chat', 'idle', ?, 'vela', ?, ?)`,
      sid,
      JSON.stringify({ environment: 'local', cwd: dir }),
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00Z',
    )
  }

  const head = enqueueOutboxInTx(db, {
    sessionId: s1,
    channel: 'feishu',
    externalChatId: 'c1',
    text: 'head',
  })
  const follower = enqueueOutboxInTx(db, {
    sessionId: s1,
    channel: 'feishu',
    externalChatId: 'c1',
    text: 'follower',
  })
  const retryAt = '2099-01-01T00:00:10.000Z'
  db.run(
    'UPDATE outbox SET next_retry_at = ?, created_at = ? WHERE id = ?',
    retryAt,
    '2026-01-01T00:00:01.000Z',
    head.id,
  )
  db.run(
    'UPDATE outbox SET created_at = ? WHERE id = ?',
    '2026-01-01T00:00:02.000Z',
    follower.id,
  )

  const dispatcher = new OutboxDispatcher(db, () => undefined)
  // Follower in s1:feishu must NOT surface ahead of backing-off head
  expect(dispatcher.nextPendingWakeAt(['feishu'])).toBe(retryAt)

  // Separate session queue s2:feishu with ready head surfaces its own created_at
  const other = enqueueOutboxInTx(db, {
    sessionId: s2,
    channel: 'feishu',
    externalChatId: 'c2',
    text: 'other',
  })
  db.run(
    'UPDATE outbox SET created_at = ? WHERE id = ?',
    '2026-01-01T00:00:05.000Z',
    other.id,
  )
  expect(dispatcher.nextPendingWakeAt(['feishu'])).toBe(
    '2026-01-01T00:00:05.000Z',
  )

  // P1-8: unregisterChannel stops adapter before awaiting outbox drain
  const runtime = new VelaRuntimeEngine({ db, agentDir: dir })
  let deliveryStarted!: () => void
  const deliveryStartedPromise = new Promise<void>((r) => {
    deliveryStarted = r
  })
  let stopCalled!: () => void
  const stopCalledPromise = new Promise<void>((r) => {
    stopCalled = r
  })
  const eventsOrder: string[] = []
  const slowAdapter: ChannelAdapter = {
    name: 'slow-ch',
    start: async () => {},
    stop: async () => {
      eventsOrder.push('stop')
      stopCalled()
    },
    deliver: async () => {
      eventsOrder.push('deliver-start')
      deliveryStarted()
      await stopCalledPromise
      eventsOrder.push('deliver-end')
      return {}
    },
  }
  await runtime.registerChannel(slowAdapter)
  enqueueOutboxInTx(db, {
    sessionId: s2,
    channel: 'slow-ch',
    externalChatId: 'c3',
    text: 'unblock me on stop',
  })
  const drainPromise = runtime.outbox.drain()
  await deliveryStartedPromise
  await runtime.unregisterChannel('slow-ch')
  await drainPromise
  expect(eventsOrder).toEqual(['deliver-start', 'stop', 'deliver-end'])

  await runtime.dispose()
  db.close()
})

test('P1-9, P1-10, P2-1: MCP adapter releases lease on abort, skips symlinked owner config, and ignores stale connect metadata', async () => {
  const dir = tempDir('vela-r1-mcp-')
  const ownerDir = join(dir, 'owner')
  const linkDir = join(dir, 'project-link')
  mkdirSync(ownerDir, { recursive: true })
  writeFileSync(
    join(ownerDir, 'config.json'),
    JSON.stringify({
      mcpServers: {
        secret: { type: 'http', url: 'https://example.com/mcp' },
      },
    }),
  )
  symlinkSync(ownerDir, linkDir)

  // P1-10: ephemeral runtime whose projectDir is a symlink to agentDir must still skip user config
  const loaded = loadMcpServers({
    agentDir: ownerDir,
    projectDir: linkDir,
    trusted: true,
    env: {},
    skipUserConfig: true,
  })
  expect(loaded.servers).toEqual({})

  // P1-9: aborted direct attach releases lease so McpPool does not leak connections
  const pool = new McpPool()
  const ac = new AbortController()
  let closedCount = 0
  const adapter = createRuntimeMcpAdapter({
    pool,
    skipUserConfig: true,
    createTransport: async () => {
      const server = new McpServer(
        { name: 'hang', version: '1.0' },
        { capabilities: { tools: {} } },
      )
      server.registerTool(
        'slow_tool',
        { description: 'slow', inputSchema: {} },
        async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      )
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      const origClose = clientSide.close.bind(clientSide)
      clientSide.close = async () => {
        closedCount++
        await origClose()
      }
      await server.connect(serverSide)
      ac.abort(new DOMException('aborted attach', 'AbortError'))
      return clientSide
    },
  })
  const projDir = join(dir, 'proj')
  mkdirSync(join(projDir, '.vela'), { recursive: true })
  writeFileSync(
    join(projDir, '.vela', 'config.json'),
    JSON.stringify({
      mcpServers: {
        hangsrv: {
          type: 'http',
          url: 'https://example.com/mcp',
          exposure: 'direct',
        },
      },
    }),
  )
  await expect(
    adapter.attach({
      registry: new ToolRegistry(dir),
      agentDir: ownerDir,
      cwd: projDir,
      environment: 'local',
      trusted: true,
      waitMs: 5000,
      signal: ac.signal,
    }),
  ).rejects.toThrow()
  await pool.dispose()
  expect(closedCount).toBeGreaterThanOrEqual(1)

  // P2-1: obsolete connect attempt never overwrites instructions/tools after reconnect()
  let transportCall = 0
  let releaseFirstTransport!: () => void
  const firstTransportGate = new Promise<void>((r) => {
    releaseFirstTransport = r
  })
  const conn = new McpConnection({
    entry: {
      name: 'ver-srv',
      config: { type: 'http', url: 'https://example.com/mcp' },
      source: 'test',
    },
    cwd: dir,
    onTools: () => {},
    createTransport: async () => {
      transportCall++
      const callIdx = transportCall
      if (callIdx === 1) {
        await firstTransportGate
      }
      const srv = new McpServer(
        { name: `srv-${callIdx}`, version: '1.0' },
        {
          capabilities: { tools: {} },
          instructions:
            callIdx === 1 ? 'stale instructions' : 'fresh instructions',
        },
      )
      srv.registerTool(
        callIdx === 1 ? 'stale_tool' : 'fresh_tool',
        { description: 't', inputSchema: {} },
        async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      )
      const [cSide, sSide] = InMemoryTransport.createLinkedPair()
      await srv.connect(sSide)
      return cSide
    },
  })

  const firstAttempt = conn.connect().catch((e) => e as Error)
  await Promise.resolve()
  await conn.reconnect()
  releaseFirstTransport()
  await firstAttempt
  expect(conn.instructions).toBe('fresh instructions')
  expect(conn.tools.map((t) => t.name)).toEqual(['fresh_tool'])
  await conn.close()
})

test('P2-2, P2-3, P2-4: warm docker rejects relative/NUL cwd, routine re-enable enforces 20-cap, C5 new arm tools exist in runtime registry', async () => {
  const dir = tempDir('vela-r1-p2-')
  const envReg = createEnvironmentRegistryForTest({
    dataDir: dir,
    environments: { dev: { image: 'node:22-bookworm', network: 'off' } },
    openDocker: async (_cfg, cwd = '/workspace') =>
      ({
        os: 'linux',
        cwd,
        cleanup: async () => {},
      }) as never,
    probeAlive: async () => true,
  })
  // Warm cache first
  await expect(
    envReg.resolve({
      sessionId: 's-env',
      location: { environment: 'dev', cwd: '/workspace' },
    }),
  ).resolves.toBeDefined()
  await expect(
    envReg.resolve({
      sessionId: 's-env',
      location: { environment: 'dev', cwd: 'relative/path' },
    }),
  ).rejects.toThrow(/absolute/i)
  await expect(
    envReg.resolve({
      sessionId: 's-env',
      location: { environment: 'dev', cwd: '/workspace\0bad' },
    }),
  ).rejects.toThrow(/absolute|Docker/i)
  await envReg.dispose()

  // P2-3: re-enabling a disabled routine enforces the 20-routine cap
  const db = openDatabase({ path: join(dir, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: dir })
  const project = runtime.projects.create({
    id: 'p-cap',
    name: 'Cap',
    cwd: dir,
  })
  const createdIds: string[] = []
  for (let i = 0; i < 20; i++) {
    createdIds.push(
      runtime.timers.createRoutine({
        projectId: project.id,
        message: `r-${i}`,
        schedule: { time: '09:00' },
      }).id,
    )
  }
  runtime.timers.update(createdIds[0]!, { enabled: false })
  runtime.timers.createRoutine({
    projectId: project.id,
    message: 'r-20',
    schedule: { time: '09:00' },
  })
  expect(() =>
    runtime.timers.update(createdIds[0]!, { enabled: true }),
  ).toThrow(/20/)

  // P2-4: C5 eval selects tool names from the loaded revision instead of hardcoding arm
  const evalWorker = readFileSync(
    join(import.meta.dir, '../../../../scripts/eval/worker.ts'),
    'utf8',
  )
  expect(evalWorker).toContain(
    "paths.usesPiCoreToolNames\n              ? ['read', 'write', 'ls']\n              : ['read_file', 'write_file', 'list_directory']",
  )
  const defaultReg = createRuntimeSessionToolRegistry({
    spillDir: dir,
    cwd: dir,
    logger: silentLogger,
    memoryGlobal: runtime.blobs as never,
    memoryLocal: () => runtime.blobs as never,
  })
  for (const t of ['read', 'write', 'ls']) {
    expect(defaultReg.get(t)).toBeDefined()
  }
  for (const legacy of ['read_file', 'write_file', 'list_directory']) {
    expect(defaultReg.get(legacy)).toBeUndefined()
  }

  await runtime.dispose()
  db.close()
})
