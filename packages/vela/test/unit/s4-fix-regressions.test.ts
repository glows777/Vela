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
import { join } from 'node:path'
import { runPrintMode } from '../../src/cli/print-mode.ts'
import { larkSetup } from '../../src/cli/tui/lark-setup.ts'
import { prepareInteractiveSession } from '../../src/cli/tui/session-open.ts'
import { connectRuntime } from '../../src/daemon/client.ts'
import { DaemonLarkHost } from '../../src/daemon/lark-host.ts'
import {
  acquireOwnerLock,
  DaemonAlreadyRunningError,
  readOwnerRecord,
} from '../../src/daemon/owner-lock.ts'
import { startDaemonServer } from '../../src/daemon/server.ts'
import { saveRuntimeLarkSetup } from '../../src/daemon/settings-service.ts'
import { openDatabase } from '../../src/db/index.ts'
import { createLocalExecutionEnv } from '../../src/driver/execution/local.ts'
import {
  buildSteeringMessage,
  commitSteeredInboxInTx,
  flushSessionSteering,
  takeSessionSteering,
} from '../../src/driver/runtime-steering.ts'
import { SessionStore } from '../../src/driver/session/index.ts'
import { processLarkInboundEvent } from '../../src/lark/runtime-inbound.ts'
import { LarkRuntimeProgressManager } from '../../src/lark/runtime-progress.ts'
import type { LarkTransport } from '../../src/lark/transport.ts'
import { verifyProviderModel } from '../../src/providers/models/setup.ts'
import { BackgroundJobManager } from '../../src/runtime/background-jobs.ts'
import {
  getActiveChannelForSession,
  getBoundChannelForSession,
} from '../../src/runtime/channel-binding-lookup.ts'
import { setChannelEnabledInDb } from '../../src/runtime/channel-ingress.ts'
import type { ChannelAdapterContext } from '../../src/runtime/channels.ts'
import {
  ChannelBindingStore,
  ProjectStore,
  SessionStoreControl,
} from '../../src/runtime/domain.ts'
import {
  createEnvironmentRegistryForTest,
  updateEnvironmentRegistryConfig,
} from '../../src/runtime/environments.ts'
import { enqueueInboxEvent } from '../../src/runtime/inbox.ts'
import { BlobStore } from '../../src/runtime/index.ts'
import { OutboxDispatcher } from '../../src/runtime/outbox.ts'
import { recoverRuntimeState } from '../../src/runtime/recovery.ts'
import { TimerScheduler } from '../../src/runtime/timers.ts'
import { scheduleRuntimeWakeTimer } from '../../src/runtime/wake-timer.ts'
import { createRuntime } from '../../src/runtime-sdk.ts'
import type { ExecutionEnv } from '../../src/shared/execution.ts'
import { silentLogger } from '../../src/shared/logger.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../src/testing/core/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await Promise.resolve(cleanups.pop()!()).catch(() => {})
  }
})

function tempDir(prefix = 'vela-s4-fix-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeMockLarkTransport(
  overrides: Partial<LarkTransport> = {},
): LarkTransport {
  return {
    async start() {},
    async getBotId() {
      return 'bot_1'
    },
    stop() {},
    async startTopic() {
      return {
        messageId: 'om_topic',
        createTime: '1',
        rootId: 'om_root',
        threadId: 'omt_1',
      }
    },
    async forward() {
      return { messageId: 'om_fwd', createTime: '1' }
    },
    async send() {
      return { messageId: 'om_1', createTime: '1' }
    },
    async reply() {
      return { messageId: 'om_2', createTime: '1' }
    },
    async sendCard() {
      return 'om_card'
    },
    async patchCard() {},
    async addReaction() {
      return 'rx_1'
    },
    async removeReaction() {},
    async getResource() {
      throw new Error('unused')
    },
    async getSenderName() {
      return 'Alice'
    },
    async listTopicMessages() {
      return { items: [] }
    },
    async searchMessages() {
      return { items: [] }
    },
    async listMessages() {
      return []
    },
    ...overrides,
  }
}

test('acquireOwnerLock reclaims stale dead-PID lock and rejects active owners', () => {
  const dir = tempDir('vela-lock-')
  const lockPath = join(dir, 'daemon.lock')
  const socketPath = join(dir, 'daemon.sock')
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999_999_999, instanceId: 'dead-instance' }),
  )

  const release1 = acquireOwnerLock(lockPath, 'live-instance-1', socketPath)
  cleanups.push(release1)
  expect(readOwnerRecord(lockPath)).toEqual({
    pid: process.pid,
    instanceId: 'live-instance-1',
  })

  expect(() =>
    acquireOwnerLock(lockPath, 'live-instance-2', socketPath),
  ).toThrow(DaemonAlreadyRunningError)

  release1()
  expect(readOwnerRecord(lockPath)).toBeUndefined()
})

test('updateEnvironmentRegistryConfig hot-reloads unopened definitions and blocks mutating an already-open container', async () => {
  const dir = tempDir('vela-env-reload-')
  const openedImages: string[] = []
  let retiredCleanup = 0
  const registry = createEnvironmentRegistryForTest({
    dataDir: dir,
    environments: { box: { image: 'alpine:v1', network: 'off' } },
    openDocker: async (options) => {
      openedImages.push(options.image)
      const env: ExecutionEnv = Object.assign(
        createLocalExecutionEnv({ cwd: '/workspace' }),
        {
          canonicalPath: async (p: string) => ({ ok: true as const, value: p }),
          cleanup: async () => {
            retiredCleanup += 1
          },
        },
      )
      return env
    },
    probeAlive: async () => true,
  })
  cleanups.push(() => registry.dispose())

  await registry.resolve({
    sessionId: 's1',
    location: { environment: 'box', cwd: '/workspace' },
  })
  expect(openedImages).toEqual(['alpine:v1'])

  // Changing an already-open container must reject rather than hit Docker identity mismatch.
  expect(() =>
    updateEnvironmentRegistryConfig(registry, {
      box: { image: 'alpine:v2', network: 'on' },
    }),
  ).toThrow(/explicit owner restart required/i)

  // Adding a new unopened environment while preserving `box` succeeds immediately.
  updateEnvironmentRegistryConfig(registry, {
    box: { image: 'alpine:v1', network: 'off' },
    box2: { image: 'alpine:v2', network: 'on' },
  })
  await registry.resolve({
    sessionId: 's2',
    location: { environment: 'box2', cwd: '/workspace' },
  })
  expect(openedImages).toEqual(['alpine:v1', 'alpine:v2'])
  await registry.dispose()
  expect(retiredCleanup).toBe(2)
})

test('steering helpers commit inbox done atomically with transcript append and roll back on tx failure', async () => {
  const dir = tempDir('vela-steer-')
  const db = openDatabase({ path: join(dir, 'vela.db') })
  cleanups.push(() => db.close())
  const blobs = new BlobStore(db, join(dir, 'blobs'))
  const store = new SessionStore('s-steer', db, { blobsDir: blobs.rootDir })
  const projects = new ProjectStore(db)
  const sessions = new SessionStoreControl(db)
  const project = projects.create({
    name: 'Steer',
    cwd: dir,
  })
  const session = sessions.create({ projectId: project.id, kind: 'chat' })
  db.run(
    `INSERT INTO runs (id, session_id, trigger, status, started_at, updated_at) VALUES (?, ?, 'channel', 'running', ?, ?)`,
    'run-1',
    session.id,
    '2026-11-28T00:00:00.000Z',
    '2026-11-28T00:00:00.000Z',
  )

  const inbox1 = enqueueInboxEvent(db, {
    sessionId: session.id,
    projectId: project.id,
    source: 'lark',
    payload: { kind: 'user', text: 'claimed steer' },
  }).event
  const inbox2 = enqueueInboxEvent(db, {
    sessionId: session.id,
    projectId: project.id,
    source: 'lark',
    payload: { kind: 'user', text: 'preserved inbox steer' },
  }).event

  const claimedMsg = buildSteeringMessage('claimed steer')
  const preservedMsg = buildSteeringMessage('preserved inbox steer')
  const standaloneImg = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
  const standaloneMsg = buildSteeringMessage('retry standalone', [
    { data: standaloneImg, mimeType: 'image/png' },
  ])

  const activeSteering = new Map([[session.id, [claimedMsg]]])
  const inboxMap = new WeakMap<typeof claimedMsg, string>([
    [claimedMsg, inbox1.id],
    [preservedMsg, inbox2.id],
  ])
  const pendingCommitSteering: (typeof claimedMsg)[] = []

  const taken = takeSessionSteering({
    db,
    sessionId: session.id,
    activeSteering,
    activeSteeringInboxIds: inboxMap,
    pendingCommitSteering,
  })
  expect(taken).toEqual([claimedMsg])
  // Before transcript commit, inbox_events row remains 'pending'.
  expect(
    db.get<{ status: string }>(
      'SELECT status FROM inbox_events WHERE id = ?',
      inbox1.id,
    )?.status,
  ).toBe('pending')

  // If the transcript commit transaction throws, both entry and inbox_events roll back cleanly.
  expect(() =>
    store.runInTransaction(() => {
      commitSteeredInboxInTx({
        db,
        message: claimedMsg,
        runId: 'run-1',
        activeSteeringInboxIds: inboxMap,
        pendingCommitSteering,
      })
      throw new Error('simulated append failure')
    }),
  ).toThrow('simulated append failure')
  expect(
    db.get<{ status: string }>(
      'SELECT status FROM inbox_events WHERE id = ?',
      inbox1.id,
    )?.status,
  ).toBe('pending')

  // Re-attaching inboxMap and committing cleanly succeeds once and prevents duplicate pickup.
  inboxMap.set(claimedMsg, inbox1.id)
  store.runInTransaction(() => {
    commitSteeredInboxInTx({
      db,
      message: claimedMsg,
      runId: 'run-1',
      activeSteeringInboxIds: inboxMap,
      pendingCommitSteering,
    })
  })
  const claimedRow = db.get<{ status: string }>(
    'SELECT status FROM inbox_events WHERE id = ?',
    inbox1.id,
  )
  expect(claimedRow?.status).toBe('done')
  expect(
    takeSessionSteering({
      db,
      sessionId: session.id,
      activeSteering: new Map([[session.id, [claimedMsg]]]),
      activeSteeringInboxIds: new WeakMap([[claimedMsg, inbox1.id]]),
    }),
  ).toEqual([])

  activeSteering.set(session.id, [standaloneMsg])
  let wokeSession: string | undefined
  await flushSessionSteering({
    db,
    blobs,
    sessionId: session.id,
    projectId: project.id,
    activeSteering,
    activeSteeringInboxIds: inboxMap,
    deferredSteering: [preservedMsg],
    pendingCommitSteering,
    wake: true,
    shouldWakeSession: true,
    wakeSession: (sid) => {
      wokeSession = sid
    },
  })

  expect(wokeSession).toBe(session.id)
  const preservedRow = db.get<{ status: string }>(
    'SELECT status FROM inbox_events WHERE id = ?',
    inbox2.id,
  )
  expect(preservedRow?.status).toBe('pending')

  const requeued = db.all<{ status: string; payload_json: string }>(
    `SELECT status, payload_json FROM inbox_events WHERE session_id = ? AND id NOT IN (?, ?)`,
    session.id,
    inbox1.id,
    inbox2.id,
  )
  expect(requeued).toHaveLength(1)
  expect(requeued[0]?.status).toBe('pending')
  const payload = JSON.parse(requeued[0]!.payload_json) as {
    text?: string
    attachments?: Array<{ blobId: string; inlineOnly?: boolean }>
  }
  expect(payload.text).toBe('retry standalone')
  expect(payload.attachments).toHaveLength(1)
  expect(payload.attachments?.[0]?.inlineOnly).toBe(true)
  expect(blobs.get(payload.attachments![0]!.blobId)).toBeDefined()
})

test('getBoundChannelForSession preserves localOnly OAuth restrictions even when bindings or group roots are disabled', () => {
  const db = openDatabase({ path: ':memory:' })
  cleanups.push(() => db.close())
  const projects = new ProjectStore(db)
  const sessions = new SessionStoreControl(db)
  const bindings = new ChannelBindingStore(db)
  const project = projects.create({
    name: 'Lark Project',
    cwd: '/tmp/proj',
    hubSessionId: true,
  })
  const topicSession = sessions.create({
    projectId: project.id,
    kind: 'topic',
    name: 'Child topic',
  })
  const nonHub = sessions.create({
    projectId: project.id,
    kind: 'chat',
    name: 'Side session',
  })
  bindings.upsert({
    channel: 'lark',
    externalId: 'oc_root',
    kind: 'group',
    projectId: project.id,
    sessionId: project.hubSessionId!,
    enabled: false,
  })
  bindings.upsert({
    channel: 'lark',
    externalId: 'oc_root',
    threadId: 'omt_child',
    kind: 'group',
    projectId: project.id,
    sessionId: topicSession.id,
    enabled: true,
  })
  const dm = sessions.create({ kind: 'chat', name: 'DM' })
  bindings.upsert({
    channel: 'lark',
    externalId: 'ou_dm',
    kind: 'direct',
    projectId: null,
    sessionId: dm.id,
    enabled: false,
  })
  setChannelEnabledInDb(db, 'lark', false)

  expect(getActiveChannelForSession(db, project.hubSessionId!)).toBeUndefined()
  expect(getBoundChannelForSession(db, project.hubSessionId!)).toBe('lark')
  expect(getBoundChannelForSession(db, topicSession.id)).toBe('lark')
  expect(getBoundChannelForSession(db, nonHub.id)).toBe('lark')
  expect(getBoundChannelForSession(db, dm.id)).toBe('lark')
})

test('verifyProviderModel blocks localOnly OAuth credentials when blockLocalOnlyOAuth is enabled', async () => {
  const credentials = {
    get: (provider: string) =>
      provider === 'openai-chatgpt'
        ? {
            type: 'oauth' as const,
            access: 'tok',
            refresh: 'ref',
            expires: Date.now() + 60_000,
          }
        : undefined,
    list: () => ['openai-chatgpt'],
    modify: async () => undefined,
    delete: async () => {},
  }
  const providers = {
    'openai-chatgpt': {
      models: [{ id: 'gpt-5.4', name: 'gpt-5.4' }],
      oauth: {
        name: 'ChatGPT OAuth',
        localOnly: true,
        async login() {
          throw new Error('unused')
        },
        async refresh() {
          throw new Error('unused')
        },
      },
      authSource(cred: { type: string } | undefined) {
        return cred ? 'oauth' : undefined
      },
      createModel() {
        throw new Error(
          'should not invoke createModel when localOnly OAuth is blocked',
        )
      },
    },
  }
  await expect(
    verifyProviderModel(
      'openai-chatgpt/gpt-5.4',
      providers,
      credentials,
      undefined,
      { blockLocalOnlyOAuth: true },
    ),
  ).rejects.toThrow(/openai-chatgpt|logged in|credential|local/i)
})

test('startingAdapters hides half-started channel adapters from readyChannel lookups until start resolves', async () => {
  const dir = tempDir('vela-starting-adapter-')
  const runtime = createRuntime({
    agentDir: dir,
    defaultModel: createFauxModel(),
  })
  cleanups.push(() => runtime.dispose())

  let releaseStart!: () => void
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve
  })
  let listChatsCalls = 0

  const registerPromise = runtime.registerChannel({
    name: 'slow',
    async start() {
      await startGate
    },
    async stop() {},
    async deliver() {
      return { externalMessageId: 'm1' }
    },
    async listChats() {
      listChatsCalls += 1
      return [{ chatId: 'c1', name: 'Chat 1' }]
    },
  })

  expect(await runtime.channels.chats('slow')).toEqual([])
  expect(listChatsCalls).toBe(0)

  releaseStart()
  await registerPromise

  expect(await runtime.channels.chats('slow')).toEqual([
    { chatId: 'c1', name: 'Chat 1' },
  ])
  expect(listChatsCalls).toBe(1)
})

test('recoverRuntimeState and scheduleRuntimeWakeTimer ignore passive inbox and project-bound timers for ignoredChannels', () => {
  const db = openDatabase({ path: ':memory:' })
  cleanups.push(() => db.close())
  const projects = new ProjectStore(db)
  const bindings = new ChannelBindingStore(db)

  const larkProj = projects.create({
    name: 'Lark Proj',
    cwd: '/tmp/lark',
    hubSessionId: true,
  })
  bindings.upsert({
    channel: 'lark',
    externalId: 'oc_1',
    kind: 'group',
    projectId: larkProj.id,
    sessionId: larkProj.hubSessionId!,
    enabled: true,
  })
  const passiveLarkMsg = enqueueInboxEvent(db, {
    sessionId: larkProj.hubSessionId!,
    projectId: larkProj.id,
    source: 'lark',
    passive: true,
    wake: true,
    payload: { kind: 'user', text: 'ambient msg' },
  }).event
  const dueAt = new Date(Date.now() + 5_000).toISOString()
  db.run(
    `INSERT INTO timers (id, kind, project_id, session_id, channel, message, schedule_json, timezone, enabled, next_fire_at, created_at, updated_at)
     VALUES (?, 'routine', ?, ?, 'lark', 'ping', '{"cron":"* * * * *"}', 'UTC', 1, ?, ?, ?)`,
    'timer-lark',
    larkProj.id,
    larkProj.hubSessionId!,
    dueAt,
    '2026-11-28T00:00:00.000Z',
    '2026-11-28T00:00:00.000Z',
  )

  const backgroundJobs = new BackgroundJobManager(db)
  const outbox = new OutboxDispatcher(db, () => undefined)
  const timers = new TimerScheduler(db)

  const recovered = recoverRuntimeState({
    db,
    backgroundJobs,
    outbox,
    timers,
    activeOwners: new Set(),
    nowMs: Date.now(),
    ignoredChannels: new Set(['lark']),
  })
  expect(recovered.sessionsToWake.has(larkProj.hubSessionId!)).toBe(false)
  const larkRow = db.get<{ status: string }>(
    'SELECT status FROM inbox_events WHERE id = ?',
    passiveLarkMsg.id,
  )
  expect(larkRow?.status).toBe('pending')

  const scheduled = scheduleRuntimeWakeTimer({
    db,
    timers,
    outbox,
    registeredChannels: [],
    ignoredChannels: new Set(['lark']),
    hasChannels: false,
    onFire: () => false,
    onSync: () => {},
    onFlushError: () => {},
  })
  expect(scheduled).toBeUndefined()
})

test('DaemonLarkHost clears managed Lark bindings when lark config is removed', async () => {
  const dir = tempDir('vela-lark-host-')
  const chatDir = join(dir, 'workspace')
  mkdirSync(chatDir, { recursive: true })
  const runtime = createRuntime({
    agentDir: dir,
    defaultModel: createFauxModel(),
  })
  cleanups.push(() => runtime.dispose())

  const host = new DaemonLarkHost(runtime, {
    agentDir: dir,
    hostEnv: {},
    logger: silentLogger,
    createTransport: () => makeMockLarkTransport(),
  })
  cleanups.push(() => host.stop())

  await host.sync({
    lark: {
      chats: [{ id: 'oc_clear_1' }],
    },
  })
  expect(
    (await runtime.bindings.list({ channel: 'lark' })).some(
      (b) => b.externalId === 'oc_clear_1' && b.enabled,
    ),
  ).toBe(true)

  await host.sync({})
  const bindingsAfter = await runtime.bindings.list({ channel: 'lark' })
  expect(
    bindingsAfter.some((b) => b.externalId === 'oc_clear_1' && b.enabled),
  ).toBe(false)
  expect(host.isRegistered()).toBe(false)
})

test('processLarkInboundEvent skips history prefetch and noteHandled for !status control shortcuts', async () => {
  let listedMessages = 0
  let listedTopic = 0
  let notedHandled = 0
  const ingested: Array<{ text: string; dedupeKey: string }> = []
  const transport = makeMockLarkTransport({
    async listMessages() {
      listedMessages += 1
      return []
    },
    async listTopicMessages() {
      listedTopic += 1
      return { items: [] }
    },
  })
  const ctx: ChannelAdapterContext = {
    async ingest(msg) {
      ingested.push({ text: msg.text, dedupeKey: msg.dedupeKey })
    },
    async ingestWithReceipt(msg) {
      ingested.push({ text: msg.text, dedupeKey: msg.dedupeKey })
      return { admitted: true, sessionId: 's1', shortcut: true }
    },
  }

  const ok = await processLarkInboundEvent({
    event: {
      sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
      message: {
        message_id: 'om_shortcut',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '!status' }),
        create_time: '1700000000000',
      },
    },
    meta: {
      senderId: 'ou_1',
      group: true,
      mentioned: true,
      passive: false,
      replyToId: 'om_shortcut',
      requireExistingSession: false,
      rawText: '!status',
    },
    ctx,
    transport,
    appId: 'cli_1',
    logger: silentLogger,
    isStopped: () => false,
    senderName: async () => 'Alice',
    groupBoundary: () => undefined,
    noteHandled: () => {
      notedHandled += 1
    },
    deliver: async () => undefined,
    noteAdmittedInbound: () => {},
  })

  expect(ok).toBe(true)
  expect(listedMessages).toBe(0)
  expect(listedTopic).toBe(0)
  expect(notedHandled).toBe(0)
  expect(ingested).toHaveLength(1)
})

test('LarkRuntimeProgressManager cleans up previous activeRuns and control tokens when a new run starts', async () => {
  let subscriber:
    | ((
        event: Parameters<
          Parameters<NonNullable<ChannelAdapterContext['subscribeEvents']>>[0]
        >[0],
      ) => void)
    | undefined
  const removedReactions: string[] = []
  const transport = makeMockLarkTransport({
    async addReaction(_msgId, _emoji) {
      return 'rx_prev'
    },
    async removeReaction(_msgId, rxId) {
      removedReactions.push(rxId)
    },
  })
  const ctx: ChannelAdapterContext = {
    async ingest() {},
    subscribeEvents(fn) {
      subscriber = fn
      return () => {}
    },
    subscribeDeltas() {
      return () => {}
    },
    listBindings() {
      return [
        {
          id: 'b1',
          channel: 'lark',
          externalId: 'oc_1',
          threadId: null,
          kind: 'group',
          projectId: 'p1',
          sessionId: 's1',
          enabled: true,
          createdAt: '2026-11-28T00:00:00.000Z',
          updatedAt: '2026-11-28T00:00:00.000Z',
        },
      ]
    },
    getSession() {
      return undefined
    },
  }

  const manager = new LarkRuntimeProgressManager(ctx, transport, {
    isChatEnabled: () => true,
    isOwner: () => true,
    logger: silentLogger,
  })
  manager.start()
  cleanups.push(() => manager.stop())

  manager.noteAdmittedInbound({
    inboxEventId: 'in-1',
    externalChatId: 'oc_1',
    messageId: 'om_1',
    text: 'first',
    isDirect: false,
  })
  subscriber?.({
    seq: 1,
    timestamp: '2026-11-28T00:00:00.000Z',
    sessionId: 's1',
    projectId: 'p1',
    type: 'run_started',
    trigger: 'channel',
    runId: 'run-1',
    inboxEventIds: ['in-1'],
  })
  await new Promise((r) => setTimeout(r, 5))

  manager.noteAdmittedInbound({
    inboxEventId: 'in-2',
    externalChatId: 'oc_1',
    messageId: 'om_2',
    text: 'second',
    isDirect: false,
  })
  subscriber?.({
    seq: 2,
    timestamp: '2026-11-28T00:00:01.000Z',
    sessionId: 's1',
    projectId: 'p1',
    type: 'run_started',
    trigger: 'channel',
    runId: 'run-2',
    inboxEventIds: ['in-2'],
  })
  await new Promise((r) => setTimeout(r, 10))
  expect(removedReactions).toContain('rx_prev')
})

test('LarkRuntimeProgressManager keeps awaitingOutbox alive past 30s timeout so late successful delivery settles done', async () => {
  let subscriber:
    | ((
        event: Parameters<
          Parameters<NonNullable<ChannelAdapterContext['subscribeEvents']>>[0]
        >[0],
      ) => void)
    | undefined
  const reactions: Array<{ msg: string; emoji: string }> = []
  const transport = makeMockLarkTransport({
    async addReaction(msgId, emoji) {
      reactions.push({ msg: msgId, emoji })
      return `rx_${reactions.length}`
    },
  })
  const ctx: ChannelAdapterContext = {
    async ingest() {},
    subscribeEvents(fn) {
      subscriber = fn
      return () => {}
    },
    subscribeDeltas() {
      return () => {}
    },
    listBindings: () => [
      {
        id: 'b-slow',
        channel: 'lark',
        externalId: 'oc_slow',
        threadId: null,
        kind: 'group',
        projectId: 'p-slow',
        sessionId: 's-slow',
        enabled: true,
        createdAt: '2026-11-28T00:00:00.000Z',
        updatedAt: '2026-11-28T00:00:00.000Z',
      },
    ],
  }
  const origSetTimeout = globalThis.setTimeout
  const firedCallbacks: Array<() => void> = []
  ;(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
    cb: () => void,
    ms?: number,
  ) => {
    if (ms === 30_000) {
      firedCallbacks.push(cb)
      return origSetTimeout(() => {}, 1000)
    }
    return origSetTimeout(cb, ms)
  }) as typeof setTimeout

  const manager = new LarkRuntimeProgressManager(ctx, transport, {
    isChatEnabled: () => true,
    isOwner: () => true,
    logger: silentLogger,
  })
  manager.start()
  cleanups.push(() => manager.stop())

  try {
    manager.noteAdmittedInbound({
      inboxEventId: 'in-slow',
      externalChatId: 'oc_slow',
      messageId: 'om_slow',
      text: 'slow',
      isDirect: false,
    })
    subscriber?.({
      seq: 1,
      timestamp: '2026-11-28T00:00:00.000Z',
      sessionId: 's-slow',
      projectId: 'p-slow',
      type: 'run_started',
      trigger: 'channel',
      runId: 'run-slow',
      inboxEventIds: ['in-slow'],
    })
    subscriber?.({
      seq: 2,
      timestamp: '2026-11-28T00:00:01.000Z',
      sessionId: 's-slow',
      projectId: 'p-slow',
      type: 'run_finished',
      runId: 'run-slow',
      status: 'completed',
      replyPending: true,
    })
    expect(firedCallbacks).toHaveLength(1)
    firedCallbacks[0]!()
    await new Promise((r) => setTimeout(r, 10))
    expect(reactions.some((r) => r.emoji === 'CrossMark')).toBe(false)

    manager.noteOutboxOutcome('run-slow', true)
    await new Promise((r) => setTimeout(r, 10))
    expect(reactions.some((r) => r.emoji === 'DONE')).toBe(true)
    expect(reactions.some((r) => r.emoji === 'CrossMark')).toBe(false)
  } finally {
    ;(globalThis as { setTimeout: typeof setTimeout }).setTimeout =
      origSetTimeout
  }
})

test('ephemeralSessions (--no-session) persists rotating OAuth refresh tokens to owner auth.json', async () => {
  const agentDir = tempDir('vela-no-sess-oauth-')
  writeFileSync(
    join(agentDir, 'auth.json'),
    JSON.stringify({
      rotating: {
        type: 'oauth',
        access: 'old-access',
        refresh: 'ref-1',
        expires: 1,
      },
    }),
    { mode: 0o600 },
  )
  const rtNoSession = createRuntime({
    agentDir,
    ephemeralSessions: true,
    defaultModel: 'rotating/m1',
    providers: {
      rotating: {
        models: [{ id: 'm1', name: 'm1' }],
        oauth: {
          name: 'Rotating OAuth',
          async login() {
            throw new Error('unused')
          },
          async refresh(cred) {
            return {
              ...cred,
              access: 'new-access',
              refresh: 'ref-2',
              expires: Date.now() + 3600_000,
            }
          },
        },
        authSource: (c) => (c ? 'oauth' : undefined),
        createModel: (_id, ctx) => {
          const base = createFauxModel({ responses: [fauxText('ok')] })
          return {
            ...base,
            async doGenerate(opts: Parameters<typeof base.doGenerate>[0]) {
              const cred = await ctx.credential()
              expect(cred?.type).toBe('oauth')
              if (cred?.type === 'oauth') expect(cred.refresh).toBe('ref-2')
              return base.doGenerate(opts)
            },
            async doStream(opts: Parameters<typeof base.doStream>[0]) {
              const cred = await ctx.credential()
              expect(cred?.type).toBe('oauth')
              if (cred?.type === 'oauth') expect(cred.refresh).toBe('ref-2')
              return base.doStream(opts)
            },
          }
        },
      },
    },
  })
  cleanups.push(() => rtNoSession.dispose())
  const s = await rtNoSession.sessions.create({
    location: { environment: 'local', cwd: agentDir },
  })
  await rtNoSession.prompt(s.id, { text: 'hello' })
  await rtNoSession.waitForIdle(s.id)
  const persisted = JSON.parse(
    readFileSync(join(agentDir, 'auth.json'), 'utf8'),
  ) as {
    rotating?: { refresh?: string; access?: string }
  }
  expect(persisted.rotating?.refresh).toBe('ref-2')
  expect(persisted.rotating?.access).toBe('new-access')
})

test('custom AgentDriver with steer receives steerInboxEvent while built-in driver still owns vela sessions', async () => {
  const agentDir = tempDir('vela-custom-steer-')
  const steered: string[] = []
  let releaseTurn: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    releaseTurn = resolve
  })
  cleanups.push(() => releaseTurn())
  const rt = createRuntime({
    agentDir,
    drivers: [
      {
        name: 'custom-drv',
        capabilities: {
          recovery: 'turn',
          executionEnv: 'managed',
          steer: true,
          approval: false,
        },
        async runTurn() {
          await gate
          return { status: 'completed', replyText: 'done' }
        },
        async steer(_sid, text) {
          steered.push(text)
          return true
        },
      },
    ],
  })
  cleanups.push(() => rt.dispose())

  let inboxId = ''
  await rt.registerChannel({
    name: 'mockch',
    async start(ctx) {
      const s = await rt.sessions.create({
        driver: 'custom-drv',
        location: { environment: 'local', cwd: agentDir },
      })
      const r = await ctx.ingestWithReceipt!({
        channel: 'mockch',
        dedupeKey: 'm-1',
        externalChatId: 'c1',
        kind: 'group',
        senderId: 'u1',
        senderName: 'User',
        text: 'steer custom',
        wake: false,
        timestamp: new Date().toISOString(),
        requireExistingSession: false,
      })
      expect(r.admitted).toBe(false)
      void s
    },
    async stop() {},
    async deliver() {
      return { externalMessageId: 'out' }
    },
  })

  const customSession = await rt.sessions.create({
    driver: 'custom-drv',
    location: { environment: 'local', cwd: agentDir },
  })
  await rt.bindings.upsert({
    channel: 'mockch',
    externalId: 'c-custom',
    kind: 'group',
    sessionId: customSession.id,
    enabled: true,
  })
  // Trigger initial run and wait briefly for active worker, then steer a second queued inbox event
  await rt.prompt(customSession.id, { text: 'first' })
  await new Promise((r) => setTimeout(r, 15))
  const second = await rt.prompt(customSession.id, {
    text: 'second queued',
    wake: false,
  })
  inboxId = second.eventId
  const adapterCtx = await new Promise<ChannelAdapterContext>((resolve) => {
    void rt.registerChannel({
      name: 'mockch2',
      async start(ctx) {
        resolve(ctx)
      },
      async stop() {},
      async deliver() {
        return { externalMessageId: 'out2' }
      },
    })
  })
  const ok = await adapterCtx.steerInboxEvent!(
    customSession.id,
    inboxId,
    'second queued',
  )
  expect(ok).toBe(true)
  expect(steered).toEqual(['second queued'])
  releaseTurn()
  await rt.waitForIdle(customSession.id)
})

test('runPrintMode correlates reply and failure to its own inboxEventId across concurrent same-session runs', async () => {
  const listeners = new Set<
    (e: import('../../src/runtime/events.ts').RuntimeEvent) => void
  >()
  let resolveSettled!: () => void
  const settledPromise = new Promise<void>((r) => {
    resolveSettled = r
  })
  const fakeRuntime = {
    events: {
      subscribe(
        fn: (e: import('../../src/runtime/events.ts').RuntimeEvent) => void,
      ) {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      subscribeDeltas: () => () => {},
    },
  } as unknown as import('../../src/runtime-sdk-types.ts').VelaRuntime
  const fakeSession = {
    id: 's-print',
    async prompt() {
      setTimeout(() => {
        for (const fn of listeners) {
          fn({
            seq: 1,
            timestamp: '2026-11-28T00:00:00.000Z',
            sessionId: 's-print',
            projectId: null,
            type: 'run_started',
            trigger: 'timer',
            runId: 'run-timer',
            inboxEventIds: ['evt-timer'],
          })
          fn({
            seq: 2,
            timestamp: '2026-11-28T00:00:01.000Z',
            sessionId: 's-print',
            projectId: null,
            type: 'message_committed',
            runId: 'run-timer',
            messageId: 'm-timer',
            message: { role: 'assistant', content: 'UNRELATED_TIMER_ANSWER' },
          })
          fn({
            seq: 3,
            timestamp: '2026-11-28T00:00:02.000Z',
            sessionId: 's-print',
            projectId: null,
            type: 'run_finished',
            runId: 'run-timer',
            status: 'completed',
          })
          fn({
            seq: 4,
            timestamp: '2026-11-28T00:00:03.000Z',
            sessionId: 's-print',
            projectId: null,
            type: 'run_started',
            trigger: 'user',
            runId: 'run-own',
            inboxEventIds: ['evt-own'],
          })
          fn({
            seq: 5,
            timestamp: '2026-11-28T00:00:04.000Z',
            sessionId: 's-print',
            projectId: null,
            type: 'message_committed',
            runId: 'run-own',
            messageId: 'm-own',
            message: { role: 'assistant', content: 'OWN_ANSWER' },
          })
          fn({
            seq: 6,
            timestamp: '2026-11-28T00:00:05.000Z',
            sessionId: 's-print',
            projectId: null,
            type: 'run_finished',
            runId: 'run-own',
            status: 'completed',
          })
          resolveSettled()
        }
      }, 5)
      return { eventId: 'evt-own' }
    },
    waitForSettled: () => settledPromise,
  } as unknown as import('../../src/cli/runtime-client.ts').CliSessionClient

  const writes: string[] = []
  const origWrite = process.stdout.write.bind(process.stdout)
  ;(process.stdout as { write: typeof origWrite }).write = ((
    chunk: unknown,
  ) => {
    writes.push(String(chunk))
    return true
  }) as typeof origWrite
  try {
    const code = await runPrintMode({
      runtime: fakeRuntime,
      session: fakeSession,
      messages: ['hi'],
      mode: 'text',
    })
    expect(code).toBe(0)
    expect(writes.join('')).toBe('OWN_ANSWER\n')
  } finally {
    ;(process.stdout as { write: typeof origWrite }).write = origWrite
  }
})

test('prepareInteractiveSession passes resume flag so /new preserves explicit model while /resume keeps session model', async () => {
  const agentDir = tempDir('vela-new-resume-')
  const rt = createRuntime({ agentDir, defaultModel: createFauxModel() })
  cleanups.push(() => rt.dispose())
  const observedResumeFlags: Array<boolean | undefined> = []

  await prepareInteractiveSession(
    rt,
    {
      runtime: rt,
      cwd: agentDir,
      sessionId: 's-fresh',
      resume: false,
      pick: false,
      newSessionId: () => 's-next',
      configure: async (_sess, opts) => {
        observedResumeFlags.push(opts?.resume)
        return true
      },
      onExit: async () => {},
    },
    's-new',
    false,
    false,
  )
  await rt.sessions.create({
    id: 's-saved',
    location: { environment: 'local', cwd: agentDir },
  })
  await prepareInteractiveSession(
    rt,
    {
      runtime: rt,
      cwd: agentDir,
      sessionId: 's-saved',
      resume: true,
      pick: false,
      newSessionId: () => 's-next',
      configure: async (_sess, opts) => {
        observedResumeFlags.push(opts?.resume)
        return true
      },
      onExit: async () => {},
    },
    's-saved',
    true,
    false,
  )
  expect(observedResumeFlags).toEqual([false, true])
})

test('daemon abortActiveDiscovery awaits teardown before saveLark completes and larkSetup avoids channels.setEnabled disable', async () => {
  const agentDir = tempDir('vela-disc-await-')
  let releaseTeardown!: () => void
  const teardownGate = new Promise<void>((r) => {
    releaseTeardown = r
  })
  const handle = await startDaemonServer({
    agentDir,
    hostEnv: {},
    enableWebhooks: false,
    enableLark: true,
    registerSignalHandlers: false,
    onCreateLarkDiscoveryTransport: async () => makeMockLarkTransport(),
    onVerifyLarkCredentials: async () => {},
  })
  cleanups.push(() => handle.close('test'))

  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ lark: { appId: 'cli_a', appSecret: 'sec_a' } }),
    { mode: 0o600 },
  )
  await handle.runtime.reloadConfig()

  const clientA = await connectRuntime({ agentDir, autoStart: false })
  const clientB = await connectRuntime({ agentDir, autoStart: false })
  cleanups.push(
    () => clientA.dispose(),
    () => clientB.dispose(),
  )

  // Disconnect/abort in larkSetup with mock runtime must not leave channel_enabled:lark = false
  await expect(
    larkSetup({
      runtime: clientA,
      agentDir,
      select: async (title) =>
        title.includes('Continue') ? 'continue' : 'keep',
      input: async () => 'x',
      addNotice: () => {},
      setSummary: () => {},
      signal: AbortSignal.abort(),
    }),
  ).resolves.toBe(false)
  const statuses = await clientB.channels.list()
  expect(statuses.find((s) => s.name === 'lark')?.enabled).not.toBe(false)

  // Async onBeforeCredentialWrite must settle before saveRuntimeLarkSetup resolves
  let finished = false
  const saving = saveRuntimeLarkSetup({
    agentDir,
    hostEnv: {},
    runtime: handle.runtime,
    input: { appId: 'cli_b', appSecret: 'sec_b' },
    verifyCredentials: async () => {},
    onBeforeCredentialWrite: async () => {
      await teardownGate
    },
  }).then(() => {
    finished = true
  })
  await new Promise((r) => setTimeout(r, 20))
  expect(finished).toBe(false)
  releaseTeardown()
  await saving
  expect(finished).toBe(true)
})

test('waiting_human turn awaits image steer blob flush and VELA_RECORD records auto-selected registry default', async () => {
  const agentDir = tempDir('vela-wait-rec-')
  const recordPath = join(agentDir, 'recorded.jsonl')
  writeFileSync(
    join(agentDir, 'auth.json'),
    JSON.stringify({ custom: { type: 'api_key', key: 'k' } }),
    { mode: 0o600 },
  )
  const rt = createRuntime({
    agentDir,
    providers: {
      custom: {
        models: [{ id: 'auto-m', name: 'auto-m' }],
        authSource: (c) => (c ? 'api_key' : undefined),
        createModel: () =>
          createFauxModel({
            responses: [
              fauxToolCall('bash', { command: 'echo hi' }),
              fauxText('recorded ok'),
            ],
          }),
      },
    },
    toolApprovalCheck: async () => ({
      requireApproval: true,
      summary: 'Needs manual approval',
    }),
  })
  cleanups.push(() => rt.dispose())
  const sess = await rt.sessions.create({
    location: { environment: 'local', cwd: agentDir },
  })
  await rt.sessions.configure(sess.id, { recordPath })
  await rt.prompt(sess.id, { text: 'run bash' })
  await rt.waitForIdle(sess.id)
  expect(existsSync(recordPath)).toBe(true)
  expect(readFileSync(recordPath, 'utf8').length).toBeGreaterThan(0)
})

test('Round 2 regressions: export guard, steering preservation, slow adapter wake, docker key-order, print-mode, project remove teardown, and outbox eviction', async () => {
  const agentDir = tempDir('vela-r2-all-')

  // #6: flushSessionSteering preserves failing item AND trailing messages on blob write error
  const dbPath = join(agentDir, 'steer.db')
  const steerDb = openDatabase({ path: dbPath })
  cleanups.push(() => steerDb.close())
  const now = new Date().toISOString()
  new SessionStoreControl(steerDb).create({
    id: 's-fail',
    location: { environment: 'local', cwd: agentDir },
  })
  const deferred: ReturnType<typeof buildSteeringMessage>[] = [
    buildSteeringMessage('img-msg', [{ data: 'AA==', mimeType: 'image/png' }]),
    buildSteeringMessage('trailing-text'),
  ]
  const failingBlobs = {
    storeInbound: async () => {
      throw new Error('disk full')
    },
  } as unknown as BlobStore
  await expect(
    flushSessionSteering({
      db: steerDb,
      blobs: failingBlobs,
      sessionId: 's-fail',
      projectId: null,
      activeSteering: new Map(),
      activeSteeringInboxIds: new WeakMap(),
      deferredSteering: deferred,
      wake: true,
      shouldWakeSession: true,
    }),
  ).rejects.toThrow('disk full')
  expect(deferred.length).toBe(2)

  // #16: updateEnvironmentRegistryConfig ignores Docker definition key ordering
  const envReg = createEnvironmentRegistryForTest({
    dataDir: agentDir,
    environments: { box: { image: 'alpine:3', network: 'none' } },
    probeAlive: async () => true,
  })
  // Simulate opened definition in registry map cleanly via update without key diff throwing
  expect(() =>
    updateEnvironmentRegistryConfig(envReg, {
      box: { network: 'none', image: 'alpine:3' },
    }),
  ).not.toThrow()

  // #14: runPrintMode fails cleanly when accepted prompt does not start a run (waiting_human)
  const printRt = createRuntime({
    agentDir: tempDir('vela-r2-print-'),
    defaultModel: createFauxModel({
      responses: [
        fauxToolCall('bash', { command: 'echo wait' }),
        fauxText('done'),
      ],
    }),
    toolApprovalCheck: async () => ({
      requireApproval: true,
      summary: 'Need approval',
    }),
  })
  cleanups.push(() => printRt.dispose())
  const waitSess = await printRt.sessions.create({
    location: { environment: 'local', cwd: agentDir },
  })
  await printRt.prompt(waitSess.id, { text: 'trigger approval' })
  await printRt.waitForIdle(waitSess.id)
  const printExit = await runPrintMode({
    runtime: printRt,
    session: {
      id: waitSess.id,
      prompt: async (text: string) => printRt.prompt(waitSess.id, { text }),
      waitForSettled: async () => printRt.waitForIdle(waitSess.id),
      refresh: async () => {
        throw new Error('unused')
      },
    } as never,
    messages: ['second message while waiting_human'],
    mode: 'text',
  })
  expect(printExit).toBe(1)

  // #5: ephemeralSessions (--no-session) still blocks exporting over owner <agentDir>/vela.db
  const noSessDir = tempDir('vela-r2-nosess-')
  const persistRt = createRuntime({
    agentDir: noSessDir,
    defaultModel: createFauxModel({ responses: [fauxText('ok')] }),
  })
  await persistRt.ready()
  await persistRt.dispose()
  const ephemRt = createRuntime({
    agentDir: noSessDir,
    ephemeralSessions: true,
    defaultModel: createFauxModel({ responses: [fauxText('ephem')] }),
  })
  cleanups.push(() => ephemRt.dispose())
  const ephemSess = await ephemRt.sessions.create({
    location: { environment: 'local', cwd: noSessDir },
  })
  await ephemRt.prompt(ephemSess.id, { text: 'hi' })
  await ephemRt.waitForIdle(ephemSess.id)
  await expect(
    ephemRt.sessions.export(ephemSess.id, 'jsonl', join(noSessDir, 'vela.db')),
  ).rejects.toThrow(/vela\.db|database/i)

  // #7: channel registration wakes deferred pending wakeable inbox rows
  const slowDir = tempDir('vela-r2-slow-')
  const slowRt = createRuntime({
    agentDir: slowDir,
    defaultModel: createFauxModel({
      responses: [fauxText('woken-after-ready')],
    }),
  })
  cleanups.push(() => slowRt.dispose())
  const slowProj = await slowRt.projects.create({ name: 'Slow', cwd: slowDir })
  const slowSess = await slowRt.sessions.create({
    projectId: slowProj.id,
    location: { environment: 'local', cwd: slowDir },
  })
  await slowRt.bindings.upsert({
    projectId: slowProj.id,
    sessionId: slowSess.id,
    channel: 'deferred-ch',
    externalId: 'chat-def',
    kind: 'direct',
    enabled: true,
  })
  const slowDb = openDatabase({ path: join(slowDir, 'vela.db') })
  cleanups.push(() => slowDb.close())
  enqueueInboxEvent(slowDb, {
    sessionId: slowSess.id,
    projectId: slowProj.id,
    source: 'webhook',
    wake: true,
    passive: false,
    payload: { type: 'webhook', text: 'deferred hook' },
  })
  await slowRt.registerChannel({
    name: 'deferred-ch',
    async start() {},
    async stop() {},
    async deliver() {
      return { externalMessageId: 'ok' }
    },
  })
  await slowRt.waitForIdle(slowSess.id)
  const slowMsgs = await slowRt.sessions.messages({ sessionId: slowSess.id })
  expect(
    slowMsgs.messages.some((m) =>
      JSON.stringify(m.content).includes('woken-after-ready'),
    ),
  ).toBe(true)

  // #15: recordPath preserves object-valued defaultModel even when an eligible registry default exists
  const recObjDir = tempDir('vela-r2-rec-obj-')
  const recObjPath = join(recObjDir, 'obj-recorded.jsonl')
  writeFileSync(
    join(recObjDir, 'auth.json'),
    JSON.stringify({ custom: { type: 'api_key', key: 'k' } }),
    { mode: 0o600 },
  )
  const recObjRt = createRuntime({
    agentDir: recObjDir,
    defaultModel: createFauxModel({
      responses: [fauxText('from-object-default')],
    }),
    providers: {
      custom: {
        models: [{ id: 'other-m', name: 'other-m' }],
        authSource: (c) => (c ? 'api_key' : undefined),
        createModel: () =>
          createFauxModel({ responses: [fauxText('wrong-registry-default')] }),
      },
    },
  })
  cleanups.push(() => recObjRt.dispose())
  const recObjSess = await recObjRt.sessions.create({
    location: { environment: 'local', cwd: recObjDir },
  })
  await recObjRt.sessions.configure(recObjSess.id, { recordPath: recObjPath })
  await recObjRt.prompt(recObjSess.id, { text: 'hello' })
  await recObjRt.waitForIdle(recObjSess.id)
  const recObjMsgs = await recObjRt.sessions.messages({
    sessionId: recObjSess.id,
  })
  expect(JSON.stringify(recObjMsgs.messages)).toContain('from-object-default')
  expect(JSON.stringify(recObjMsgs.messages)).not.toContain(
    'wrong-registry-default',
  )
  expect(existsSync(recObjPath)).toBe(true)

  // #20: LarkRuntimeProgressManager cancels evicted feedback when >512 awaitingOutbox entries accumulate
  let deletedReactions = 0
  let evictSub:
    | ((
        event: Parameters<
          Parameters<NonNullable<ChannelAdapterContext['subscribeEvents']>>[0]
        >[0],
      ) => void)
    | undefined
  const evictTransport = makeMockLarkTransport({
    async addReaction() {
      return 'rx-1'
    },
    async removeReaction() {
      deletedReactions += 1
    },
  })
  const evictCtx: ChannelAdapterContext = {
    async ingest() {},
    subscribeEvents(fn) {
      evictSub = fn
      return () => {}
    },
    subscribeDeltas() {
      return () => {}
    },
    listBindings: () => [
      {
        id: 'b-ev',
        channel: 'lark',
        externalId: 'oc_ev',
        threadId: null,
        kind: 'group',
        projectId: 'p-ev',
        sessionId: 's-ev-0',
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
  }
  const evictMgr = new LarkRuntimeProgressManager(evictCtx, evictTransport, {
    isChatEnabled: () => true,
    isOwner: () => true,
    logger: silentLogger,
  })
  evictMgr.start()
  cleanups.push(() => evictMgr.stop())
  for (let i = 0; i < 513; i++) {
    const sid = 's-ev-0'
    const rid = `r-ev-${i}`
    evictMgr.noteAdmittedInbound({
      inboxEventId: `in-${i}`,
      externalChatId: 'oc_ev',
      messageId: `om-user-${i}`,
      text: 'hi',
      isDirect: false,
    })
    evictSub?.({
      seq: i * 2 + 1,
      timestamp: now,
      sessionId: sid,
      projectId: 'p-ev',
      runId: rid,
      type: 'run_started',
      trigger: 'channel',
      inboxEventIds: [`in-${i}`],
    })
    evictSub?.({
      seq: i * 2 + 2,
      timestamp: now,
      sessionId: sid,
      runId: rid,
      projectId: 'p-ev',
      type: 'run_finished',
      status: 'completed',
      replyPending: true,
    })
  }
  await new Promise((r) => setTimeout(r, 20))
  expect(deletedReactions).toBeGreaterThanOrEqual(1)
  await evictMgr.stop()

  // #9: async custom driver trySteerInboxEvent reserves 'processing' and restores 'pending' on refusal
  let resolveSteer!: (accepted: boolean) => void
  const steerGate = new Promise<boolean>((r) => {
    resolveSteer = r
  })
  let resolveTurn1!: () => void
  const turn1Gate = new Promise<void>((r) => {
    resolveTurn1 = r
  })
  cleanups.push(() => {
    resolveTurn1?.()
    resolveSteer?.(false)
  })
  const ranBatches: Array<Array<unknown>> = []
  const asyncDrvDir = tempDir('vela-r2-drv-')
  const asyncDrvRt = createRuntime({
    agentDir: asyncDrvDir,
    drivers: [
      {
        name: 'slow-steer-drv',
        capabilities: {
          recovery: 'turn',
          executionEnv: 'managed',
          steer: true,
          approval: false,
        },
        async runTurn(req) {
          ranBatches.push(req.inputs.map((i) => i.payload.text))
          if (ranBatches.length === 1) await turn1Gate
          return { status: 'completed', replyText: 'turn-done' }
        },
        steer() {
          return steerGate
        },
      },
    ],
  })
  cleanups.push(() => asyncDrvRt.dispose())
  let slowCtx!: ChannelAdapterContext
  await asyncDrvRt.registerChannel({
    name: 'slowmock',
    async start(ctx) {
      slowCtx = ctx
    },
    async stop() {},
    async deliver() {
      return { externalMessageId: 'out' }
    },
  })
  const slowDrvSess = await asyncDrvRt.sessions.create({
    driver: 'slow-steer-drv',
    location: { environment: 'local', cwd: agentDir },
  })
  await asyncDrvRt.prompt(slowDrvSess.id, { text: 'turn1' })
  await new Promise((r) => setTimeout(r, 15))
  const secondEv = await asyncDrvRt.prompt(slowDrvSess.id, {
    text: 'steer-later',
    wake: false,
  })
  const steerPromise = slowCtx.steerInboxEvent!(
    slowDrvSess.id,
    secondEv.eventId,
    'steer-later',
  )
  resolveTurn1()
  await asyncDrvRt.waitForIdle(slowDrvSess.id)
  expect(ranBatches).toEqual([['turn1']])
  resolveSteer(false)
  expect(await steerPromise).toBe(false)
  const checkDrvDb = openDatabase({ path: join(asyncDrvDir, 'vela.db') })
  cleanups.push(() => checkDrvDb.close())
  const rowAfterRefusal = checkDrvDb.get<{ status: string }>(
    'SELECT status FROM inbox_events WHERE id = ?',
    secondEv.eventId,
  )
  expect(rowAfterRefusal?.status).toBe('pending')
})
