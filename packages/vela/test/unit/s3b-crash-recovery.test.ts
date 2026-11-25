import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDatabase } from '../../src/db/sqlite.ts'
import { createVelaAgentDriver } from '../../src/driver/runtime-adapter.ts'
import { SessionStore } from '../../src/driver/session/index.ts'
import { ToolExecutionResult } from '../../src/driver/tools/types.ts'
import {
  type ChannelAdapter,
  type ChannelOutboundMessage,
  type RuntimeEvent,
  type StreamDeltaEvent,
  VelaRuntimeEngine,
} from '../../src/runtime/index.ts'
import {
  enqueueOutboxInTx,
  MAX_OUTBOX_ATTEMPTS,
} from '../../src/runtime/outbox.ts'
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

test('inbox_events batches passive + wake=0 notes, persists structural events(seq) without deltas, and recovers pre-message & mid-stream crashes without duplicate prompts', async () => {
  const root = tempRoot('vela-s3b-crash-inbox-')
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
  const dbPath = join(agentDir, 'vela.db')

  // Phase 1: seed crashed states on disk
  {
    const db = openDatabase({ path: dbPath })
    const runtime = new VelaRuntimeEngine({ db, agentDir })
    const session = runtime.sessions.create({
      id: 's-batch',
      kind: 'chat',
      location: { environment: 'local', cwd: root },
    })

    // Passive + silent wake=0 notes stay pending until a wake=1 event arrives
    runtime.submitPrompt({
      sessionId: session.id,
      text: 'passive chatter',
      passive: true,
      wake: false,
    })
    runtime.submitPrompt({
      sessionId: session.id,
      text: 'child finished silently',
      source: 'handoff',
      wake: false,
    })
    expect(runtime.sessions.get(session.id)?.state).toBe('idle')

    // Simulated crash: run_id 'run-premsg' crashed in processing BEFORE writing any vela_messages
    runtime.sessions.create({
      id: 's-premsg',
      kind: 'chat',
      location: { environment: 'local', cwd: root },
    })
    const now = new Date().toISOString()
    db.run(
      `INSERT INTO runs (id, session_id, driver, trigger, status, owner_token, started_at, updated_at)
       VALUES ('run-premsg', 's-premsg', 'vela', 'user', 'running', 'dead:999999:tok', ?, ?)`,
      now,
      now,
    )
    db.run(`UPDATE sessions SET state = 'running' WHERE id = 's-premsg'`)
    db.run(
      `INSERT INTO inbox_events (id, session_id, source, wake, passive, status, payload_json, run_id, created_at)
       VALUES ('in-premsg', 's-premsg', 'user', 1, 0, 'processing', '{"text":"premsg prompt"}', 'run-premsg', ?)`,
      now,
    )

    // Simulated crash: run_id 'run-midstream' crashed AFTER user message persisted
    runtime.sessions.create({
      id: 's-midstream',
      kind: 'chat',
      location: { environment: 'local', cwd: root },
    })
    const midStore = new SessionStore('s-midstream', db, {
      blobsDir: runtime.blobs.rootDir,
    })
    await midStore.loadSaved()
    midStore.appendMessage(
      { role: 'user', content: 'midstream prompt' },
      { runId: 'run-midstream' },
    )
    db.run(
      `INSERT INTO runs (id, session_id, driver, trigger, status, owner_token, started_at, updated_at)
       VALUES ('run-midstream', 's-midstream', 'vela', 'user', 'running', 'dead:999999:tok2', ?, ?)`,
      now,
      now,
    )
    db.run(`UPDATE sessions SET state = 'running' WHERE id = 's-midstream'`)
    db.run(
      `INSERT INTO inbox_events (id, session_id, source, wake, passive, status, payload_json, run_id, created_at)
       VALUES ('in-mid', 's-midstream', 'user', 1, 0, 'processing', '{"text":"midstream prompt"}', 'run-midstream', ?)`,
      now,
    )

    await runtime.dispose()
    db.close()
  }

  // Phase 2: restart fresh Runtime and recover
  const db2 = openDatabase({ path: dbPath })
  const seenPrompts: string[] = []
  const events: RuntimeEvent[] = []
  const deltas: StreamDeltaEvent[] = []
  const runtime2 = new VelaRuntimeEngine({ db: db2, agentDir })
  runtime2.subscribeEvents((ev) => events.push(ev))
  runtime2.subscribeDeltas((d) => deltas.push(d))
  runtime2.registerDriver(
    createVelaAgentDriver({
      db: db2,
      agentDir,
      blobs: runtime2.blobs,
      environments: runtime2.environments,
      defaultModel: createFauxModel({
        responses: [
          (req) => {
            seenPrompts.push(JSON.stringify(req.prompt))
            return fauxText('Recovered response')
          },
          (req) => {
            seenPrompts.push(JSON.stringify(req.prompt))
            return fauxText('Recovered response 2')
          },
          (req) => {
            seenPrompts.push(JSON.stringify(req.prompt))
            return fauxText('Batched wake response')
          },
        ],
      }),
    }),
  )

  try {
    const rec = await runtime2.recover()
    expect(rec.recoveredRuns).toEqual(['run-midstream'])
    expect(rec.requeuedInboxRuns).toEqual(['run-premsg'])
    await runtime2.waitForIdle()

    // Now wake s-batch with a real user prompt and verify passive + wake=0 notes batched together
    runtime2.submitPrompt({ sessionId: 's-batch', text: 'wake prompt' })
    await runtime2.waitForIdle('s-batch')

    const batchMsgs = db2.all<{ content_json: string }>(
      `SELECT content_json FROM vela_messages WHERE session_id = 's-batch' AND role = 'user' ORDER BY seq ASC`,
    )
    expect(batchMsgs).toHaveLength(1)
    expect(batchMsgs[0]!.content_json).toContain('passive chatter')
    expect(batchMsgs[0]!.content_json).toContain('child finished silently')
    expect(batchMsgs[0]!.content_json).toContain('wake prompt')

    // Zero duplicate user messages on premsg & midstream
    expect(
      db2.all(
        `SELECT id FROM vela_messages WHERE session_id = 's-premsg' AND role = 'user'`,
      ),
    ).toHaveLength(1)
    expect(
      db2.all(
        `SELECT id FROM vela_messages WHERE session_id = 's-midstream' AND role = 'user'`,
      ),
    ).toHaveLength(1)

    // Deltas arrived in memory while SQLite events(seq) only stored structural transitions
    expect(deltas.some((d) => d.type === 'text_delta')).toBe(true)
    const persistedTypes = db2
      .all<{ type: string }>('SELECT type FROM events ORDER BY seq ASC')
      .map((r) => r.type)
    expect(persistedTypes).not.toContain('text_delta')
    expect(persistedTypes).toContain('run_started')
    expect(persistedTypes).toContain('run_finished')

    // afterSeq catch-up returns only events after cursor
    const firstSeq = events[0]!.seq
    const catchup = runtime2.listEvents({ afterSeq: firstSeq })
    expect(catchup.every((e) => e.seq > firstSeq)).toBe(true)
  } finally {
    await runtime2.dispose()
    db2.close()
  }
})

test('tool crash recovery replays safe tools (<5 attempts), marks unsafe tools interrupted, and persists waiting_human approvals across restarts', async () => {
  const root = tempRoot('vela-s3b-crash-tools-wh-')
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
  const dbPath = join(agentDir, 'vela.db')

  // Phase 1: create crashed safe tool, crashed unsafe tool, and live waiting_human approval
  {
    const db = openDatabase({ path: dbPath })
    const runtime = new VelaRuntimeEngine({ db, agentDir })
    const now = new Date().toISOString()

    // 1) Safe vs unsafe tool rows in running state
    runtime.sessions.create({
      id: 's-tools',
      kind: 'chat',
      location: { environment: 'local', cwd: root },
    })
    const tStore = new SessionStore('s-tools', db, {
      blobsDir: runtime.blobs.rootDir,
    })
    await tStore.loadSaved()
    tStore.appendMessage(
      { role: 'user', content: 'run tools' },
      { runId: 'r-tools' },
    )
    const asstEntry = tStore.appendMessage(
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            toolCallId: 'tc-safe',
            toolName: 'safe_probe',
            input: {},
          },
          {
            type: 'tool_call',
            toolCallId: 'tc-unsafe',
            toolName: 'unsafe_op',
            input: {},
          },
        ],
      },
      { runId: 'r-tools' },
    )
    db.run(
      `INSERT INTO runs (id, session_id, driver, trigger, status, owner_token, started_at, updated_at)
       VALUES ('r-tools', 's-tools', 'vela', 'user', 'running', 'dead:999999:t1', ?, ?)`,
      now,
      now,
    )
    db.run(`UPDATE sessions SET state = 'running' WHERE id = 's-tools'`)
    db.run(
      `INSERT INTO vela_tool_calls (
         id, session_id, run_id, assistant_message_id, tool_call_id, call_index,
         tool_name, input_json, execution_mode, replay, status, attempt, created_at, updated_at
       ) VALUES
       ('row-safe', 's-tools', 'r-tools', ?, 'tc-safe', 0, 'safe_probe', '{}', 'sequential', 'safe', 'running', 1, ?, ?),
       ('row-unsafe', 's-tools', 'r-tools', ?, 'tc-unsafe', 1, 'unsafe_op', '{}', 'sequential', 'none', 'running', 1, ?, ?)`,
      asstEntry.id,
      now,
      now,
      asstEntry.id,
      now,
      now,
    )

    // 2) Run a real waiting_human tool approval through VelaRuntimeEngine
    let executedSensitive = 0
    runtime.registerDriver(
      createVelaAgentDriver({
        db,
        agentDir,
        blobs: runtime.blobs,
        environments: runtime.environments,
        defaultModel: createFauxModel({
          responses: [
            fauxToolCall('danger_op', { action: 'deploy' }),
            fauxText('Deployed after approval'),
          ],
        }),
        tools: [
          {
            name: 'danger_op',
            description: 'Sensitive operation',
            inputSchema: z.object({ action: z.string() }),
            execute: async () => {
              executedSensitive++
              return new ToolExecutionResult('DEPLOYED_OK', 'DEPLOYED_OK')
            },
          },
        ],
        toolApprovalCheck: (toolName) =>
          toolName === 'danger_op'
            ? { requireApproval: true, summary: 'Approve deploy' }
            : undefined,
      }),
    )
    runtime.sessions.create({
      id: 's-wh',
      kind: 'chat',
      location: { environment: 'local', cwd: root },
    })
    runtime.submitPrompt({ sessionId: 's-wh', text: 'please deploy' })
    await runtime.waitForIdle('s-wh')

    expect(executedSensitive).toBe(0)
    expect(runtime.sessions.get('s-wh')?.state).toBe('waiting_human')
    expect(runtime.listPendingApprovals('s-wh')).toHaveLength(1)

    await runtime.dispose()
    db.close()
  }

  // Phase 2: restart Runtime -> safe tool replays once, unsafe tool is interrupted, waiting_human stays suspended with 0 workers until resolved
  let safeRuns = 0
  let unsafeRuns = 0
  let approvedExecutions = 0
  const db2 = openDatabase({ path: dbPath })
  const runtime2 = new VelaRuntimeEngine({ db: db2, agentDir })
  runtime2.registerDriver(
    createVelaAgentDriver({
      db: db2,
      agentDir,
      blobs: runtime2.blobs,
      environments: runtime2.environments,
      defaultModel: createFauxModel({
        responses: [
          fauxText('Tools reconciled'),
          fauxText('Deployed after approval'),
        ],
      }),
      tools: [
        {
          name: 'safe_probe',
          description: 'Safe probe',
          inputSchema: z.object({}),
          replay: 'safe',
          execute: async () => {
            safeRuns++
            return new ToolExecutionResult('SAFE_OK', 'SAFE_OK')
          },
        },
        {
          name: 'unsafe_op',
          description: 'Unsafe op',
          inputSchema: z.object({}),
          execute: async () => {
            unsafeRuns++
            return new ToolExecutionResult(
              'SHOULD_NOT_REPLAY',
              'SHOULD_NOT_REPLAY',
            )
          },
        },
        {
          name: 'danger_op',
          description: 'Sensitive operation',
          inputSchema: z.object({ action: z.string() }),
          execute: async () => {
            approvedExecutions++
            return new ToolExecutionResult('DEPLOYED_OK', 'DEPLOYED_OK')
          },
        },
      ],
    }),
  )

  try {
    await runtime2.recover()
    await runtime2.waitForIdle('s-tools')

    expect(safeRuns).toBe(1)
    expect(unsafeRuns).toBe(0)
    expect(
      db2.get<{ status: string }>(
        `SELECT status FROM vela_tool_calls WHERE id = 'row-unsafe'`,
      )?.status,
    ).toBe('interrupted')
    expect(runtime2.sessions.get('s-tools')?.state).toBe('idle')

    // s-wh remains waiting_human across restart with 0 workers until resolved
    expect(runtime2.sessions.get('s-wh')?.state).toBe('waiting_human')
    const [pending] = runtime2.listPendingApprovals('s-wh')
    expect(pending).toBeDefined()
    expect(approvedExecutions).toBe(0)

    // Multi-approval guard: add a second pending wait_for_input approval on the same run
    const secondApproval = runtime2.requestApproval({
      sessionId: 's-wh',
      runId: pending!.runId,
      toolName: 'wait_for_input',
      summary: 'Confirm target region',
    })
    const firstResolve = runtime2.resolveApproval({
      approvalId: pending!.id,
      decision: 'approved',
      decidedBy: 'liam',
    })
    expect(firstResolve.shouldWake).toBe(false)
    expect(approvedExecutions).toBe(0)

    const secondResolve = runtime2.resolveApproval({
      approvalId: secondApproval.id,
      decision: 'approved',
      decidedBy: 'liam',
    })
    expect(secondResolve.shouldWake).toBe(true)
    await runtime2.waitForIdle('s-wh')

    expect(approvedExecutions).toBe(1)
    expect(runtime2.sessions.get('s-wh')?.state).toBe('idle')
  } finally {
    await runtime2.dispose()
    db2.close()
  }
})

test('outbox idempotent retry/backoff and background_jobs restart reconciliation', async () => {
  const root = tempRoot('vela-s3b-outbox-bg-')
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
  const dbPath = join(agentDir, 'vela.db')

  {
    const db = openDatabase({ path: dbPath })
    const runtime = new VelaRuntimeEngine({ db, agentDir })
    const s = runtime.sessions.create({ id: 's-bg', kind: 'chat' })

    // Running background job orphaned across crash
    runtime.backgroundJobs.recordStart({
      id: 'bg-orphan',
      sessionId: s.id,
      command: 'sleep 100',
      commandHead: 'sleep 100',
    })

    // Outbox item stuck in 'sending' during crash
    db.transaction(() => {
      const ob = enqueueOutboxInTx(db, {
        id: 'ob-1',
        sessionId: s.id,
        channel: 'testchan',
        externalChatId: 'chat-1',
        kind: 'reply',
        text: 'Resumed delivery',
      })
      db.run(`UPDATE outbox SET status = 'sending' WHERE id = ?`, ob.id)
    })

    await runtime.dispose()
    db.close()
  }

  const db2 = openDatabase({ path: dbPath })
  const deliveredIds: string[] = []
  let failAttempts = 1
  const adapter: ChannelAdapter = {
    name: 'testchan',
    async start() {},
    async stop() {},
    async deliver(msg: ChannelOutboundMessage) {
      deliveredIds.push(msg.outboxId)
      if (failAttempts > 0) {
        failAttempts--
        throw new Error('temporary network error')
      }
      return { externalMessageId: `sent-${msg.outboxId}` }
    },
  }

  const runtime2 = new VelaRuntimeEngine({ db: db2, agentDir })
  runtime2.registerDriver(
    createVelaAgentDriver({
      db: db2,
      agentDir,
      blobs: runtime2.blobs,
      environments: runtime2.environments,
      defaultModel: createFauxModel({ responses: [fauxText('Ack job end')] }),
    }),
  )

  try {
    await runtime2.registerChannel(adapter)
    const rec = await runtime2.recover()
    expect(rec.interruptedJobs).toEqual(['bg-orphan'])
    await runtime2.waitForIdle('s-bg')

    // Interrupted job became 'interrupted' and woke session via inbox_events
    expect(runtime2.backgroundJobs.get('bg-orphan')?.status).toBe('interrupted')
    expect(
      db2.get<{ n: number }>(
        `SELECT count(*) AS n FROM inbox_events WHERE session_id = 's-bg' AND source = 'job' AND status = 'done'`,
      )?.n,
    ).toBe(1)

    // First flush failed once and scheduled backoff; retrying after backoff delivers with same outboxId
    expect(deliveredIds).toEqual(['ob-1'])
    const afterFail = runtime2.outbox.listPending('testchan')[0]!
    expect(afterFail.attempt).toBe(1)
    expect(afterFail.status).toBe('pending')

    await runtime2.outbox.flushOnce(Date.now() + 60_000)
    expect(deliveredIds).toEqual(['ob-1', 'ob-1'])
    expect(
      db2.get<{ status: string; external_message_id: string }>(
        `SELECT status, external_message_id FROM outbox WHERE id = 'ob-1'`,
      ),
    ).toEqual({ status: 'sent', external_message_id: 'sent-ob-1' })

    // Verify permanent failure after MAX_OUTBOX_ATTEMPTS
    db2.transaction(() => {
      enqueueOutboxInTx(db2, {
        id: 'ob-fail',
        sessionId: 's-bg',
        channel: 'testchan',
        externalChatId: 'chat-1',
        text: 'Never succeeds',
      })
      db2.run(
        `UPDATE outbox SET attempt = ? WHERE id = 'ob-fail'`,
        MAX_OUTBOX_ATTEMPTS - 1,
      )
    })
    failAttempts = 1
    await runtime2.outbox.flushOnce()
    expect(
      db2.get<{ status: string }>(
        `SELECT status FROM outbox WHERE id = 'ob-fail'`,
      )?.status,
    ).toBe('failed')
  } finally {
    await runtime2.dispose()
    db2.close()
  }
})
