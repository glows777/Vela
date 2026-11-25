import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDatabase } from '../../src/db/sqlite.ts'
import { createLocalExecutionEnv } from '../../src/driver/execution/local.ts'
import { createVelaAgentDriver } from '../../src/driver/runtime-adapter.ts'
import { SessionStore } from '../../src/driver/session/index.ts'
import { ToolExecutionResult } from '../../src/driver/tools/types.ts'
import {
  BackgroundJobManager,
  hasLiveSessionJobs,
} from '../../src/runtime/background-jobs.ts'
import { PROCESS_OWNER_PREFIX } from '../../src/runtime/driver.ts'
import { RuntimeEventBus } from '../../src/runtime/event-bus.ts'
import { enqueueInboxEvent } from '../../src/runtime/inbox.ts'
import {
  type ChannelAdapter,
  type ChannelOutboundMessage,
  VelaRuntimeEngine,
} from '../../src/runtime/index.ts'
import {
  enqueueOutboxInTx,
  OutboxDispatcher,
} from '../../src/runtime/outbox.ts'
import { recoverRuntimeState } from '../../src/runtime/worker.ts'
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

test('R2 P0-1: passive channel input coalesced after wake cannot hijack outbox target', async () => {
  const root = tempRoot('vela-r2-passive-')
  const db = openDatabase({ path: join(root, 'vela.db') })
  const delivered: ChannelOutboundMessage[] = []
  let ingest!: (
    msg: Parameters<Parameters<ChannelAdapter['start']>[0]['ingest']>[0],
  ) => Promise<void>

  const runtime = new VelaRuntimeEngine({ db, agentDir: root })
  runtime.registerDriver(
    createVelaAgentDriver({
      db,
      agentDir: root,
      blobs: runtime.blobs,
      environments: runtime.environments,
      defaultModel: createFauxModel({
        responses: [fauxText('Reply to active user only')],
      }),
    }),
  )
  await runtime.registerChannel({
    name: 'lark',
    start: async (ctx) => {
      ingest = ctx.ingest
    },
    stop: async () => {},
    deliver: async (msg) => {
      delivered.push(msg)
      return { externalMessageId: `out-${delivered.length}` }
    },
  })

  try {
    const sess = runtime.sessions.create({ id: 'passive-s', kind: 'chat' })
    runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'chat-active',
      kind: 'direct',
      sessionId: sess.id,
      enabled: true,
    })
    runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'chat-passive',
      kind: 'group',
      sessionId: sess.id,
      enabled: true,
    })

    // Passive input already buffered in inbox before active wake arrives
    await ingest({
      channel: 'lark',
      externalChatId: 'chat-passive',
      kind: 'group',
      dedupeKey: 'in-passive',
      senderId: 'u2',
      senderName: 'Noise',
      text: '[noise]',
      timestamp: new Date().toISOString(),
      passive: true,
    })
    await ingest({
      channel: 'lark',
      externalChatId: 'chat-active',
      kind: 'direct',
      dedupeKey: 'in-wake',
      senderId: 'u1',
      senderName: 'Alice',
      text: 'Do task',
      timestamp: new Date().toISOString(),
    })
    await runtime.waitForIdle(sess.id)

    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.externalChatId).toBe('chat-active')
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('R2 P1-1 & P1-4 & P1-5: run_started sees live owner, remote stop aborts cleanly, local stop drains queued wake', async () => {
  const root = tempRoot('vela-r2-owner-stop-')
  const dbPath = join(root, 'vela.db')
  const db = openDatabase({ path: dbPath })
  const dbPeer = openDatabase({ path: dbPath })
  const seenOwnersOnStart: Array<string | null> = []
  let activeAbortCount = 0

  const runtime = new VelaRuntimeEngine({ db, agentDir: root })
  const peer = new VelaRuntimeEngine({ db: dbPeer, agentDir: root })

  runtime.registerDriver({
    name: 'mock-hang',
    capabilities: {
      recovery: 'step',
      executionEnv: 'self',
      steer: false,
      approval: false,
    },
    abort() {
      activeAbortCount++
    },
    async runTurn(req) {
      if (req.abortSignal.aborted) return { status: 'stopped' }
      if (req.inputs.some((i) => i.payload.text === 'follow-up')) {
        return { status: 'completed', replyText: 'drained after stop' }
      }
      return await new Promise((resolve) => {
        req.abortSignal.addEventListener(
          'abort',
          () => resolve({ status: 'stopped' }),
          { once: true },
        )
      })
    },
  })

  runtime.subscribeEvents((ev) => {
    if (ev.type === 'run_started') {
      const row = db.get<{ owner_token: string | null }>(
        'SELECT owner_token FROM runs WHERE id = ?',
        ev.runId,
      )
      seenOwnersOnStart.push(row?.owner_token ?? null)
    }
  })

  try {
    const sess = runtime.sessions.create({
      id: 'stop-s',
      kind: 'chat',
      driver: 'mock-hang',
    })
    runtime.submitPrompt({ sessionId: sess.id, text: 'hang-1' })
    for (let i = 0; i < 40 && seenOwnersOnStart.length === 0; i++) {
      await Bun.sleep(10)
    }
    expect(seenOwnersOnStart[0]).toContain(`${PROCESS_OWNER_PREFIX}:`)

    const liveRun = db.get<{ id: string }>(
      `SELECT id FROM runs WHERE session_id = ? AND status = 'running'`,
      sess.id,
    )!
    // Cross-worker stop via peer Runtime against shared DB
    await peer.stopSession(sess.id)
    await runtime.waitForIdle(sess.id)
    expect(
      db.get<{ status: string }>(
        'SELECT status FROM runs WHERE id = ?',
        liveRun.id,
      )?.status,
    ).toBe('stopped')

    // Local stop while a queued wake arrives still drains queued wake
    runtime.submitPrompt({ sessionId: sess.id, text: 'hang-2' })
    for (
      let i = 0;
      i < 40 &&
      !db.get<{ id: string }>(
        `SELECT id FROM runs WHERE session_id = ? AND status = 'running'`,
        sess.id,
      );
      i++
    ) {
      await Bun.sleep(10)
    }
    const run2 = db.get<{ id: string }>(
      `SELECT id FROM runs WHERE session_id = ? AND status = 'running'`,
      sess.id,
    )!
    await runtime.stopSession(sess.id)
    expect(activeAbortCount).toBeGreaterThanOrEqual(1)
    runtime.submitPrompt({ sessionId: sess.id, text: 'follow-up' })
    await runtime.waitForIdle(sess.id)
    expect(
      db.get<{ status: string }>(
        'SELECT status FROM runs WHERE id = ?',
        run2.id,
      )?.status,
    ).toBe('stopped')
    const latestRun = db.get<{ status: string }>(
      `SELECT status FROM runs WHERE session_id = ? ORDER BY rowid DESC LIMIT 1`,
      sess.id,
    )
    expect(latestRun?.status).toBe('completed')

    // restartSession rejects if another live external-PID process owns an active run
    runtime.sessions.create({ id: 'ext-live-s', kind: 'chat' })
    const nowIso = new Date().toISOString()
    const extToken = `11111111-1111-1111-1111-111111111111:${process.ppid}:ext-live`
    db.run(
      `INSERT INTO runs (id, session_id, project_id, driver, trigger, status, model, owner_token, started_at, updated_at)
       VALUES ('ext-live-run', 'ext-live-s', NULL, 'mock-hang', 'user', 'running', NULL, ?, ?, ?)`,
      extToken,
      nowIso,
      nowIso,
    )
    await expect(peer.restartSession('ext-live-s')).rejects.toThrow(
      /live worker/i,
    )
    expect(
      db.get<{ key: string }>(
        'SELECT key FROM kv_meta WHERE key = ?',
        'stop_requested:ext-live-run',
      )?.key,
    ).toBe('stop_requested:ext-live-run')
    expect(
      db.get<{ status: string }>(
        `SELECT status FROM runs WHERE id = 'ext-live-run'`,
      )?.status,
    ).toBe('running')
  } finally {
    await peer.dispose()
    await runtime.dispose()
    dbPeer.close()
    db.close()
  }
})

test('R2 P1-2 & P1-3: waiting_human crash does not replay prompt; stopped repair uses old run_id', async () => {
  const root = tempRoot('vela-r2-recover-')
  const db = openDatabase({ path: join(root, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: root })

  runtime.registerDriver(
    createVelaAgentDriver({
      db,
      agentDir: root,
      blobs: runtime.blobs,
      environments: runtime.environments,
      defaultModel: createFauxModel({
        responses: [fauxToolCall('need_ok', {}), fauxText('After approval')],
      }),
      tools: [
        {
          name: 'need_ok',
          description: 'Needs approval',
          inputSchema: z.object({}),
          execute: async () => new ToolExecutionResult('done', 'done'),
        },
      ],
      toolApprovalCheck: (name) =>
        name === 'need_ok'
          ? { requireApproval: true, summary: 'Approve?' }
          : undefined,
    }),
  )

  try {
    const sess = runtime.sessions.create({ id: 'rec-s', kind: 'chat' })
    runtime.submitPrompt({ sessionId: sess.id, text: 'Trigger approval' })
    await runtime.waitForIdle(sess.id)

    // Simulate crash while inbox event is 'processing' alongside existing waiting_human messages
    const waitingRun = db.get<{ id: string }>(
      `SELECT id FROM runs WHERE session_id = ? AND status = 'waiting_human'`,
      sess.id,
    )!
    db.run(`UPDATE runs SET owner_token = NULL WHERE id = ?`, waitingRun.id)
    const { event: ev } = enqueueInboxEvent(db, {
      sessionId: sess.id,
      source: 'user',
      payload: { type: 'user', text: 'Should not duplicate' },
    })
    db.run(
      `UPDATE inbox_events SET status = 'processing', run_id = ? WHERE id = ?`,
      waitingRun.id,
      ev.id,
    )
    const report = recoverRuntimeState({
      db,
      backgroundJobs: runtime.backgroundJobs,
      outbox: runtime.outbox,
      timers: runtime.timers,
      activeOwners: new Set(),
      nowMs: Date.now(),
    })
    expect(report.recoveredRuns).toHaveLength(0)
    expect(
      db.get<{ status: string }>(
        'SELECT status FROM inbox_events WHERE id = ?',
        ev.id,
      )?.status,
    ).toBe('done')

    // Approve & finish waiting_human turn
    const [pending] = runtime.listPendingApprovals(sess.id)
    expect(pending).toBeDefined()
    runtime.resolveApproval({ approvalId: pending!.id, decision: 'approved' })
    await runtime.waitForIdle(sess.id)

    // Simulate unresolved stopped assistant tool step before a failed new run
    const nowTs = new Date().toISOString()
    db.run(
      `INSERT INTO runs (id, session_id, project_id, driver, trigger, status, started_at, updated_at)
       VALUES ('old-stopped-run', ?, NULL, 'vela', 'user', 'stopped', ?, ?)`,
      sess.id,
      nowTs,
      nowTs,
    )
    const store = new SessionStore(sess.id, db, {
      blobsDir: runtime.blobs.rootDir,
    })
    await store.loadSaved()
    store.appendMessage(
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            toolCallId: 'orphan-tc',
            toolName: 'need_ok',
            input: {},
          },
        ],
      },
      { runId: 'old-stopped-run' },
    )
    const driver = createVelaAgentDriver({
      db,
      agentDir: root,
      blobs: runtime.blobs,
      environments: runtime.environments,
      defaultModel: createFauxModel({
        responses: [
          () => {
            throw new Error('Crash right after repair')
          },
        ],
      }),
    })
    await driver.runTurn({
      sessionId: sess.id,
      projectId: null,
      runId: 'new-run-1',
      ownerToken: 'owner-1',
      trigger: 'user',
      inputs: [
        {
          id: 'in-1',
          source: 'user',
          wake: true,
          passive: false,
          createdAt: new Date().toISOString(),
          payload: { type: 'user', text: 'Fresh prompt' },
        },
      ],
      abortSignal: new AbortController().signal,
      recoverPending: false,
      allowWaitingHuman: false,
      onEvent: () => {},
      onDelta: () => {},
      wakeSession: () => {},
    })
    // User prompt persisted under new-run-1; repair tool message attributed to old-stopped-run
    const userRow = db.get<{ role: string }>(
      `SELECT role FROM vela_messages WHERE session_id = ? AND run_id = ? AND role = 'user'`,
      sess.id,
      'new-run-1',
    )
    expect(userRow?.role).toBe('user')
    const toolRow = db.get<{ run_id: string }>(
      `SELECT run_id FROM vela_messages WHERE session_id = ? AND role = 'tool' ORDER BY rowid DESC LIMIT 1`,
      sess.id,
    )
    expect(toolRow?.run_id).toBe('old-stopped-run')
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('R2 P1-6 & P1-10 & P2-2: outbox live lease not reclaimed, empty routine does not spin, registerChannel flushes', async () => {
  const root = tempRoot('vela-r2-outbox-')
  const db = openDatabase({ path: join(root, 'vela.db') })
  const delivered: ChannelOutboundMessage[] = []
  const runtime = new VelaRuntimeEngine({ db, agentDir: root })

  try {
    const sess = runtime.sessions.create({ id: 'ob-s', kind: 'chat' })
    const stale = new Date(Date.now() - 120_000).toISOString()
    enqueueOutboxInTx(db, {
      id: 'ob-live',
      sessionId: sess.id,
      channel: 'lark',
      externalChatId: 'c1',
      text: 'in-flight',
    })
    enqueueOutboxInTx(db, {
      id: 'ob-dead',
      sessionId: sess.id,
      channel: 'lark',
      externalChatId: 'c2',
      text: 'dead-worker',
    })
    db.run(
      `UPDATE outbox SET status = 'sending', attempt = 1, updated_at = ? WHERE id = 'ob-dead'`,
      stale,
    )
    db.run(
      `INSERT INTO kv_meta (key, value_json, updated_at) VALUES ('outbox_lease:ob-dead', ?, ?)`,
      JSON.stringify(`${PROCESS_OWNER_PREFIX}:999999:dead-lease`),
      stale,
    )
    enqueueOutboxInTx(db, {
      id: 'ob-unreg',
      sessionId: sess.id,
      channel: 'slack',
      externalChatId: 's1',
      text: 'hello slack',
    })

    let releaseInFlight!: () => void
    let enteredDeliver!: () => void
    const enteredPromise = new Promise<void>((r) => {
      enteredDeliver = r
    })
    const liveDispatcher = new OutboxDispatcher(db, (ch) =>
      ch === 'lark'
        ? {
            name: 'lark',
            start: async () => {},
            stop: async () => {},
            deliver: async (msg) => {
              if (msg.outboxId === 'ob-live') {
                enteredDeliver()
                await new Promise<void>((r) => {
                  releaseInFlight = r
                })
              }
              return { externalMessageId: `ok-${msg.outboxId}` }
            },
          }
        : undefined,
    )
    const peerDispatcher = new OutboxDispatcher(db, () => undefined)
    const flushPromise = liveDispatcher.flushOnce()
    await enteredPromise

    const reclaimed = peerDispatcher.recoverStaleSending()
    expect(reclaimed).toBe(1)
    expect(
      db.get<{ status: string }>(
        `SELECT status FROM outbox WHERE id = 'ob-live'`,
      )?.status,
    ).toBe('sending')
    expect(
      db.get<{ status: string }>(
        `SELECT status FROM outbox WHERE id = 'ob-dead'`,
      )?.status,
    ).toBe('pending')

    releaseInFlight()
    await flushPromise
    expect(
      db.get<{ status: string }>(
        `SELECT status FROM outbox WHERE id = 'ob-live'`,
      )?.status,
    ).toBe('sent')

    // Overdue routine with no sessions advances next_fire_at so it doesn't spin
    const proj = runtime.projects.create({ name: 'empty-proj' })
    const timer = runtime.timers.createRoutine({
      projectId: proj.id,
      message: 'ping',
      schedule: { time: '00:00' },
    })
    db.run(`UPDATE timers SET next_fire_at = ? WHERE id = ?`, stale, timer.id)
    runtime.timers.tick(Date.now())
    const refreshed = runtime.timers.get(timer.id)
    expect(refreshed?.nextFireAt).toBeTruthy()
    expect(Date.parse(refreshed!.nextFireAt!)).toBeGreaterThan(Date.now())

    // Registering 'slack' should immediately flush ob-unreg
    await runtime.registerChannel({
      name: 'slack',
      start: async () => {},
      stop: async () => {},
      deliver: async (m) => {
        delivered.push(m)
        return { externalMessageId: 'm1' }
      },
    })
    expect(delivered.map((d) => d.text)).toContain('hello slack')
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('R2 P1-8 & P2-6: bg jobs persist across turns, DB-scoped stop/checks isolate other DBs', async () => {
  const root = tempRoot('vela-r2-bg-')
  const dbA = openDatabase({ path: join(root, 'a.db') })
  const dbB = openDatabase({ path: join(root, 'b.db') })
  const rtA = new VelaRuntimeEngine({ db: dbA, agentDir: join(root, 'a') })
  const rtB = new VelaRuntimeEngine({ db: dbB, agentDir: join(root, 'b') })
  const bgOutputs: string[] = []

  rtA.registerDriver(
    createVelaAgentDriver({
      db: dbA,
      agentDir: join(root, 'a'),
      blobs: rtA.blobs,
      environments: rtA.environments,
      defaultModel: createFauxModel({
        responses: [
          fauxToolCall('bash', {
            command: 'echo bg-started && sleep 0.2',
            run_in_background: true,
          }),
          fauxText('Started bg-1'),
          fauxToolCall('background_output', { id: 'bg-1' }),
          (req) => {
            bgOutputs.push(
              req.toolResults.map((r) => `${r.toolName}:${r.output}`).join('|'),
            )
            return fauxText('Checked bg-1 in turn 2')
          },
        ],
      }),
    }),
  )

  try {
    const sessA = rtA.sessions.create({ id: 'same-id', kind: 'chat' })
    const sessB = rtB.sessions.create({ id: 'same-id', kind: 'chat' })
    const mgrB = new BackgroundJobManager(dbB)
    let abortedB = false
    mgrB.recordStart({
      id: 'job-b',
      sessionId: sessB.id,
      command: 'sleep 10',
      commandHead: 'sleep 10',
      abort: () => {
        abortedB = true
      },
    })

    expect(hasLiveSessionJobs(dbB, sessB.id)).toBe(true)
    expect(hasLiveSessionJobs(dbA, sessA.id)).toBe(false)

    // Stopping session on rtA must NOT abort job-b on dbB
    await rtA.stopSession(sessA.id)
    expect(abortedB).toBe(false)

    rtA.submitPrompt({ sessionId: sessA.id, text: 'Start background task' })
    await rtA.waitForIdle(sessA.id)
    rtA.submitPrompt({ sessionId: sessA.id, text: 'Check bg-1' })
    await rtA.waitForIdle(sessA.id)
    expect(bgOutputs[0]).toContain('background_output')
    expect(bgOutputs[0]).toContain('bg-1')
  } finally {
    await rtA.stopSession('same-id').catch(() => {})
    for (let i = 0; i < 40 && hasLiveSessionJobs(dbA, 'same-id'); i++) {
      await Bun.sleep(25)
    }
    await rtA.dispose()
    await rtB.dispose()
    dbA.close()
    dbB.close()
  }
})

test('R2 P1-9 & P1 driver-step: invalid defaultTools fails closed; mid-stream abort emits message_committed', async () => {
  const root = tempRoot('vela-r2-tools-abort-')
  const db = openDatabase({ path: join(root, 'vela.db') })
  const db2 = openDatabase({ path: join(root, 'vela2.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: root })
  const runtime2 = new VelaRuntimeEngine({
    db: db2,
    agentDir: join(root, 'rt2'),
  })

  runtime.registerDriver(
    createVelaAgentDriver({
      db,
      agentDir: root,
      blobs: runtime.blobs,
      environments: runtime.environments,
      defaultModel: createFauxModel({
        responses: [fauxText('should not run')],
      }),
    }),
  )

  runtime2.registerDriver(
    createVelaAgentDriver({
      db: db2,
      agentDir: join(root, 'rt2'),
      blobs: runtime2.blobs,
      environments: runtime2.environments,
      defaultModel: createFauxModel({
        responses: [
          () => ({
            text: 'Partial text streamed before hang',
            hang: true,
          }),
        ],
      }),
    }),
  )

  try {
    const proj = runtime.projects.create({ name: 'bad-tools-proj' })
    db.run(
      `UPDATE projects SET default_tools_json = '{"bad":true}' WHERE id = ?`,
      proj.id,
    )
    const badSess = runtime.sessions.create({
      id: 'bad-tools-s',
      projectId: proj.id,
      kind: 'chat',
    })
    runtime.submitPrompt({ sessionId: badSess.id, text: 'Hi' })
    await runtime.waitForIdle(badSess.id)
    const badRun = db.get<{ status: string; error: string | null }>(
      `SELECT status, error FROM runs WHERE session_id = ? ORDER BY rowid DESC LIMIT 1`,
      badSess.id,
    )
    expect(badRun?.status).toBe('failed')
    expect(badRun?.error).toBeTruthy()

    // Mid-stream abort emits message_committed for partial text via driver-step
    const s2 = runtime2.sessions.create({ id: 'mid-abort-s', kind: 'chat' })
    const committedRoles: string[] = []
    runtime2.subscribeEvents((e) => {
      if (e.sessionId === s2.id && e.type === 'message_committed') {
        committedRoles.push(e.message.role)
      }
    })
    runtime2.submitPrompt({ sessionId: s2.id, text: 'Stream then stop' })
    for (let i = 0; i < 40 && !committedRoles.includes('user'); i++) {
      await Bun.sleep(10)
    }
    await Bun.sleep(30)
    await runtime2.stopSession(s2.id)
    await runtime2.waitForIdle(s2.id)
    expect(committedRoles).toContain('user')
    expect(committedRoles).toContain('assistant')
  } finally {
    await runtime2.dispose()
    await runtime.dispose()
    db2.close()
    db.close()
  }
})

test('R2 P2-3,4,6,8,9: case-sensitive cleanup, shortcut rollback, local blob fork, live job delete guard, async listener error', async () => {
  const root = tempRoot('vela-r2-p2-')
  const db = openDatabase({ path: join(root, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: root })

  let unhandledCount = 0
  const onUnhandled = () => {
    unhandledCount++
  }
  process.on('unhandledRejection', onUnhandled)

  try {
    // P2-9: async throwing listener must not emit unhandledRejection
    const bus = new RuntimeEventBus(db)
    bus.subscribeEvents(async () => {
      throw new Error('async event listener failure')
    })
    bus.subscribeDeltas(async () => {
      throw new Error('async delta listener failure')
    })
    const sess = runtime.sessions.create({ id: 'Case-A', kind: 'chat' })
    runtime.sessions.create({ id: 'case-a', kind: 'chat' })
    bus.append({
      sessionId: sess.id,
      projectId: null,
      runId: 'r',
      payload: { type: 'run_started', runId: 'r', trigger: 'user' },
    })
    bus.emitDelta({
      type: 'text_delta',
      sessionId: sess.id,
      runId: 'r',
      contentIndex: 0,
      delta: 'hi',
    })
    await Bun.sleep(20)
    expect(unhandledCount).toBe(0)

    // P2-3 & P2-4: failed shortcut clears dedupe so retry works
    let failDeliver = true
    let ingest!: (
      msg: Parameters<Parameters<ChannelAdapter['start']>[0]['ingest']>[0],
    ) => Promise<void>
    await runtime.registerChannel({
      name: 'lark',
      start: async (ctx) => {
        ingest = ctx.ingest
      },
      stop: async () => {},
      deliver: async () => {
        if (failDeliver) throw new Error('network flake')
        return { externalMessageId: 'ok-1' }
      },
    })
    runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'sc-chat',
      kind: 'direct',
      sessionId: sess.id,
      enabled: true,
    })
    await expect(
      ingest({
        channel: 'lark',
        externalChatId: 'sc-chat',
        kind: 'direct',
        dedupeKey: 'sc-msg-1',
        senderId: 'u1',
        senderName: 'Alice',
        text: '!status',
        timestamp: new Date().toISOString(),
      }),
    ).rejects.toThrow('network flake')
    failDeliver = false
    await expect(
      ingest({
        channel: 'lark',
        externalChatId: 'sc-chat',
        kind: 'direct',
        dedupeKey: 'sc-msg-1',
        senderId: 'u1',
        senderName: 'Alice',
        text: '!status',
        timestamp: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined()

    // P2-6: live background job blocks deletion & case-sensitive kv_meta cleanup preserves case-a
    const now = new Date().toISOString()
    db.run(
      `INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?)`,
      'channel_upload:case-a:att-1',
      JSON.stringify({ keep: true }),
      now,
    )
    db.run(
      `INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?)`,
      'channel_upload:Case-A:att-1',
      JSON.stringify({ drop: true }),
      now,
    )
    const bgMgr = new BackgroundJobManager(db)
    bgMgr.recordStart({
      id: 'live-del-job',
      sessionId: 'Case-A',
      command: 'sleep 5',
      commandHead: 'sleep 5',
      abort: () => {},
    })
    expect(() => runtime.sessions.delete('Case-A')).toThrow(/background job/i)
    bgMgr.recordFinish({
      id: 'live-del-job',
      status: 'stopped',
      exitCode: 0,
    })
    expect(runtime.sessions.delete('Case-A')).toBe(true)
    expect(
      db.get<{ key: string }>(
        'SELECT key FROM kv_meta WHERE key = ?',
        'channel_upload:case-a:att-1',
      )?.key,
    ).toBe('channel_upload:case-a:att-1')
    expect(
      db.get<{ key: string }>(
        'SELECT key FROM kv_meta WHERE key = ?',
        'channel_upload:Case-A:att-1',
      ),
    ).toBeUndefined()
    expect(
      db.get<{ key: string }>(
        'SELECT key FROM kv_meta WHERE key = ?',
        'channel_shortcut:lark:sc-msg-1',
      ),
    ).toBeUndefined()

    // P2-8: inheritForFork reads latest local savedPath when still present
    const localSaved = join(root, 'edited-local.txt')
    writeFileSync(localSaved, 'original-bytes')
    const env = createLocalExecutionEnv({ cwd: root })
    await runtime.blobs.materializeChannelUpload(env, {
      sessionId: 'case-a',
      name: 'note.txt',
      hostPath: localSaved,
    })
    writeFileSync(localSaved, 'edited-on-host')
    const forked = await runtime.blobs.inheritForFork({
      parentSessionId: 'case-a',
      targetSessionId: 'fork-dest',
      branchTexts: [`[file: note.txt, saved at ${localSaved}]`],
      resolveEnv: async () => env,
    })
    expect(forked.rewrites).toHaveLength(1)
    expect(readFileSync(forked.rewrites[0]![1], 'utf8')).toBe('edited-on-host')
  } finally {
    process.off('unhandledRejection', onUnhandled)
    await runtime.dispose()
    db.close()
  }
})
