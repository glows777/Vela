import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { openDatabase } from '../../src/db/sqlite.ts'
import { createMemoryTool } from '../../src/driver/extensions/memory/tool.ts'
import { MemoryDream } from '../../src/driver/memory/dream.ts'
import { createVelaAgentDriver } from '../../src/driver/runtime-adapter.ts'
import { ToolExecutionResult } from '../../src/driver/tools/types.ts'
import {
  type AgentDriver,
  type AgentDriverCapabilities,
  type ApprovalStatus,
  createRuntime,
  type DriverInboxItem,
  type DriverTerminalOutcome,
  type DriverTurnRequest,
  type DriverTurnResult,
  EnvironmentRegistry,
  type EnvironmentRegistryOptions,
  type RunTrigger,
  type SessionKind,
  type SessionState,
} from '../../src/index.ts'
import { parseServers } from '../../src/mcp/config.ts'
import { McpPool } from '../../src/mcp/pool.ts'
import {
  createApprovalRequest,
  resolveRuntimeApproval,
} from '../../src/runtime/approvals.ts'
import {
  readProjectSessionMessages,
  sendSessionFile,
  startProjectSession,
} from '../../src/runtime/control-ops.ts'
import {
  createDockerRunner,
  type DockerContainerEnv,
  dockerContainerId,
} from '../../src/runtime/docker/container.ts'
import { withDockerCwd } from '../../src/runtime/docker/operations.ts'
import { createEnvironmentRegistryForTest } from '../../src/runtime/environments.ts'
import { RuntimeEventBus } from '../../src/runtime/event-bus.ts'
import {
  type ChannelAdapter,
  VelaRuntimeEngine,
} from '../../src/runtime/index.ts'
import { MemoryRegistry, MemoryStore } from '../../src/runtime/memory/index.ts'
import { SubscriptionManager } from '../../src/runtime/subscriptions.ts'
import { TimerScheduler } from '../../src/runtime/timers.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../src/testing/core/index.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

test('4A: public exports cover full Runtime/Driver contract including waitForBackground', async () => {
  const caps: AgentDriverCapabilities = {
    recovery: 'step',
    executionEnv: 'self',
    steer: true,
    approval: true,
  }
  const approvalStatus: ApprovalStatus = 'approved'
  const sessionKind: SessionKind = 'work'
  const sessionState: SessionState = 'idle'
  const trigger: RunTrigger = 'channel'
  const item: DriverInboxItem = {
    id: 'in-1',
    source: trigger,
    wake: true,
    passive: false,
    payload: {},
    createdAt: new Date().toISOString(),
  }
  const outcome: DriverTerminalOutcome = {
    status: 'completed',
    replyText: 'ok',
    silent: false,
  }
  const res: DriverTurnResult = { status: 'completed', replyText: 'ok' }
  let waited = false
  const driver: AgentDriver = {
    name: 'mock',
    capabilities: caps,
    async runTurn(_req: DriverTurnRequest) {
      return res
    },
    async waitForBackground() {
      waited = true
    },
  }
  const envOpts: EnvironmentRegistryOptions = {
    dataDir: tempRoot('vela-4a-env-'),
  }
  const envRegistry = new EnvironmentRegistry(envOpts)
  expect(approvalStatus).toBe('approved')
  expect(sessionKind).toBe('work')
  expect(sessionState).toBe('idle')
  expect(item.source).toBe('channel')
  expect(outcome.status).toBe('completed')
  expect(envRegistry.dataDir).toBe(envOpts.dataDir)

  const engine = new VelaRuntimeEngine({
    db: openDatabase({ path: ':memory:' }),
    agentDir: envOpts.dataDir,
    drivers: [driver],
  })
  await engine.waitForIdle()
  expect(waited).toBe(true)
  await engine.dispose()
})

test('3A: createRuntime loads owner config.json when non-ephemeral and isolates when ephemeral: true', async () => {
  const root = tempRoot('vela-3a-config-')
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      model: 'custom-owner/owner-model',
      thinkingLevel: 'low',
      providers: {
        'custom-owner': {
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'secret-token',
          models: [{ id: 'owner-model' }],
        },
      },
      memory: { dream: false },
    }),
  )
  writeFileSync(
    join(agentDir, 'auth.json'),
    JSON.stringify({ 'custom-owner': { type: 'api_key', key: 'auth-token' } }),
  )

  const persistent = createRuntime({ agentDir })
  try {
    expect(
      (await persistent.models({ all: true })).some(
        (m) => m.id === 'owner-model',
      ),
    ).toBe(true)
  } finally {
    await persistent.dispose()
  }

  const isolated = createRuntime({ agentDir, ephemeral: true })
  try {
    expect(
      (await isolated.models({ all: true })).some(
        (m) => m.id === 'owner-model',
      ),
    ).toBe(false)
    expect(
      (await isolated.models()).some((m) => m.provider === 'custom-owner'),
    ).toBe(false)
  } finally {
    await isolated.dispose()
  }
})

test('2A & memory fixes: Dream skips aborted shutdown backoff, advances cursor on deleted sessions, quotes YAML scalars, includes filenames, and isolates global MemoryRegistry keys', async () => {
  const root = tempRoot('vela-2a-mem-')
  const db = openDatabase({ path: join(root, 'vela.db') })
  const storeA = new MemoryStore(
    join(root, 'global-mem'),
    undefined,
    join(root, 'proj-a'),
  )
  const saved = storeA.save({
    name: 'yaml-edge',
    description: '- hyphen and ? query scalar',
    type: 'project',
    content: 'Body text',
  })
  expect(storeA.list()).toHaveLength(1)
  expect(readFileSync(join(storeA.memoryDir, saved), 'utf8')).toContain(
    'description: "- hyphen and ? query scalar"',
  )

  const tool = createMemoryTool(storeA)
  const listed = await tool.execute({ action: 'list' })
  expect(String(listed)).toContain('(file: project_yaml-edge.md)')
  const searched = await tool.execute({ action: 'search', query: 'Body' })
  expect(String(searched)).toContain('(file: project_yaml-edge.md)')

  const registry = new MemoryRegistry()
  expect(registry.get(join(root, 'global-mem'), join(root, 'proj-a'))).not.toBe(
    registry.get(join(root, 'global-mem'), join(root, 'proj-b')),
  )

  const engine = new VelaRuntimeEngine({ db, agentDir: root })
  const s = engine.sessions.create({ id: 'ghost-sess', kind: 'chat' })
  const dream = new MemoryDream(storeA, db, { kind: 'global' })
  db.run(
    `INSERT INTO vela_messages (id, session_id, seq, kind, role, content_json, details_json, created_at)
     VALUES ('m-1', ?, 1, 'message', 'user', '[{"type":"text","text":"Remember espresso"}]', '{"dreamHumanText":"Remember espresso"}', ?)`,
    s.id,
    new Date().toISOString(),
  )
  dream.recordMessages(s.id, [{ messageId: 'm-1', time: Date.now() }])

  let releaseDreamCall!: () => void
  let markDreamCalled!: () => void
  const dreamCalled = new Promise<void>((resolve) => {
    markDreamCalled = resolve
  })
  const baseDreamModel = createFauxModel({
    responses: [fauxText('{"ops":[]}')],
  })
  const gatedModel: typeof baseDreamModel = Object.assign(
    Object.create(baseDreamModel),
    {
      async doGenerate(opts: Parameters<typeof baseDreamModel.doGenerate>[0]) {
        markDreamCalled()
        await new Promise<void>((resolve) => {
          releaseDreamCall = resolve
        })
        return baseDreamModel.doGenerate(opts)
      },
    },
  )
  const dreamTask = dream.run({
    sessionId: s.id,
    model: gatedModel,
    recordUsage: () => {},
  })
  await dreamCalled
  const stopPromise = dream.stop()
  releaseDreamCall()
  await stopPromise
  let abortedErr: unknown
  try {
    await dreamTask
  } catch (err) {
    abortedErr = err
  }
  expect(abortedErr).toBeDefined()
  expect(dream.auditState().logs).toHaveLength(0)

  // Delete session row and verify cursor advances without calling model
  engine.sessions.delete(s.id)
  const unusedModel = createFauxModel({ responses: [] })
  const deletedReport = await dream.run({
    sessionId: s.id,
    model: unusedModel,
    recordUsage: () => {},
  })
  expect(deletedReport).toContain('advanced cursor past deleted sessions')
  expect(unusedModel.calls).toHaveLength(0)

  await engine.dispose()
  db.close()
})

test('DB & runtime regressions: FKs, subscriptions, approvals, channel ingress, timers, session cleanup, control-ops, and EnvironmentRegistry sharing', async () => {
  const root = tempRoot('vela-rt-fix-')
  const db = openDatabase({ path: join(root, 'vela.db') })
  const delivered: string[] = []
  const runtime = new VelaRuntimeEngine({ db, agentDir: root })
  runtime.registerDriver(
    createVelaAgentDriver({
      db,
      agentDir: root,
      blobs: runtime.blobs,
      environments: runtime.environments,
      defaultModel: createFauxModel({
        responses: [
          fauxText('first'),
          fauxText('second'),
          fauxText('third'),
          fauxText('fourth'),
          fauxText('after stop'),
        ],
      }),
    }),
  )

  try {
    // 1. Project removal sets inbox_events.project_id NULL (FK ON DELETE SET NULL)
    const proj = runtime.projects.create({ name: 'P', cwd: root })
    const sess = runtime.sessions.create({
      id: 's-main',
      projectId: proj.id,
      kind: 'work',
      location: { environment: 'local', cwd: root },
    })
    db.run(
      `INSERT INTO inbox_events (id, session_id, project_id, source, dedupe_key, wake, passive, payload_json, status, created_at)
       VALUES ('ev-fk', NULL, ?, 'user', 'k-fk', 0, 0, '{"text":"x"}', 'done', ?)`,
      proj.id,
      new Date().toISOString(),
    )
    db.run(
      `INSERT INTO runs (id, session_id, project_id, driver, trigger, status, owner_token, started_at, updated_at)
       VALUES ('r-live-lock', ?, ?, 'vela', 'user', 'running', ?, ?, ?)`,
      sess.id,
      proj.id,
      `other-proc:${process.pid}:lock`,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    expect(() => runtime.projects.remove(proj.id)).toThrow(/actively executing/)
    db.run(`DELETE FROM runs WHERE id = 'r-live-lock'`)

    // 2. Subscriptions: unique index deduplicates & wildcard final preserved
    const subs = new SubscriptionManager(db)
    const wild = subs.create({
      sessionId: sess.id,
      source: 'github',
      eventKey: '*',
    })
    const dup = subs.create({
      sessionId: sess.id,
      source: 'github',
      eventKey: '*',
    })
    expect(dup.id).toBe(wild.id)
    expect(subs.list({ sessionId: sess.id })).toHaveLength(1)
    subs.dispatchEvent({
      source: 'github',
      eventKey: 'push:main',
      dedupeKey: 'deliv-1',
      summary: 'Pushed',
      final: true,
    })
    expect(subs.list({ sessionId: sess.id })).toHaveLength(1)
    db.run(`DELETE FROM inbox_events WHERE source = 'webhook'`)

    // 3. Approvals: wait_for_input cancelled -> run stopped without waking
    const rId = 'r-wfi'
    const now = new Date().toISOString()
    db.run(
      `INSERT INTO runs (id, session_id, project_id, driver, trigger, status, started_at, updated_at)
       VALUES (?, ?, ?, 'vela', 'user', 'waiting_human', ?, ?)`,
      rId,
      sess.id,
      proj.id,
      now,
      now,
    )
    db.run(`UPDATE sessions SET state = 'waiting_human' WHERE id = ?`, sess.id)
    const wfi = createApprovalRequest(db, new RuntimeEventBus(db), {
      sessionId: sess.id,
      projectId: proj.id,
      runId: rId,
      toolName: 'wait_for_input',
      summary: 'Need input',
      input: { question: 'ok?' },
    })
    const cancelledRes = resolveRuntimeApproval(db, new RuntimeEventBus(db), {
      approvalId: wfi.id,
      decision: 'cancelled',
      decidedBy: 'u1',
    })
    expect(cancelledRes.shouldWake).toBe(false)
    expect(
      db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', rId)
        ?.status,
    ).toBe('stopped')
    expect(runtime.sessions.get(sess.id)?.state).toBe('idle')

    // Terminal run rejects approval
    expect(() =>
      createApprovalRequest(db, new RuntimeEventBus(db), {
        sessionId: sess.id,
        projectId: proj.id,
        runId: rId,
        toolName: 'bash',
        summary: 'late',
      }),
    ).not.toThrow()
    const lateAppr = db.get<{ id: string }>(
      `SELECT id FROM approvals WHERE run_id = ? AND status = 'pending' LIMIT 1`,
      rId,
    )!
    expect(() =>
      resolveRuntimeApproval(db, new RuntimeEventBus(db), {
        approvalId: lateAppr.id,
        decision: 'approved',
      }),
    ).toThrow(/already stopped/)
    db.run('DELETE FROM approvals WHERE id = ?', lateAppr.id)

    // 4. Timers: reject days: [] and cancel followups on restart
    const timers = new TimerScheduler(db)
    expect(() =>
      timers.createRoutine({
        sessionId: sess.id,
        schedule: { days: [], time: '09:00' },
        message: 'never',
      }),
    ).toThrow(/days/i)

    // 5. Channel ingress: passive /stop is NOT treated as control shortcut & channel dedupe isolates
    let ingestA!: Parameters<ChannelAdapter['start']>[0]['ingest']
    let ingestB!: Parameters<ChannelAdapter['start']>[0]['ingest']
    runtime.bindings.upsert({
      channel: 'chan-a',
      externalId: 'chat-1',
      kind: 'direct',
      sessionId: sess.id,
      projectId: proj.id,
    })
    runtime.bindings.upsert({
      channel: 'chan-b',
      externalId: 'chat-1',
      kind: 'direct',
      sessionId: sess.id,
      projectId: proj.id,
    })
    await runtime.registerChannel({
      name: 'chan-a',
      async start(ctx) {
        ingestA = ctx.ingest
      },
      async stop() {},
      async deliver(msg: { text: string }) {
        delivered.push(msg.text)
        return {}
      },
    })
    await runtime.registerChannel({
      name: 'chan-b',
      async start(ctx) {
        ingestB = ctx.ingest
      },
      async stop() {},
      async deliver(msg: { text: string }) {
        delivered.push(msg.text)
        return {}
      },
    })
    await ingestA({
      channel: 'chan-a',
      externalChatId: 'chat-1',
      kind: 'direct',
      senderId: 'u1',
      senderName: 'User 1',
      dedupeKey: 'dup-1',
      text: '/stop',
      timestamp: now,
      passive: true,
    })
    expect(delivered).toEqual([])

    // Same dedupeKey in chan-b is distinct due to channel prefix in dedupe_key
    await ingestB({
      channel: 'chan-b',
      externalChatId: 'chat-1',
      kind: 'direct',
      senderId: 'u2',
      senderName: 'User 2',
      dedupeKey: 'dup-1',
      text: 'hello',
      timestamp: now,
      passive: true,
    })
    const dedupeRows = db.all<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM inbox_events WHERE source = 'channel' ORDER BY rowid ASC`,
    )
    expect(dedupeRows.map((r) => r.dedupe_key)).toEqual([
      'chan-a:dup-1',
      'chan-b:dup-1',
    ])

    // 6. Control-ops: MAX_HANDOFF_DEPTH, sendSessionFile dot path check, readProjectSessionMessages filtering
    const started = await startProjectSession(
      {
        db,
        blobs: runtime.blobs,
        eventBus: new RuntimeEventBus(db),
        scheduleSession: () => {},
      },
      {
        callerSessionId: sess.id,
        title: 'hop',
        brief: 'subtask',
        currentHandoffDepth: 2,
      },
    )
    expect(started.sessionId).toBeString()
    await expect(
      startProjectSession(
        {
          db,
          blobs: runtime.blobs,
          eventBus: new RuntimeEventBus(db),
          scheduleSession: () => {},
        },
        {
          callerSessionId: sess.id,
          title: 'too-deep',
          brief: 'overflow',
          currentHandoffDepth: 3,
        },
      ),
    ).rejects.toThrow(/limit reached/i)

    await expect(
      sendSessionFile(
        { db, blobs: runtime.blobs },
        {
          sessionId: sess.id,
          env: {
            id: 'node:local',
            cwd: root,
            joinPath: async (parts: string[]) => ({
              ok: true,
              value: join(...parts),
            }),
            canonicalPath: async (p: string) => ({ ok: true, value: p }),
          } as never,
          path: '.',
        },
      ),
    ).rejects.toThrow(/inside this workspace/i)

    db.run(
      `INSERT INTO vela_messages (id, session_id, parent_id, seq, kind, role, stop_reason, content_json, created_at)
       VALUES
       ('msg-ok', ?, NULL, 1, 'message', 'assistant', 'stop', '{"role":"assistant","content":[{"type":"text","text":"good reply"}]}', ?),
       ('msg-tool', ?, 'msg-ok', 2, 'message', 'assistant', 'tool_calls', '{"role":"assistant","content":[{"type":"tool_call","toolCallId":"x","toolName":"bash","input":{}}]}', ?),
       ('msg-err', ?, 'msg-tool', 3, 'message', 'assistant', 'error', '{"role":"assistant","content":[{"type":"text","text":"internal boom"}]}', ?)`,
      started.sessionId,
      now,
      started.sessionId,
      now,
      started.sessionId,
      now,
    )
    db.run(
      `UPDATE sessions SET leaf_message_id = 'msg-err' WHERE id = ?`,
      started.sessionId,
    )
    const visible = readProjectSessionMessages(db, {
      callerSessionId: sess.id,
      targetSessionId: started.sessionId,
    })
    expect(visible.messages.map((m) => m.text)).toEqual(['good reply'])

    // Removing session leaves its orphaned blobs removed from disk and cleans kv_meta
    const blobRef = await runtime.blobs.storeInbound({
      sessionId: sess.id,
      filename: 'note.txt',
      bytes: Buffer.from('hello'),
    })
    expect(existsSync(blobRef.storagePath)).toBe(true)
    db.run(
      `INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, '"1"', ?)`,
      `run_silent:${rId}`,
      now,
    )
    runtime.sessions.delete(sess.id)
    expect(existsSync(blobRef.storagePath)).toBe(false)
    expect(
      db.get('SELECT key FROM kv_meta WHERE key = ?', `run_silent:${rId}`),
    ).toBeUndefined()

    // Verify FK ON DELETE SET NULL
    runtime.sessions.delete(started.sessionId)
    runtime.projects.remove(proj.id)
    expect(
      db.get<{ project_id: string | null }>(
        `SELECT project_id FROM inbox_events WHERE id = 'ev-fk'`,
      )?.project_id,
    ).toBeNull()
  } finally {
    await runtime.dispose()
    db.close()
  }

  // 7. EnvironmentRegistry shares one Docker container across normalized cwds under same env name
  let opens = 0
  let disposedCount = 0
  const makeContainerEnv = (cwd: string): DockerContainerEnv => {
    const env = {
      id: 'docker:dev',
      cwd,
      exec: async () => ({
        ok: true,
        value: {
          exitCode: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
          truncated: false,
        },
      }),
      exists: async () => ({ ok: true, value: false }),
      readTextFile: async () => ({
        ok: false,
        error: Object.assign(Error('missing'), { code: 'not_found' as const }),
      }),
      readBinaryFile: async () => ({
        ok: false,
        error: Object.assign(Error('missing'), { code: 'not_found' as const }),
      }),
      writeFile: async () => ({ ok: true, value: undefined }),
      listDir: async () => ({ ok: true, value: [] }),
      absolutePath: async (p: string) => ({
        ok: true,
        value: posix.resolve(cwd, p),
      }),
      canonicalPath: async (p: string) => ({
        ok: true,
        value: posix.resolve(cwd, p),
      }),
      joinPath: async (parts: string[]) => ({
        ok: true,
        value: posix.join(...parts),
      }),
      cleanup: async () => {
        disposedCount++
      },
    } as unknown as DockerContainerEnv
    Object.assign(env, {
      [dockerContainerId]: 'cid-dev-1',
      [withDockerCwd]: (nextCwd: string) => makeContainerEnv(nextCwd),
    })
    return env
  }
  const envReg = createEnvironmentRegistryForTest({
    dataDir: root,
    environments: { dev: { image: 'node:22-bookworm', network: 'off' } },
    openDocker: async (_config, cwd = '/workspace') => {
      opens++
      return makeContainerEnv(cwd)
    },
    probeAlive: async () => true,
  })
  const e1 = await envReg.resolve({
    sessionId: 's1',
    location: { environment: 'dev', cwd: '/workspace/a/' },
  })
  const e2 = await envReg.resolve({
    sessionId: 's2',
    location: { environment: 'dev', cwd: '/workspace/b' },
  })
  expect(opens).toBe(1)
  expect(e1?.cwd).toBe('/workspace/a')
  expect(e2?.cwd).toBe('/workspace/b')
  await envReg.dispose()
  expect(disposedCount).toBe(1)
  expect(createDockerRunner).toBeDefined()
})

test('MCP & Driver regressions: McpPool retries failed, honors AbortSignal, and VelaAgentDriver waitForBackground awaits dream tasks', async () => {
  const dir = tempRoot('vela-mcp-drv-')
  const { entries } = parseServers({
    tool: { command: 'unused', exposure: 'direct' },
  })
  const pool = new McpPool()
  let attempts = 0
  const lease = pool.acquire({
    cwd: dir,
    entries,
    errors: [],
    createTransport: async (entry) => {
      attempts++
      if (attempts === 1) throw new Error('boom-1')
      const server = new McpServer({ name: entry.name, version: '1.0.0' })
      server.registerTool(
        'ping',
        { description: 'ping', inputSchema: {} },
        async () => ({
          content: [{ type: 'text', text: 'pong' }],
        }),
      )
      const [client, side] = InMemoryTransport.createLinkedPair()
      await server.connect(side)
      return client
    },
    onTools: () => {},
    onError: () => {},
  })
  lease.start()
  await lease.waitForAll()
  expect(attempts).toBe(1)

  // Retry failed connection on next start() and honor AbortSignal
  lease.start()
  const ac = new AbortController()
  ac.abort(new DOMException('Stopped wait', 'AbortError'))
  await expect(lease.waitForAll(ac.signal)).rejects.toThrow(/Stopped wait/)
  await lease.waitForAll()
  expect(attempts).toBe(2)
  await lease.release()
  await pool.dispose()

  // Driver approval_requested forwards input & waitForBackground waits for pending due auto-dream
  const db = openDatabase({ path: join(dir, 'vela.db') })
  let dreamStarted!: () => void
  const dreamStartedPromise = new Promise<void>((r) => {
    dreamStarted = r
  })
  let releaseDream!: () => void
  const releaseDreamPromise = new Promise<void>((r) => {
    releaseDream = r
  })
  const baseModel = createFauxModel({
    responses: [fauxToolCall('dangerous', { arg: 'v1' }), fauxText('done')],
    generate: [fauxText(JSON.stringify({ ops: [], report: 'no changes' }))],
  })
  const origDoGenerate = baseModel.doGenerate.bind(baseModel)
  const model = Object.assign(baseModel, {
    doGenerate: async (opts: Parameters<typeof baseModel.doGenerate>[0]) => {
      dreamStarted()
      await releaseDreamPromise
      return origDoGenerate(opts)
    },
  })
  const runtime = new VelaRuntimeEngine({ db, agentDir: dir })
  const events: Array<Record<string, unknown>> = []
  runtime.subscribeEvents((e) =>
    events.push(e as unknown as Record<string, unknown>),
  )
  const driver = createVelaAgentDriver({
    db,
    agentDir: dir,
    blobs: runtime.blobs,
    environments: runtime.environments,
    defaultModel: model,
    tools: [
      {
        name: 'dangerous',
        description: 'needs approval',
        inputSchema: z.object({ arg: z.string() }),
        execute: async () => new ToolExecutionResult('ran', 'ran'),
      },
    ],
    toolApprovalCheck: () => ({
      requireApproval: true,
      summary: 'Approve arg',
    }),
  })
  runtime.registerDriver(driver)
  const s = runtime.sessions.create({
    id: 's-drv',
    kind: 'chat',
    location: { environment: 'local', cwd: dir },
  })
  db.run(
    `INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?)`,
    'memory_dream:global',
    JSON.stringify({
      nextSeq: 2,
      cursorSeq: 0,
      pendingRefs: [
        {
          seq: 1,
          sessionId: s.id,
          messageId: 'stale-ref',
          time: Date.now() - 25 * 3_600_000,
        },
      ],
      logs: [],
    }),
    new Date().toISOString(),
  )
  runtime.submitPrompt({ sessionId: s.id, text: 'run dangerous' })
  await runtime.waitForIdle(s.id)
  const apprEv = events.find((e) => e.type === 'approval_requested')
  expect(apprEv?.input).toEqual({ arg: 'v1' })

  const [pending] = runtime.listPendingApprovals(s.id)
  runtime.resolveApproval({ approvalId: pending!.id, decision: 'approved' })
  await runtime.waitForIdle(s.id)
  await dreamStartedPromise
  let bgSettled = false
  const bgPromise = (driver.waitForBackground?.() ?? Promise.resolve()).then(
    () => {
      bgSettled = true
    },
  )
  await Promise.resolve()
  expect(bgSettled).toBe(false)
  releaseDream()
  await bgPromise
  expect(bgSettled).toBe(true)
  await runtime.dispose()
  db.close()
})
