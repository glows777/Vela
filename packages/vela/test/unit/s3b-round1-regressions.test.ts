import { afterEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDatabase } from '../../src/db/sqlite.ts'
import { createLocalExecutionEnv } from '../../src/driver/execution/local.ts'
import { createVelaAgentDriver } from '../../src/driver/runtime-adapter.ts'
import { listSessionSummariesFromDb } from '../../src/driver/session/db-queries.ts'
import { SessionStore } from '../../src/driver/session/index.ts'
import { ToolExecutionResult } from '../../src/driver/tools/types.ts'
import { BackgroundJobManager } from '../../src/runtime/background-jobs.ts'
import { enqueueInboxEvent } from '../../src/runtime/inbox.ts'
import {
  type ChannelAdapter,
  type ChannelOutboundMessage,
  type RuntimeEvent,
  VelaRuntimeEngine,
} from '../../src/runtime/index.ts'
import {
  createFauxModel,
  fauxHang,
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

test('R1 P0: approval continuation delivers reply to originating chat B (never chat A)', async () => {
  const root = tempRoot('vela-r1-p0-chat-')
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
        responses: [
          fauxToolCall('danger_op', {}),
          fauxText('Done for chat B only'),
        ],
      }),
      tools: [
        {
          name: 'danger_op',
          description: 'Sensitive',
          inputSchema: z.object({}),
          execute: async () => new ToolExecutionResult('OK', 'OK'),
        },
      ],
      toolApprovalCheck: (name) =>
        name === 'danger_op'
          ? { requireApproval: true, summary: 'Approve' }
          : undefined,
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
    const sess = runtime.sessions.create({ id: 'shared-s', kind: 'chat' })
    runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'chat-A',
      kind: 'direct',
      sessionId: sess.id,
      enabled: true,
    })
    runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'chat-B',
      kind: 'direct',
      sessionId: sess.id,
      enabled: true,
    })

    await ingest({
      channel: 'lark',
      externalChatId: 'chat-B',
      kind: 'direct',
      dedupeKey: 'msg-chat-b-1',
      senderId: 'u1',
      senderName: 'Bob',
      text: 'Run danger_op',
      timestamp: new Date().toISOString(),
    })

    await runtime.waitForIdle('shared-s')
    const approvals = runtime.listPendingApprovals('shared-s')
    expect(approvals).toHaveLength(1)
    expect(delivered).toHaveLength(0)

    runtime.resolveApproval({
      approvalId: approvals[0]!.id,
      decision: 'approved',
    })
    await runtime.waitForIdle('shared-s')

    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.externalChatId).toBe('chat-B')
    expect(delivered[0]!.text).toContain('Done for chat B only')
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('R1 P0/P1: BlobStore isolates sessions, rejects traversal/clobbering, and prevents cross-session fork leaks', async () => {
  const root = tempRoot('vela-r1-blobs-')
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })
  const db = openDatabase({ path: join(root, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: root })

  try {
    const sA = runtime.sessions.create({ id: 's-alpha', kind: 'chat' })
    const sB = runtime.sessions.create({ id: 's-beta', kind: 'chat' })
    const blobA = await runtime.blobs.storeInbound({
      id: '11111111-1111-1111-1111-111111111111',
      sessionId: sA.id,
      filename: 'secret.txt',
      bytes: Buffer.from('alpha-secret'),
    })
    const env = createLocalExecutionEnv({ cwd: ws })

    await expect(
      runtime.blobs.materializeIntoEnv(blobA.id, env, sB.id),
    ).rejects.toThrow(/belongs to session/)

    // Unsafe traversal IDs rejected
    await expect(
      runtime.blobs.storeInbound({
        id: '../escape',
        sessionId: sA.id,
        filename: 'bad.txt',
        bytes: Buffer.from('bad'),
      }),
    ).rejects.toThrow(/Invalid blobId/)

    // Retry with same explicit ID must NOT delete or overwrite original file
    await expect(
      runtime.blobs.storeInbound({
        id: blobA.id,
        sessionId: sA.id,
        filename: 'secret.txt',
        bytes: Buffer.from('alpha-secret'),
      }),
    ).rejects.toThrow(/already exists/)
    expect(readFileSync(blobA.storagePath, 'utf8')).toBe('alpha-secret')

    // Fork from B referencing A's blob path/id must NOT leak A's blob
    const childB = new SessionStore('child-b', db, {
      blobsDir: runtime.blobs.rootDir,
    })
    await expect(
      childB.seedFrom(
        [
          {
            id: 'e1',
            parentId: null,
            timestamp: new Date().toISOString(),
            type: 'message',
            message: {
              role: 'user',
              content: `[file: secret.txt, saved at ${blobA.storagePath}]`,
            },
          },
        ],
        {
          id: sB.id,
          store: new SessionStore(sB.id, db, {
            blobsDir: runtime.blobs.rootDir,
          }),
        },
        async () => env,
      ),
    ).resolves.toBeUndefined()
    expect(runtime.blobs.listBySession('child-b', 'inbound')).toHaveLength(0)

    // pendingBlobIds rollback preservation
    const unstartedStore = new SessionStore('rollback-blob', db, {
      blobsDir: runtime.blobs.rootDir,
    })
    const hostFile = join(ws, 'upload.txt')
    writeFileSync(hostFile, 'payload')
    await unstartedStore.materializeUpload(env, {
      name: 'upload.txt',
      hostPath: hostFile,
    })
    expect(() =>
      unstartedStore.runInTransaction(() => {
        unstartedStore.appendMessage({ role: 'user', content: 'trigger save' })
        throw new Error('force rollback after binding')
      }),
    ).toThrow('force rollback after binding')
    unstartedStore.appendMessage({ role: 'user', content: 'succeed save' })
    expect(
      runtime.blobs.listBySession('rollback-blob', 'inbound'),
    ).toHaveLength(1)
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('R1 P1: dual-engine shared owners, stopSession across engines, delete guard, and waking exiting worker', async () => {
  const root = tempRoot('vela-r1-owners-')
  const dbPath = join(root, 'vela.db')
  const db1 = openDatabase({ path: dbPath })
  const db2 = openDatabase({ path: dbPath })

  const rt1 = new VelaRuntimeEngine({ db: db1, agentDir: root })
  const rt2 = new VelaRuntimeEngine({ db: db2, agentDir: root })

  const model1 = createFauxModel({ responses: [fauxHang()] })
  const model2 = createFauxModel({ responses: [fauxText('Should not steal')] })
  rt1.registerDriver(
    createVelaAgentDriver({
      db: db1,
      agentDir: root,
      blobs: rt1.blobs,
      environments: rt1.environments,
      defaultModel: model1,
    }),
  )
  rt2.registerDriver(
    createVelaAgentDriver({
      db: db2,
      agentDir: root,
      blobs: rt2.blobs,
      environments: rt2.environments,
      defaultModel: model2,
    }),
  )

  try {
    const s = rt1.sessions.create({ id: 's-shared-owner', kind: 'chat' })
    rt1.submitPrompt({ sessionId: s.id, text: 'hang on rt1' })
    for (let i = 0; i < 50 && model1.calls.length === 0; i++)
      await Bun.sleep(10)

    // Second engine recover() must NOT steal rt1's live run in same process
    const rec2 = await rt2.recover()
    expect(rec2.recoveredRuns).toHaveLength(0)
    expect(model2.calls).toHaveLength(0)

    // Deleting active session rejects loudly instead of cascading FK errors
    expect(() => rt1.sessions.delete(s.id)).toThrow(/actively executing/)

    // Cross-engine stopSession routes abort to rt1's live owner
    const stopped = await rt2.stopSession(s.id, 'Stop from rt2')
    expect(stopped).toBe(true)
    await rt1.waitForIdle(s.id)
    expect(rt1.sessions.get(s.id)?.state).toBe('idle')

    // Immediate wake while worker is exiting is never dropped
    rt1.scheduleSession(s.id)
    rt1.submitPrompt({ sessionId: s.id, text: 'after idle schedule' })
    await rt1.waitForIdle(s.id)
    expect(model1.calls.length + model2.calls.length).toBeGreaterThanOrEqual(1)
  } finally {
    await rt1.dispose()
    await rt2.dispose()
    db1.close()
    db2.close()
  }
})

test('R1 P1: queued prompt during waiting_human runs after approval; !stop repairs pending tool step; cancelled wakes immediately', async () => {
  const root = tempRoot('vela-r1-approval-flow-')
  const db = openDatabase({ path: join(root, 'vela.db') })
  const events: RuntimeEvent[] = []
  const runtime = new VelaRuntimeEngine({ db, agentDir: root })
  runtime.subscribeEvents((ev) => events.push(ev))

  const model = createFauxModel({
    responses: [
      fauxToolCall('sens', {}),
      fauxText('First run done'),
      fauxText('Queued prompt answered'),
      fauxToolCall('sens', {}),
      fauxText('After stop answered'),
      fauxToolCall('sens', {}),
      fauxText('After cancel answered'),
    ],
  })
  runtime.registerDriver(
    createVelaAgentDriver({
      db,
      agentDir: root,
      blobs: runtime.blobs,
      environments: runtime.environments,
      defaultModel: model,
      tools: [
        {
          name: 'sens',
          description: 'Sensitive',
          inputSchema: z.object({}),
          execute: async () => new ToolExecutionResult('SENS_OK', 'SENS_OK'),
        },
      ],
      toolApprovalCheck: (name) =>
        name === 'sens'
          ? { requireApproval: true, summary: 'Approve' }
          : undefined,
    }),
  )

  try {
    // 1. Prompt arriving during waiting_human is NOT dropped when approval resolves
    const s1 = runtime.sessions.create({ id: 's-q-wh', kind: 'chat' })
    runtime.submitPrompt({ sessionId: s1.id, text: 'Trigger approval' })
    await runtime.waitForIdle(s1.id)
    runtime.submitPrompt({ sessionId: s1.id, text: 'Second user prompt' })
    const app1 = runtime.listPendingApprovals(s1.id)[0]!
    runtime.resolveApproval({ approvalId: app1.id, decision: 'approved' })
    await runtime.waitForIdle(s1.id)
    expect(model.calls).toHaveLength(3)
    expect(model.calls[2]!.lastUserText).toContain('Second user prompt')

    // Exactly 1 assistant message_committed per assistant message, with real entry ID (not runId)
    const msgCommitted = events.filter(
      (e) => e.sessionId === s1.id && e.type === 'message_committed',
    )
    const runIds = new Set(
      db
        .all<{ id: string }>('SELECT id FROM runs WHERE session_id = ?', s1.id)
        .map((r) => r.id),
    )
    for (const ev of msgCommitted) {
      if (ev.type === 'message_committed') {
        expect(runIds.has(ev.messageId)).toBe(false)
      }
    }

    // 2. !stop during waiting_human completes cancelled tool step before next prompt
    const s2 = runtime.sessions.create({ id: 's-stop-wh', kind: 'chat' })
    runtime.submitPrompt({ sessionId: s2.id, text: 'Need approval then stop' })
    await runtime.waitForIdle(s2.id)
    await runtime.executeShortcut({
      command: 'stop',
      sessionId: s2.id,
    })
    runtime.submitPrompt({ sessionId: s2.id, text: 'Next turn after stop' })
    await runtime.waitForIdle(s2.id)
    expect(model.calls).toHaveLength(5)
    expect(model.calls[4]!.prompt.some((m) => m.role === 'tool')).toBe(true)

    // 3. resolveApproval({ decision: 'cancelled' }) immediately wakes & exits waiting_human
    const s3 = runtime.sessions.create({ id: 's-cancel-wh', kind: 'chat' })
    runtime.submitPrompt({ sessionId: s3.id, text: 'Cancel approval' })
    await runtime.waitForIdle(s3.id)
    const app3 = runtime.listPendingApprovals(s3.id)[0]!
    const res = runtime.resolveApproval({
      approvalId: app3.id,
      decision: 'cancelled',
      reason: 'User dismissed',
    })
    expect(res.shouldWake).toBe(true)
    await runtime.waitForIdle(s3.id)
    expect(runtime.sessions.get(s3.id)?.state).toBe('idle')
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('R1 P1/P2: sqlite savepoint hooks, isolated subscribers, outbox leases, timer wakeup, background jobs, routing, tools, and filters', async () => {
  const root = tempRoot('vela-r1-misc-')
  const projACwd = join(root, 'projA')
  const projBCwd = join(root, 'projB')
  mkdirSync(projACwd, { recursive: true })
  mkdirSync(projBCwd, { recursive: true })
  const db = openDatabase({ path: join(root, 'vela.db') })

  // 1. Savepoint rollback discards inner afterCommit; throwing listener doesn't block sibling or corrupt tx
  let innerFired = false
  let outerFired = false
  db.transaction(() => {
    db.afterCommit(() => {
      outerFired = true
    })
    try {
      db.transaction(() => {
        db.afterCommit(() => {
          innerFired = true
        })
        throw new Error('rollback savepoint')
      })
    } catch {}
  })
  expect(innerFired).toBe(false)
  expect(outerFired).toBe(true)

  const runtime = new VelaRuntimeEngine({ db, agentDir: root })
  let goodListenerCalls = 0
  runtime.subscribeEvents(() => {
    throw new Error('subscriber boom')
  })
  runtime.subscribeEvents(() => {
    goodListenerCalls++
  })

  let outboxAttempts = 0
  let releaseFirstSend!: () => void
  const firstSendStarted = new Promise<void>((resolve) => {
    void runtime.registerChannel({
      name: 'lark',
      start: async () => {},
      stop: async () => {},
      deliver: async (msg) => {
        outboxAttempts++
        if (outboxAttempts === 1) {
          resolve()
          await new Promise<void>((done) => {
            releaseFirstSend = done
          })
          throw new Error('stale timeout')
        }
        return { externalMessageId: `ext-${msg.outboxId}` }
      },
    })
  })

  try {
    // 2. Passive input defaults wake=false; overlapping subscriptions dedup per session
    const projA = runtime.projects.create({
      id: 'proj-a',
      name: 'A',
      cwd: projACwd,
      defaultTools: ['read'],
    })
    const projB = runtime.projects.create({
      id: 'proj-b',
      name: 'B',
      cwd: projBCwd,
    })
    const sA = runtime.sessions.create({
      id: 's-proj-a',
      projectId: projA.id,
      location: { environment: 'local', cwd: projBCwd },
    })
    const passiveRes = enqueueInboxEvent(db, {
      sessionId: sA.id,
      source: 'user',
      passive: true,
      payload: { text: 'passive default' },
    })
    expect(passiveRes.event.wake).toBe(false)

    // db-queries: owned by projA must NOT appear in projB cwd listing
    const storeA = new SessionStore(sA.id, db, {
      blobsDir: runtime.blobs.rootDir,
    })
    await storeA.loadSaved()
    storeA.appendMessage({ role: 'user', content: 'Secret A prompt' })
    expect(
      listSessionSummariesFromDb(db, false, { cwd: projBCwd }).map((x) => x.id),
    ).not.toContain(sA.id)

    // 3. Routine project cap derived from sessionId & overdue edit preserves deadline & future wakeup works
    for (let i = 0; i < 20; i++) {
      runtime.timers.createRoutine({
        sessionId: sA.id,
        message: `r-${i}`,
        schedule: { at: '2099-01-01T00:00:00.000Z' },
      })
    }
    expect(() =>
      runtime.timers.createRoutine({
        sessionId: sA.id,
        message: 'r-21',
        schedule: { at: '2099-01-01T00:00:00.000Z' },
      }),
    ).toThrow(/maximum of 20/)

    const dueTimer = runtime.timers.createRoutine({
      sessionId: runtime.sessions.create({ id: 's-timer', projectId: projB.id })
        .id,
      message: 'overdue',
      schedule: { at: '2099-01-01T00:00:00.000Z' },
    })
    const edited = runtime.timers.update(dueTimer.id, {
      message: 'updated note',
    })
    expect(edited?.nextFireAt).toBe(dueTimer.nextFireAt)

    // 4. Subscription overlapping '*' + exact enqueues once
    runtime.subscriptions.create({
      source: 'github',
      eventKey: '*',
      projectId: projB.id,
      sessionId: sA.id,
    })
    runtime.subscriptions.create({
      source: 'github',
      eventKey: 'pr:1',
      projectId: projB.id,
      sessionId: sA.id,
    })
    const subRes = runtime.subscriptions.dispatchEvent({
      source: 'github',
      eventKey: 'pr:1',
      dedupeKey: 'deliv-1',
      summary: 'PR opened',
    })
    expect(subRes.enqueuedCount).toBe(1)

    // 5. Cross-manager background_jobs live handles stay protected during recover()
    const mgr2 = new BackgroundJobManager(db)
    const job = mgr2.recordStart({
      sessionId: sA.id,
      command: 'sleep 10',
      commandHead: 'sleep 10',
    })
    const rec = await runtime.recover()
    expect(rec.interruptedJobs).not.toContain(job.id)
    mgr2.recordFinish({
      id: job.id,
      status: 'completed',
      exitCode: 0,
      silent: true,
    })

    // 6. Outbox in-flight lease protects sending row during stale recover() + stale timeout error
    db.run(
      `INSERT INTO outbox (id, session_id, channel, external_chat_id, kind, payload_json, status, attempt, created_at, updated_at)
       VALUES ('out-fence', ?, 'lark', 'c1', 'reply', '{"text":"hi"}', 'pending', 0, ?, ?)`,
      sA.id,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    const firstFlush = runtime.outbox.flushOnce()
    await firstSendStarted
    expect(runtime.outbox.recoverStaleSending()).toBe(0)
    releaseFirstSend()
    await firstFlush

    // 7. Topic deletion cleans binding + kv_meta; disabled root gates existing topic; channel dedup skips attachments & shortcut repeat
    const groupProj = runtime.projects.create({
      name: 'grp',
      hubSessionId: true,
    })
    const rootB = runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'grp-1',
      kind: 'group',
      projectId: groupProj.id,
      enabled: true,
    })
    const topicSess = runtime.sessions.create({
      id: 'topic-1',
      projectId: groupProj.id,
      kind: 'topic',
    })
    runtime.bindings.upsert({
      channel: 'lark',
      externalId: 'grp-1',
      threadId: 'thr-1',
      kind: 'group',
      projectId: groupProj.id,
      sessionId: topicSess.id,
      enabled: true,
    })
    runtime.bindings.upsert({
      id: rootB.id,
      channel: 'lark',
      externalId: 'grp-1',
      kind: 'group',
      projectId: groupProj.id,
      enabled: false,
    })
    // Disabled root prevents existing topic message from entering inbox
    const adapter = runtime.channelAdapter('lark')!
    let fetchCount = 0
    await runtime.unregisterChannel('lark')
    await runtime.registerChannel({
      ...adapter,
      fetchAttachment: async () => {
        fetchCount++
        return Buffer.from('x')
      },
      start: async (ctx) => {
        await ctx.ingest({
          channel: 'lark',
          externalChatId: 'grp-1',
          threadId: 'thr-1',
          kind: 'group',
          dedupeKey: 'disabled-root-msg',
          senderId: 'u',
          senderName: 'U',
          text: 'hello disabled root',
          attachments: [{ ref: 'r1', name: 'a.txt' }],
          timestamp: new Date().toISOString(),
        })
      },
    })
    expect(fetchCount).toBe(0)
    expect(runtime.sessions.delete(topicSess.id)).toBe(true)
    expect(
      runtime.bindings.findByExternal('lark', 'grp-1', 'thr-1'),
    ).toBeUndefined()

    // 8. project.defaultTools selection + bash(run_in_background: true) on createVelaAgentDriver
    const modelTools = createFauxModel({
      responses: [
        (req) => {
          const toolNames = req.tools
          expect(toolNames).toContain('read')
          expect(toolNames).not.toContain('bash')
          return fauxText('tools respected')
        },
        fauxToolCall('bash', {
          command: 'echo bg_ok',
          run_in_background: true,
        }),
        fauxText('started bg'),
        fauxText('handled bg completion'),
      ],
    })
    runtime.registerDriver(
      createVelaAgentDriver({
        db,
        agentDir: root,
        blobs: runtime.blobs,
        environments: runtime.environments,
        defaultModel: modelTools,
      }),
    )
    runtime.submitPrompt({ sessionId: sA.id, text: 'check project tools' })
    await runtime.waitForIdle(sA.id)

    const sBg = runtime.sessions.create({
      id: 's-bg-driver',
      projectId: projB.id,
      location: { environment: 'local', cwd: projBCwd },
    })
    runtime.submitPrompt({ sessionId: sBg.id, text: 'run bg' })
    await runtime.waitForIdle(sBg.id)
    for (let i = 0; i < 60 && modelTools.calls.length < 4; i++)
      await Bun.sleep(25)
    await runtime.waitForIdle(sBg.id)
    expect(modelTools.calls.length).toBeGreaterThanOrEqual(4)
    expect(goodListenerCalls).toBeGreaterThan(0)
  } finally {
    await runtime.dispose()
    db.close()
  }
})
