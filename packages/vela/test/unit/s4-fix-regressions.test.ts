import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonLarkHost } from '../../src/daemon/lark-host.ts'
import {
  acquireOwnerLock,
  DaemonAlreadyRunningError,
  readOwnerRecord,
} from '../../src/daemon/owner-lock.ts'
import { openDatabase } from '../../src/db/index.ts'
import { createLocalExecutionEnv } from '../../src/driver/execution/local.ts'
import {
  buildSteeringMessage,
  flushSessionSteering,
  takeSessionSteering,
} from '../../src/driver/runtime-steering.ts'
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
import { createFauxModel } from '../../src/testing/core/index.ts'

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

test('updateEnvironmentRegistryConfig hot-reloads changed definitions for subsequent resolves', async () => {
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

  updateEnvironmentRegistryConfig(registry, {
    box: { image: 'alpine:v2', network: 'on' },
  })
  await registry.resolve({
    sessionId: 's2',
    location: { environment: 'box', cwd: '/workspace' },
  })
  expect(openedImages).toEqual(['alpine:v1', 'alpine:v2'])
  await registry.dispose()
  expect(retiredCleanup).toBe(2)
})

test('steering helpers atomically claim inbox entries and flush standalone images into BlobStore on exit', async () => {
  const dir = tempDir('vela-steer-')
  const db = openDatabase({ path: join(dir, 'vela.db') })
  cleanups.push(() => db.close())
  const blobs = new BlobStore(db, join(dir, 'blobs'))
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

  const taken = takeSessionSteering({
    db,
    sessionId: session.id,
    runId: 'run-1',
    activeSteering,
    activeSteeringInboxIds: inboxMap,
  })
  expect(taken).toEqual([claimedMsg])
  const claimedRow = db.get<{ status: string }>(
    'SELECT status FROM inbox_events WHERE id = ?',
    inbox1.id,
  )
  expect(claimedRow?.status).toBe('done')
  expect(
    takeSessionSteering({
      db,
      sessionId: session.id,
      runId: 'run-1',
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

test('getBoundChannelForSession ignores channel_enabled=false toggles and includes topic/non-hub sessions', () => {
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
    enabled: true,
  })
  setChannelEnabledInDb(db, 'lark', false)

  expect(getActiveChannelForSession(db, project.hubSessionId!)).toBeUndefined()
  expect(getBoundChannelForSession(db, project.hubSessionId!)).toBe('lark')
  expect(getBoundChannelForSession(db, nonHub.id)).toBe('lark')
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
