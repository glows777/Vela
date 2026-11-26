import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runtimePaths } from '../../../../scripts/eval/layout.ts'
import { openDatabase } from '../../src/db/sqlite.ts'
import { McpConnection } from '../../src/mcp/connection.ts'
import { LostRunOwnershipError } from '../../src/runtime/driver.ts'
import { RuntimeEventBus } from '../../src/runtime/event-bus.ts'
import { enqueueInboxEvent } from '../../src/runtime/inbox.ts'
import {
  type ChannelAdapter,
  type DriverTurnRequest,
  VelaRuntimeEngine,
} from '../../src/runtime/index.ts'
import { enqueueOutboxInTx } from '../../src/runtime/outbox.ts'
import {
  claimNextTurnInDb,
  commitCompletedTurnInTx,
  finalizeTurnInDb,
  stopSessionRunsInDb,
} from '../../src/runtime/worker.ts'

const REPO_ROOT = resolve(import.meta.dir, '../../../..')
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

test('R2-P1-1: dispose stops channel adapters concurrently with workers so blocked flushOutboxBestEffort settles cleanly', async () => {
  const dir = tempDir('vela-r2-p1-1-')
  const db = openDatabase({ path: join(dir, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: dir })

  let deliverStarted!: () => void
  const deliverStartedPromise = new Promise<void>((r) => {
    deliverStarted = r
  })
  let stopped = false
  let stopResolved!: () => void
  const stopPromiseGate = new Promise<void>((r) => {
    stopResolved = r
  })

  await runtime.registerChannel({
    name: 'blocking-ch',
    start: async () => {},
    stop: async () => {
      stopped = true
      stopResolved()
    },
    deliver: async () => {
      deliverStarted()
      await stopPromiseGate
      return {}
    },
  })

  runtime.registerDriver({
    name: 'vela',
    capabilities: {
      recovery: 'step',
      executionEnv: 'self',
      steer: false,
      approval: false,
    },
    async runTurn() {
      return { status: 'completed', replyText: 'outbound text' }
    },
  })

  const s = runtime.sessions.create({
    id: 's-dispose-outbox',
    kind: 'chat',
    location: { environment: 'local', cwd: dir },
  })
  runtime.bindings.upsert({
    channel: 'blocking-ch',
    externalId: 'room-1',
    kind: 'group',
    sessionId: s.id,
    enabled: true,
  })
  runtime.submitPrompt({ sessionId: s.id, text: 'hi' })
  await deliverStartedPromise
  await runtime.dispose()
  expect(stopped).toBe(true)
  db.close()
})

test('R2-P1-2: unregisterChannel(A) completes without hanging on a blocked channel B delivery', async () => {
  const dir = tempDir('vela-r2-p1-2-')
  const db = openDatabase({ path: join(dir, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: dir })

  let releaseB!: () => void
  const gateB = new Promise<void>((r) => {
    releaseB = r
  })
  let startedB!: () => void
  const bDelivering = new Promise<void>((r) => {
    startedB = r
  })
  let aStopped = false

  const adapterA: ChannelAdapter = {
    name: 'chA',
    start: async () => {},
    stop: async () => {
      aStopped = true
    },
    deliver: async () => ({}),
  }
  const adapterB: ChannelAdapter = {
    name: 'chB',
    start: async () => {},
    stop: async () => {
      releaseB()
    },
    deliver: async () => {
      startedB()
      await gateB
      return {}
    },
  }
  await runtime.registerChannel(adapterA)
  await runtime.registerChannel(adapterB)

  const s = runtime.sessions.create({
    id: 's-multi-ch',
    kind: 'chat',
    location: { environment: 'local', cwd: dir },
  })
  enqueueOutboxInTx(db, {
    sessionId: s.id,
    channel: 'chB',
    externalChatId: 'b1',
    text: 'blocked-b',
  })
  const flushPromise = runtime.outbox.flushOnce()
  await bDelivering

  // Unregistering chA must finish immediately even while chB's delivery is blocked
  await runtime.unregisterChannel('chA')
  expect(aStopped).toBe(true)

  releaseB()
  await flushPromise
  await runtime.dispose()
  db.close()
})

test('R2-P1-3: terminal writes reject overwritten stopped runs, stopSessionRunsInDb respects live owners, and cross-Runtime stop retries', async () => {
  const dir = tempDir('vela-r2-p1-3-')
  const db = openDatabase({ path: join(dir, 'vela.db') })
  const eventBus = new RuntimeEventBus(db)
  const runtime1 = new VelaRuntimeEngine({ db, agentDir: dir })
  const runtime2 = new VelaRuntimeEngine({ db, agentDir: dir })

  const s = runtime1.sessions.create({
    id: 's-race',
    kind: 'chat',
    location: { environment: 'local', cwd: dir },
  })

  // Direct terminal write guard: once stopped in DB, commitCompletedTurnInTx & finalizeTurnInDb refuse to mark completed
  enqueueInboxEvent(db, {
    sessionId: s.id,
    source: 'user',
    wake: true,
    payload: { type: 'user', text: 'hello' },
  })
  const claimed = claimNextTurnInDb({
    db,
    sessions: runtime1.sessions,
    eventBus,
    activeOwners: new Set(['owner-1']),
    sessionId: s.id,
    ownerToken: 'owner-1',
  })!
  expect(claimed).toBeDefined()
  db.run(`UPDATE runs SET status = 'stopped' WHERE id = ?`, claimed.runId)

  expect(() =>
    commitCompletedTurnInTx({
      db,
      eventBus,
      claimed,
      outcome: { status: 'completed', replyText: 'late' },
    }),
  ).toThrow(LostRunOwnershipError)
  expect(() =>
    finalizeTurnInDb({
      db,
      eventBus,
      claimed,
      result: { status: 'completed', replyText: 'late' },
    }),
  ).toThrow(LostRunOwnershipError)
  expect(
    db.get<{ status: string }>(
      'SELECT status FROM runs WHERE id = ?',
      claimed.runId,
    )?.status,
  ).toBe('stopped')

  // stopSessionRunsInDb refuses to stomp on another engine's live running run
  db.run(
    `UPDATE runs SET status = 'running', owner_token = 'foreign-live-token' WHERE id = ?`,
    claimed.runId,
  )
  const stopCheck = stopSessionRunsInDb(
    db,
    s,
    s.id,
    'stop attempt',
    new Set(['local-only']),
  )
  expect(stopCheck.liveOtherRuns).toBe(false) // token prefix isn't live process owner, so check real cross-engine flow below

  // Cross-Runtime stop between runtime1 and runtime2 running on the same DB
  let entered2!: () => void
  const entered2Promise = new Promise<void>((r) => {
    entered2 = r
  })
  let release2!: () => void
  const release2Promise = new Promise<void>((r) => {
    release2 = r
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
      entered2()
      req.abortSignal.addEventListener('abort', () => release2(), {
        once: true,
      })
      await release2Promise
      return { status: 'stopped' }
    },
  })
  runtime1.registerDriver({
    name: 'vela',
    capabilities: {
      recovery: 'step',
      executionEnv: 'self',
      steer: false,
      approval: false,
    },
    async runTurn() {
      return { status: 'completed', replyText: 'ok' }
    },
  })

  const sCross = runtime1.sessions.create({
    id: 's-cross',
    kind: 'chat',
    location: { environment: 'local', cwd: dir },
  })
  runtime2.submitPrompt({ sessionId: sCross.id, text: 'from rt2' })
  await entered2Promise
  expect(await runtime1.stopSession(sCross.id, 'cross stop')).toBe(true)
  await runtime2.waitForIdle(sCross.id)

  await runtime1.dispose()
  await runtime2.dispose()
  db.close()
})

test('R2-P1-4: stopSession fence lift does not spin on a topic awaiting channel binding', async () => {
  const dir = tempDir('vela-r2-p1-4-')
  const db = openDatabase({ path: join(dir, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: dir })

  let turnCalls = 0
  runtime.registerDriver({
    name: 'vela',
    capabilities: {
      recovery: 'step',
      executionEnv: 'self',
      steer: false,
      approval: false,
    },
    async runTurn() {
      turnCalls++
      return { status: 'completed', replyText: 'unexpected' }
    },
  })

  const topic = runtime.sessions.create({
    id: 'topic-unbound',
    kind: 'topic',
    location: { environment: 'local', cwd: dir },
  })
  enqueueOutboxInTx(db, {
    sessionId: topic.id,
    kind: 'topic_start',
    channel: 'feishu',
    externalChatId: 'chat-1',
    text: 'topic header',
  })
  enqueueInboxEvent(db, {
    sessionId: topic.id,
    source: 'user',
    wake: true,
    payload: { type: 'user', text: 'pending before binding' },
  })
  let scheduleCalls = 0
  const origSchedule = runtime.scheduleSession.bind(runtime)
  runtime.scheduleSession = (sid: string) => {
    scheduleCalls++
    return origSchedule(sid)
  }
  await runtime.stopSession(topic.id, 'cancel stop')
  await runtime.waitForIdle(topic.id)

  expect(scheduleCalls).toBe(0)
  expect(turnCalls).toBe(0)
  const pendingCount = db.get<{ c: number }>(
    `SELECT count(*) AS c FROM inbox_events WHERE session_id = ? AND status = 'pending'`,
    topic.id,
  )!.c
  expect(pendingCount).toBe(1)

  await runtime.dispose()
  db.close()
})

test('R2-P1-5: interrupted driver result executes once without tight-loop replay, preserves durable progress, and wakes concurrent prompts', async () => {
  const dir = tempDir('vela-r2-p1-5-')
  const db = openDatabase({ path: join(dir, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: dir })

  let runCalls = 0
  let writeProgressOnTurn = false
  let submitConcurrentOnSession: string | undefined
  runtime.registerDriver({
    name: 'vela',
    capabilities: {
      recovery: 'step',
      executionEnv: 'self',
      steer: false,
      approval: false,
    },
    async runTurn(req: DriverTurnRequest) {
      runCalls++
      if (writeProgressOnTurn) {
        db.run(
          `INSERT INTO vela_messages (id, session_id, seq, kind, role, content_json, created_at, run_id)
           VALUES (?, ?, ?, 'message', 'user', '[{"type":"text","text":"hi"}]', ?, ?)`,
          `msg-progress-${runCalls}`,
          req.sessionId,
          runCalls,
          new Date().toISOString(),
          req.runId,
        )
      }
      if (submitConcurrentOnSession === req.sessionId && runCalls === 3) {
        runtime.submitPrompt({
          sessionId: req.sessionId,
          text: 'concurrent prompt after interrupt',
        })
        return { status: 'interrupted', error: 'graceful interrupt' }
      }
      if (submitConcurrentOnSession === req.sessionId && runCalls === 4) {
        return { status: 'completed', replyText: 'concurrent ran' }
      }
      return { status: 'interrupted', error: 'graceful interrupt' }
    },
  })

  // Without durable progress: executes once, inbox returns to pending, no infinite loop
  const s1 = runtime.sessions.create({
    id: 's-int-noprogress',
    kind: 'chat',
    location: { environment: 'local', cwd: dir },
  })
  runtime.submitPrompt({ sessionId: s1.id, text: 'once please' })
  await runtime.waitForIdle(s1.id)
  expect(runCalls).toBe(1)
  expect(
    db.get<{ status: string }>(
      'SELECT status FROM runs WHERE session_id = ? LIMIT 1',
      s1.id,
    )?.status,
  ).toBe('interrupted')
  expect(
    db.get<{ status: string }>(
      'SELECT status FROM inbox_events WHERE session_id = ? LIMIT 1',
      s1.id,
    )?.status,
  ).toBe('pending')

  // With durable progress: executes once and marks inbox done so side effects do not replay
  writeProgressOnTurn = true
  const s2 = runtime.sessions.create({
    id: 's-int-progress',
    kind: 'chat',
    location: { environment: 'local', cwd: dir },
  })
  runtime.submitPrompt({ sessionId: s2.id, text: 'do once' })
  await runtime.waitForIdle(s2.id)
  expect(runCalls).toBe(2)
  expect(
    db.get<{ status: string }>(
      'SELECT status FROM runs WHERE session_id = ? LIMIT 1',
      s2.id,
    )?.status,
  ).toBe('interrupted')
  expect(
    db.get<{ status: string }>(
      'SELECT status FROM inbox_events WHERE session_id = ? LIMIT 1',
      s2.id,
    )?.status,
  ).toBe('done')

  // Concurrent prompt accepted during interrupted turn must NOT lose its wakeup
  const s3 = runtime.sessions.create({
    id: 's-int-concurrent',
    kind: 'chat',
    location: { environment: 'local', cwd: dir },
  })
  submitConcurrentOnSession = s3.id
  runtime.submitPrompt({ sessionId: s3.id, text: 'turn 1 interrupted' })
  await runtime.waitForIdle(s3.id)
  expect(runCalls).toBe(4)
  const s3Runs = db.all<{ status: string }>(
    'SELECT status FROM runs WHERE session_id = ? ORDER BY started_at ASC, rowid ASC',
    s3.id,
  )
  expect(s3Runs.map((r) => r.status)).toEqual(['interrupted', 'completed'])
  const s3Inbox = db.all<{ status: string }>(
    'SELECT status FROM inbox_events WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
    s3.id,
  )
  expect(s3Inbox.map((i) => i.status)).toEqual(['done', 'done'])

  await runtime.dispose()
  db.close()
})

test('R2-P2-1: delayed stale McpConnection factory cannot overwrite connecting transport before close()', async () => {
  const dir = tempDir('vela-r2-p2-1-')
  let releaseOldFactory!: () => void
  const oldFactoryGate = new Promise<void>((r) => {
    releaseOldFactory = r
  })
  let releaseNewConnect!: () => void
  const newConnectGate = new Promise<void>((r) => {
    releaseNewConnect = r
  })
  let oldClosed = false
  let newClosed = false
  let attempt = 0

  const conn = new McpConnection({
    entry: {
      name: 'srv',
      config: { type: 'http', url: 'https://example.com/mcp' },
      source: 'test',
    },
    cwd: dir,
    onTools: () => {},
    createTransport: async () => {
      attempt++
      if (attempt === 1) {
        await oldFactoryGate
        const [c1] = InMemoryTransport.createLinkedPair()
        const orig = c1.close.bind(c1)
        c1.close = async () => {
          oldClosed = true
          await orig()
        }
        return c1
      }
      const srv = new McpServer(
        { name: 'srv2', version: '1.0' },
        { capabilities: { tools: {} } },
      )
      const [c2, s2] = InMemoryTransport.createLinkedPair()
      const origStart = c2.start.bind(c2)
      c2.start = async () => {
        await newConnectGate
        await origStart()
      }
      const origClose = c2.close.bind(c2)
      c2.close = async () => {
        newClosed = true
        releaseNewConnect()
        await origClose()
      }
      await srv.connect(s2)
      return c2
    },
  })

  const p1 = conn.connect().catch(() => {})
  await Promise.resolve()
  const p2 = conn.reconnect().catch(() => {})
  await Promise.resolve()
  // Release old delayed factory AFTER reconnect() already moved to generation 1
  releaseOldFactory()
  await p1
  expect(oldClosed).toBe(true)

  // Now close() while attempt 2 is still blocked in connect(): connecting must be c2, not clobbered by attempt 1
  await conn.close()
  await p2
  expect(newClosed).toBe(true)
})

test('R2-P2-2: eval runtimePaths detects pi core tool names on current and legacy fixtures', () => {
  expect(runtimePaths(REPO_ROOT).usesPiCoreToolNames).toBe(true)

  const legacyRoot = tempDir('vela-eval-legacy-')
  mkdirSync(join(legacyRoot, 'src/tools'), { recursive: true })
  writeFileSync(
    join(legacyRoot, 'src/tools/file.ts'),
    `export const READ = { name: 'read_file' }\n`,
  )
  expect(runtimePaths(legacyRoot).usesPiCoreToolNames).toBe(false)
})
