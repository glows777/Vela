import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { grade } from '../../../../scripts/eval/graders.ts'
import { runAttempt } from '../../../../scripts/eval/worker.ts'
import { stopDaemon } from '../../src/daemon/launcher.ts'
import { resolveDaemonPaths } from '../../src/daemon/paths.ts'
import { startDaemonServer } from '../../src/daemon/server.ts'
import { openDatabase } from '../../src/db/index.ts'
import {
  createLarkChannelAdapter,
  type LarkCard,
  type LarkCardAction,
  type LarkCardResponse,
  type LarkHistoryMessage,
  type LarkMessageEvent,
  type LarkTransport,
} from '../../src/lark/index.ts'
import { LarkRuntimeProgressManager } from '../../src/lark/runtime-progress.ts'
import { BackgroundJobManager } from '../../src/runtime/background-jobs.ts'
import { ProjectStore } from '../../src/runtime/domain.ts'
import {
  claimInboxBatchInTx,
  enqueueInboxEvent,
} from '../../src/runtime/inbox.ts'
import { OutboxDispatcher } from '../../src/runtime/outbox.ts'
import { recoverRuntimeState } from '../../src/runtime/recovery.ts'
import { TimerScheduler } from '../../src/runtime/timers.ts'
import { createRuntime } from '../../src/runtime-sdk.ts'
import { silentLogger } from '../../src/shared/logger.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../src/testing/core/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

function makeTempDir(prefix = 'vela-s4b2-r2-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function initGitRepo(cwd: string): void {
  execFileSync('git', ['init', '-q'], { cwd })
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error(`Timed out waiting for: ${label}`)
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await Promise.resolve(cleanups.pop()!()).catch(() => {})
  }
})

function createControlledTransport(opts?: {
  getBotIdPromise?: Promise<string>
  failNextReplies?: number
  delaySendCardMs?: number
  hangListMessages?: boolean
}) {
  let onMessage: ((event: LarkMessageEvent) => void) | undefined
  let onAction: ((event: LarkCardAction) => LarkCardResponse) | undefined
  let remainingReplyFailures = opts?.failNextReplies ?? 0
  const replies: Array<{ messageId: string; text: string; uuid?: string }> = []
  const sends: Array<{ chatId: string; text: string; uuid?: string }> = []
  const cards: Array<{ chatId: string; replyToId?: string; card: LarkCard }> =
    []
  const patches: Array<{ messageId: string; card: LarkCard }> = []
  const reactions: Array<{
    messageId: string
    emoji: string
    id: string
    removed?: boolean
  }> = []
  const resources = new Map<string, Buffer[]>()
  const topicHistory = new Map<string, LarkHistoryMessage[]>()
  const searchResults: LarkHistoryMessage[] = []
  let seq = 0

  const transport: LarkTransport = {
    start: async (m, a) => {
      onMessage = m
      onAction = a
    },
    stop: () => {},
    getBotId: () => opts?.getBotIdPromise ?? Promise.resolve('ou_bot'),
    getSenderName: async (id) => (id === 'ou_alice' ? 'Alice' : 'Bob'),
    send: async (chatId, text, uuid) => {
      seq++
      sends.push({ chatId, text, uuid })
      return { messageId: `sent_${seq}`, createTime: String(Date.now()) }
    },
    reply: async (messageId, text, uuid) => {
      if (remainingReplyFailures > 0) {
        remainingReplyFailures--
        throw new Error('Transient Lark reply failure')
      }
      seq++
      replies.push({ messageId, text, uuid })
      return { messageId: `reply_${seq}`, createTime: String(Date.now()) }
    },
    startTopic: async (messageId, _title, _uuid) => {
      seq++
      return {
        messageId: `topic_${seq}`,
        rootId: messageId,
        threadId: `omt_${messageId}`,
        createTime: String(Date.now()),
      }
    },
    forward: async (messageId) => ({
      messageId: `fwd_${messageId}`,
      createTime: String(Date.now()),
    }),
    sendCard: async (chatId, card, replyToId) => {
      if (opts?.delaySendCardMs) await Bun.sleep(opts.delaySendCardMs)
      cards.push({ chatId, replyToId, card })
      return `card_${cards.length}`
    },
    patchCard: async (messageId, card) => {
      patches.push({ messageId, card })
    },
    addReaction: async (messageId, emoji) => {
      const id = `rx_${reactions.length + 1}`
      reactions.push({ messageId, emoji, id })
      return id
    },
    removeReaction: async (_messageId, id) => {
      const match = reactions.find((r) => r.id === id)
      if (match) match.removed = true
    },
    getResource: async (_m, key) => {
      const { Readable } = await import('node:stream')
      const chunks = resources.get(key)
      if (!chunks) throw new Error(`Missing resource ${key}`)
      return Readable.from(chunks)
    },
    listMessages: () =>
      opts?.hangListMessages ? new Promise(() => {}) : Promise.resolve([]),
    listTopicMessages: async (threadId) => ({
      items: topicHistory.get(threadId) ?? [],
    }),
    searchMessages: async () => ({ items: [...searchResults] }),
  }

  return {
    transport,
    replies,
    sends,
    cards,
    patches,
    reactions,
    resources,
    topicHistory,
    searchResults,
    deliver: (ev: LarkMessageEvent) => onMessage?.(ev),
    action: (ev: LarkCardAction) => onAction?.(ev),
  }
}

function larkEvent(
  overrides: Partial<LarkMessageEvent['message']>,
  senderId = 'ou_alice',
  senderType = 'user',
): LarkMessageEvent {
  return {
    sender: { sender_type: senderType, sender_id: { open_id: senderId } },
    message: {
      chat_id: 'oc_chat_a',
      chat_type: 'group',
      message_id: crypto.randomUUID(),
      create_time: String(Date.now()),
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 hello' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      ...overrides,
    },
  }
}

test('R2 #1,#2,#3,#10: identical reload keeps live readUntagged, explicit disable survives re-add, timezone reload preserves session model, early daemon.stop works, deferred webhook runs on connect', async () => {
  const agentDir = makeTempDir('vela-r2-daemon-')
  const configPath = join(agentDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      lark: {
        owners: ['ou_alice'],
        timezone: 'UTC',
        chats: [
          {
            id: 'oc_chat_a',
            readUntagged: true,
            model: 'eval/default-model',
          },
        ],
      },
      webhooks: {
        port: 0,
        generic: { secret: 'gen-sec' },
      },
      eventDefaultTarget: { channel: 'lark', chatId: 'oc_chat_a' },
    }),
  )

  // #2: Hold getBotId open while calling daemon.stop early during startup wait
  let releaseBotId!: (id: string) => void
  const heldBotId = new Promise<string>((r) => {
    releaseBotId = r
  })
  const heldTransport = createControlledTransport({
    getBotIdPromise: heldBotId,
  })
  const daemonPaths = resolveDaemonPaths(agentDir)
  const startPromise = startDaemonServer({
    agentDir,
    registerSignalHandlers: false,
    larkTransport: heldTransport.transport,
    logger: silentLogger,
  })
  await waitFor(
    () => existsSync(daemonPaths.socketPath) && existsSync(daemonPaths.pidPath),
    'daemon socket & pid present during lark startup',
  )
  const stopPromise = stopDaemon({ agentDir, timeoutMs: 5_000 })
  await Bun.sleep(40)
  releaseBotId('ou_bot')
  expect(await stopPromise).toBe(true)
  const earlyHandle = await startPromise.catch(() => undefined)
  await earlyHandle?.close('test').catch(() => {})

  // Now test #1 & #10 cleanly on a fresh daemon
  const fake = createControlledTransport()
  const handle = await startDaemonServer({
    agentDir,
    registerSignalHandlers: false,
    larkTransport: fake.transport,
    logger: silentLogger,
  })
  cleanups.push(() => handle.close('test'))

  const bindings = await handle.runtime.bindings.list({ channel: 'lark' })
  const rootBinding = bindings.find((b) => b.externalId === 'oc_chat_a')!
  expect(rootBinding.config?.readUntagged).toBe(true)

  // Modify readUntagged directly in DB (live revocation), then reload IDENTICAL config -> stays false!
  await handle.runtime.bindings.upsert({
    ...rootBinding,
    config: { ...(rootBinding.config ?? {}), readUntagged: false },
  })
  // Set per-session model override on hub & topic session
  const project = (await handle.runtime.projects.get(rootBinding.projectId!))!
  await handle.runtime.sessions.setModel(
    project.hubSessionId!,
    'anthropic/claude-haiku-4-5',
  )
  const topic = await handle.runtime.sessions.create({
    projectId: project.id,
    kind: 'topic',
    externalSessionId: 'omt_tz',
  })
  await handle.runtime.sessions.setModel(topic.id, 'anthropic/claude-haiku-5-5')

  await handle.runtime.reloadConfig()
  const afterIdentical = (
    await handle.runtime.bindings.list({ channel: 'lark' })
  ).find((b) => b.externalId === 'oc_chat_a')!
  expect(afterIdentical.config?.readUntagged).toBe(false)

  // #10: Timezone-only change keeps per-session models intact
  writeFileSync(
    configPath,
    JSON.stringify({
      lark: {
        owners: ['ou_alice'],
        timezone: 'Asia/Tokyo',
        chats: [
          {
            id: 'oc_chat_a',
            readUntagged: true,
            model: 'eval/default-model',
          },
        ],
      },
    }),
  )
  await handle.runtime.reloadConfig()
  expect(
    (await handle.runtime.sessions.get(project.hubSessionId!))?.model,
  ).toBe('anthropic/claude-haiku-4-5')
  expect((await handle.runtime.sessions.get(topic.id))?.model).toBe(
    'anthropic/claude-haiku-5-5',
  )

  // #1 explicit disable after config removal survives re-add
  writeFileSync(
    configPath,
    JSON.stringify({
      lark: { owners: ['ou_alice'], chats: [] },
    }),
  )
  await handle.runtime.reloadConfig()
  await handle.runtime.bindings.setEnabled(rootBinding.id, false)
  writeFileSync(
    configPath,
    JSON.stringify({
      lark: {
        owners: ['ou_alice'],
        chats: [{ id: 'oc_chat_a', readUntagged: true }],
      },
    }),
  )
  await handle.runtime.reloadConfig()
  const afterReadd = (
    await handle.runtime.bindings.list({ channel: 'lark' })
  ).find((b) => b.externalId === 'oc_chat_a')!
  expect(afterReadd.enabled).toBe(false)
})

test('R2 #3,#4,#15: deferred webhook wakes on adapter registration, passive batch respects order/cap, restart drops passive work', async () => {
  const dir = makeTempDir('vela-r2-inbox-')

  // #4 unit check on SQLite inbox_events
  const db = openDatabase({ path: ':memory:' })
  cleanups.push(() => db.close())
  const projects = new ProjectStore(db)
  const proj = projects.create({
    name: 'p',
    cwd: dir,
    hubSessionId: true,
  })
  const sid = proj.hubSessionId!

  // Sequence: passive A, explicit B, passive C -> [A], [B], [C]
  enqueueInboxEvent(db, {
    sessionId: sid,
    projectId: proj.id,
    source: 'channel',
    dedupeKey: 'a',
    wake: true,
    passive: true,
    payload: {
      channel: 'lark',
      externalChatId: 'oc_1',
      text: 'A',
    },
  })
  enqueueInboxEvent(db, {
    sessionId: sid,
    projectId: proj.id,
    source: 'channel',
    dedupeKey: 'b',
    wake: true,
    passive: false,
    payload: {
      channel: 'lark',
      externalChatId: 'oc_1',
      text: 'B',
    },
  })
  enqueueInboxEvent(db, {
    sessionId: sid,
    projectId: proj.id,
    source: 'channel',
    dedupeKey: 'c',
    wake: true,
    passive: true,
    payload: {
      channel: 'lark',
      externalChatId: 'oc_1',
      text: 'C',
    },
  })
  expect(claimInboxBatchInTx(db, sid, 'r1').map((i) => i.payload.text)).toEqual(
    ['A'],
  )
  expect(claimInboxBatchInTx(db, sid, 'r2').map((i) => i.payload.text)).toEqual(
    ['B'],
  )
  expect(claimInboxBatchInTx(db, sid, 'r3').map((i) => i.payload.text)).toEqual(
    ['C'],
  )

  // Oversized non-waking passive row before waking passive row -> waking row still claims (no [] spin!)
  enqueueInboxEvent(db, {
    sessionId: sid,
    projectId: proj.id,
    source: 'channel',
    dedupeKey: 'big-nonwake',
    wake: false,
    passive: true,
    payload: {
      channel: 'lark',
      externalChatId: 'oc_1',
      text: 'x'.repeat(420 * 1024),
    },
  })
  enqueueInboxEvent(db, {
    sessionId: sid,
    projectId: proj.id,
    source: 'channel',
    dedupeKey: 'wake-small',
    wake: true,
    passive: true,
    payload: {
      channel: 'lark',
      externalChatId: 'oc_1',
      text: 'small wake',
    },
  })
  expect(claimInboxBatchInTx(db, sid, 'r4').map((i) => i.payload.text)).toEqual(
    ['small wake'],
  )

  db.run(
    "UPDATE inbox_events SET status = 'done' WHERE session_id = ? AND status IN ('pending', 'processing')",
    sid,
  )

  // #15: recoverRuntimeState drops queued passive rows while keeping explicit rows
  enqueueInboxEvent(db, {
    sessionId: sid,
    projectId: proj.id,
    source: 'channel',
    dedupeKey: 'p-drop',
    wake: true,
    passive: true,
    payload: { channel: 'lark', externalChatId: 'oc_1', text: 'stale chatter' },
  })
  enqueueInboxEvent(db, {
    sessionId: sid,
    projectId: proj.id,
    source: 'channel',
    dedupeKey: 'e-keep',
    wake: true,
    passive: false,
    payload: { channel: 'lark', externalChatId: 'oc_1', text: 'explicit keep' },
  })
  const rec = recoverRuntimeState({
    db,
    backgroundJobs: new BackgroundJobManager(db),
    outbox: new OutboxDispatcher(db, () => undefined),
    timers: new TimerScheduler(db),
    activeOwners: new Set(),
    nowMs: Date.now(),
  })
  expect(rec.sessionsToWake.has(sid)).toBe(true)
  expect(claimInboxBatchInTx(db, sid, 'r5').map((i) => i.payload.text)).toEqual(
    ['explicit keep'],
  )

  // #3: Default-target webhook queued BEFORE lark adapter registers is deferred (not dropped!) and runs on register
  const fake = createControlledTransport()
  const model = createFauxModel({
    responses: [fauxText('Webhook handled after Lark connected')],
  })
  const rt = createRuntime({
    agentDir: join(dir, 'rt'),
    defaultModel: model,
    logger: silentLogger,
  })
  cleanups.push(() => rt.dispose())
  const whProj = await rt.projects.create({
    name: 'wh',
    cwd: dir,
    hubSessionId: true,
  })
  await rt.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_chat_a',
    threadId: null,
    kind: 'group',
    projectId: whProj.id,
    enabled: true,
  })
  await rt.ingestWebhookEvent(
    {
      source: 'github',
      key: 'github:org/repo#pr/1',
      deliveryId: 'del-before-lark',
      summary: 'PR opened',
    },
    { channel: 'lark', chatId: 'oc_chat_a' },
  )
  await rt.waitForIdle()
  expect(model.calls).toHaveLength(0)

  const adapter = createLarkChannelAdapter({
    appId: 'ou_bot',
    owners: ['ou_alice'],
    chats: ['oc_chat_a'],
    transport: fake.transport,
    logger: silentLogger,
  })
  await rt.registerChannel(adapter)
  await waitFor(() => fake.replies.length === 1, 'deferred webhook replied')
  expect(fake.sends[0]?.text).toContain('PR opened')
  expect(fake.replies[0]?.text).toContain(
    'Webhook handled after Lark connected',
  )
})

test('R2 #5,#6,#7,#11,#12,#13,#14,#16,#17: passive/topic steer, retries, late topic card, stop I/O cancellation, host-post author, excludeTools, timezone', async () => {
  const dir = makeTempDir('vela-r2-full-')
  const seenPrompts: string[] = []
  const passiveHoldFile = join(dir, 'passive-hold')
  const topicHoldFile = join(dir, 'topic-hold')
  const waitCmd = (file: string) =>
    `while [ ! -f ${JSON.stringify(file)} ]; do sleep 0.02; done; echo ok`

  let passiveStarted = false
  let topicStarted = false
  let dmTimerTimezone: string | undefined
  const model = createFauxModel({
    responses: [
      () => {
        passiveStarted = true
        return fauxToolCall('bash', { command: waitCmd(passiveHoldFile) })
      },
      () => fauxToolCall('skip_reply', {}),
      () => fauxText(''),
      () => fauxText('Explicit after passive'),
      () => fauxText('Retry delivered answer'),
      () => fauxText('Fast topic answer'),
      () => {
        topicStarted = true
        return fauxToolCall('bash', { command: waitCmd(topicHoldFile) })
      },
      (req) => {
        seenPrompts.push(JSON.stringify(req.prompt))
        return fauxText('Topic incorporated auto-steer')
      },
      () => fauxToolCall('timers', { action: 'list' }),
      (req) => {
        const out = req.toolResults.at(-1)?.output
        if (out) {
          try {
            dmTimerTimezone = (JSON.parse(out) as { timezone?: string })
              .timezone
          } catch {}
        }
        return fauxText('DM timer listed')
      },
    ],
  })

  // failNextReplies: 1 tests #12 outbox retry; delaySendCardMs: 120 tests #13 fast topic turn
  const fake = createControlledTransport({
    failNextReplies: 1,
    delaySendCardMs: 120,
  })
  const rt = createRuntime({
    agentDir: dir,
    defaultModel: model,
    logger: silentLogger,
  })
  cleanups.push(() => rt.dispose())

  const proj = await rt.projects.create({
    name: 'oc_chat_a',
    cwd: dir,
    hubSessionId: true,
    defaultTools: ['read', 'bash'],
  })
  await rt.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_chat_a',
    threadId: null,
    kind: 'group',
    projectId: proj.id,
    enabled: true,
    config: { readUntagged: true },
  })
  const adapter = createLarkChannelAdapter({
    appId: 'ou_bot',
    owners: ['ou_alice'],
    chats: ['oc_chat_a'],
    timezone: 'America/New_York',
    transport: fake.transport,
    logger: silentLogger,
  })
  await rt.registerChannel(adapter)

  // #5: Passive run active -> explicit @ arrives -> NO Steer card posted
  fake.deliver(
    larkEvent(
      {
        message_id: 'om_pass_hold',
        content: JSON.stringify({ text: 'ambient chatter' }),
        mentions: undefined,
      },
      'ou_bob',
    ),
  )
  await waitFor(() => passiveStarted, 'passive run started')
  fake.deliver(
    larkEvent({
      message_id: 'om_explicit_during_passive',
      content: JSON.stringify({ text: '@_user_1 urgent question' }),
    }),
  )
  await Bun.sleep(80)
  expect(
    fake.cards.some((c) => JSON.stringify(c.card).includes('"action":"steer"')),
  ).toBe(false)
  writeFileSync(passiveHoldFile, 'go')
  await waitFor(
    () => fake.replies.length === 1,
    'explicit after passive replied',
  )
  expect(fake.replies[0]?.text).toBe('Explicit after passive')

  // #12: Reply fails once then retries -> terminal reaction on om_retry MUST become DONE
  fake.deliver(
    larkEvent({
      message_id: 'om_retry',
      content: JSON.stringify({ text: '@_user_1 retry test' }),
    }),
  )
  await waitFor(
    () =>
      fake.reactions.some(
        (r) => r.messageId === 'om_retry' && r.emoji === 'DONE' && !r.removed,
      ),
    'retry eventually sets DONE reaction',
  )

  // #13: Fast topic turn where sendCard resolves AFTER run_finished still patches card
  fake.deliver(
    larkEvent({
      message_id: 'om_fast_topic',
      thread_id: 'omt_fast',
      root_id: 'om_fast_root',
      content: JSON.stringify({ text: '@_user_1 fast topic' }),
    }),
  )
  await waitFor(
    () => fake.patches.some((p) => JSON.stringify(p.card).includes('Finished')),
    'late topic card patched to Finished',
  )

  // #16: Busy topic follow-up auto-steers into running topic turn
  fake.deliver(
    larkEvent({
      message_id: 'om_topic_busy',
      thread_id: 'omt_steer',
      root_id: 'om_steer_root',
      content: JSON.stringify({ text: '@_user_1 start topic work' }),
    }),
  )
  await waitFor(() => topicStarted, 'topic busy run started')
  fake.deliver(
    larkEvent(
      {
        message_id: 'om_topic_followup',
        thread_id: 'omt_steer',
        root_id: 'om_steer_root',
        content: JSON.stringify({ text: 'use green background instead' }),
        mentions: undefined,
      },
      'ou_bob',
    ),
  )
  await Bun.sleep(60)
  writeFileSync(topicHoldFile, 'go')
  await rt.waitForIdle()
  expect(
    seenPrompts.some((p) => p.includes('use green background instead')),
  ).toBe(true)

  // #6: excludeTools removes bash even when project.defaultTools allows bash
  await rt.sessions.configure(proj.hubSessionId!, { excludeTools: ['bash'] })
  const inspected = await rt.sessions.inspect(proj.hubSessionId!)
  expect(inspected.activeTools).not.toContain('bash')
  expect(inspected.activeTools).toContain('read')

  // #11: Owner DM timers tool uses adapter timezone ('America/New_York') even when process.env.TZ differs
  const prevTz = process.env.TZ
  process.env.TZ = 'Asia/Tokyo'
  try {
    fake.deliver(
      larkEvent({
        chat_id: 'oc_dm_alice',
        chat_type: 'p2p',
        message_id: 'om_dm_tz',
        content: JSON.stringify({ text: 'Check timezone' }),
        mentions: undefined,
      }),
    )
    await waitFor(
      () => fake.sends.some((s) => s.chatId === 'oc_dm_alice'),
      'DM reply delivered',
    )
    expect(dmTimerTimezone).toBe('America/New_York')
  } finally {
    process.env.TZ = prevTz
  }

  // #17: Host post author persists across adapter unregister & fresh adapter registration
  const posted = await rt.channels.submit('lark', {
    chatId: 'oc_chat_a',
    sessionId: proj.hubSessionId!,
    author: { id: 'liam', name: 'Liam' },
    text: 'Check staging deploy',
  })
  expect(posted.outcome).toBe('posted')
  fake.searchResults.push({
    message_id: posted.messageId!,
    create_time: String(Date.now()),
    msg_type: 'text',
    body: { content: JSON.stringify({ text: 'Liam: Check staging deploy' }) },
    sender: { id: 'ou_bot', sender_type: 'app' },
  })
  await rt.unregisterChannel('lark')
  const adapter2 = createLarkChannelAdapter({
    appId: 'ou_bot',
    owners: ['ou_alice'],
    chats: ['oc_chat_a'],
    transport: fake.transport,
    logger: silentLogger,
  })
  await rt.registerChannel(adapter2)
  const histPage = await rt.sessions.messages({ sessionId: proj.hubSessionId! })
  expect(histPage.messages[0]).toMatchObject({
    id: posted.messageId,
    role: 'user',
    senderName: 'Liam',
    text: 'Check staging deploy',
  })

  // #14: Passive batch marks the NEWEST passive message with DONE
  const pmTransport = createControlledTransport()
  const pmEvents: Array<(e: unknown) => void> = []
  const pmDeltas: Array<(d: unknown) => void> = []
  const activeManager = new LarkRuntimeProgressManager(
    {
      ingest: async () => {},
      listBindings: () => [
        {
          id: 'b1',
          channel: 'lark',
          externalId: 'oc_chat_a',
          threadId: null,
          kind: 'group',
          projectId: proj.id,
          sessionId: proj.hubSessionId!,
          enabled: true,
        },
      ],
      subscribeEvents: (fn) => {
        pmEvents.push(fn as (e: unknown) => void)
        return () => {}
      },
      subscribeDeltas: (fn) => {
        pmDeltas.push(fn as (d: unknown) => void)
        return () => {}
      },
    },
    pmTransport.transport,
    { isChatEnabled: () => true, isOwner: () => true, logger: silentLogger },
  )
  activeManager.start()
  activeManager.noteAdmittedInbound({
    inboxEventId: 'inb_old',
    externalChatId: 'oc_chat_a',
    messageId: 'om_p_old',
    replyToId: 'om_p_old',
    text: 'old',
    isDirect: false,
    passive: true,
  })
  activeManager.noteAdmittedInbound({
    inboxEventId: 'inb_new',
    externalChatId: 'oc_chat_a',
    messageId: 'om_p_new',
    replyToId: 'om_p_new',
    text: 'new',
    isDirect: false,
    passive: true,
  })
  for (const fn of pmEvents) {
    fn({
      type: 'run_started',
      seq: 1,
      sessionId: proj.hubSessionId!,
      projectId: proj.id,
      runId: 'run_p',
      trigger: 'channel',
      inboxEventIds: ['inb_old', 'inb_new'],
      timestamp: new Date().toISOString(),
    })
  }
  for (const fn of pmDeltas) {
    fn({
      type: 'text_delta',
      sessionId: proj.hubSessionId!,
      runId: 'run_p',
      delta: 'Noted.',
    })
  }
  for (const fn of pmEvents) {
    fn({
      type: 'run_finished',
      seq: 2,
      sessionId: proj.hubSessionId!,
      projectId: proj.id,
      runId: 'run_p',
      status: 'completed',
      timestamp: new Date().toISOString(),
    })
  }
  await Bun.sleep(20)
  expect(
    pmTransport.reactions.some(
      (r) => r.messageId === 'om_p_new' && r.emoji === 'DONE',
    ),
  ).toBe(true)
  await activeManager.stop()

  // #7: stop() completes quickly even when listMessages() hangs indefinitely
  const hungFake = createControlledTransport({ hangListMessages: true })
  const hungRt = createRuntime({
    agentDir: join(dir, 'hung'),
    logger: silentLogger,
  })
  cleanups.push(() => hungRt.dispose())
  const hungProj = await hungRt.projects.create({
    name: 'hung',
    cwd: dir,
    hubSessionId: true,
  })
  await hungRt.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_chat_a',
    threadId: null,
    kind: 'group',
    projectId: hungProj.id,
    enabled: true,
  })
  await hungRt.registerChannel(
    createLarkChannelAdapter({
      appId: 'ou_bot',
      owners: ['ou_alice'],
      chats: ['oc_chat_a'],
      transport: hungFake.transport,
      logger: silentLogger,
    }),
  )
  hungFake.deliver(
    larkEvent({
      message_id: 'om_hung',
      content: JSON.stringify({ text: '@_user_1 stuck history' }),
    }),
  )
  await Bun.sleep(30)
  const stopStart = performance.now()
  await hungRt.unregisterChannel('lark')
  expect(performance.now() - stopStart).toBeLessThan(400)
}, 15_000)

test('R2 #8,#18,#19 & zero legacy-channels import in Runtime eval path', async () => {
  const dir = makeTempDir('vela-r2-eval-')
  const repoRoot = resolve(import.meta.dir, '../../../..')

  // #8: grade('G7') passes when reading from normalized project memory dir
  const g7Art = join(dir, 'g7-art')
  const checksG7 = grade('G7', {
    inputs: [
      { topicRootId: 'g7_store', text: 'Remember staging server kestrel' },
      { topicRootId: 'g7_recall', text: 'What is the staging server called?' },
    ],
    recallPaths: {
      workspace: join(g7Art, 'data', 'projects', 'p1', 'workspace'),
      artifactDir: g7Art,
    },
    recallMemory: [],
    memoryEntries: [
      { name: 'staging', content: 'The staging server is kestrel.' },
    ],
    calls: [
      {
        name: 'memory',
        args: { action: 'write', name: 'staging', content: 'kestrel' },
        phase: 0,
        sessionId: 'lark-oc_group-g7_store',
        success: true,
      },
      {
        name: 'read',
        args: { path: '../memory/staging.md' },
        phase: 1,
        sessionId: 'lark-oc_group-g7_recall',
        success: true,
        output: 'The staging server is called kestrel.',
      },
    ],
    deliveries: [
      { scope: 'topic', topicRootId: 'g7_recall', text: 'It is kestrel.' },
    ],
    answers: ['It is kestrel.'],
    topics: [],
    compactions: [],
    files: {},
    changed: [],
    validation: {},
  })
  expect(checksG7.every((c) => c.pass)).toBe(true)

  // #18: Failed /dream returns error in runAttempt('G8', { dream: true })
  const cwdG8 = join(dir, 'g8-cwd')
  const artG8 = join(dir, 'g8-art')
  mkdirSync(cwdG8, { recursive: true })
  mkdirSync(artG8, { recursive: true })
  initGitRepo(cwdG8)
  const modelG8 = createFauxModel({
    responses: [fauxText('Noted staging deploy.')],
    // /dream generate call fails so [dream] reports failure
    generate: [() => ({ error: 'Simulated dream failure' })],
  })
  const attG8 = await runAttempt(
    {
      runtime: repoRoot,
      cwd: cwdG8,
      artifactDir: artG8,
      scenario: 'G8',
      arm: 'new',
      run: 1,
      attempt: 1,
      thinking: 'medium',
      dream: true,
    },
    'test-key',
    modelG8,
  )
  // Expect Dream failure NOT silently masked (either attempt errored or memory entries check catches missing dream)
  expect(attG8.status === 'error' || attG8.status === 'fail').toBe(true)

  // #19: G10 records newly created symlinks in evidence.changed
  const cwdG10 = join(dir, 'g10-cwd')
  const artG10 = join(dir, 'g10-art')
  mkdirSync(cwdG10, { recursive: true })
  mkdirSync(artG10, { recursive: true })
  initGitRepo(cwdG10)
  const g10Workspace = join(
    artG10,
    'data',
    'projects',
    'lark-oc_group',
    'workspace',
  )
  const modelG10 = createFauxModel({
    responses: [
      () => {
        symlinkSync('/etc/hosts', join(g10Workspace, 'task', 'evil-link'))
        return fauxText('Ignored.')
      },
    ],
  })
  const attG10 = await runAttempt(
    {
      runtime: repoRoot,
      cwd: cwdG10,
      artifactDir: artG10,
      scenario: 'G10',
      arm: 'new',
      run: 1,
      attempt: 1,
      thinking: 'medium',
    },
    'test-key',
    modelG10,
  )
  expect(attG10.evidence?.changed).toContain('task/evil-link')
  expect(attG10.status).toBe('fail')

  // Runtime eval runner loads ZERO modules from src/legacy-channels/
  const importProbe = execFileSync(
    'bun',
    [
      '-e',
      `await import(${JSON.stringify(join(repoRoot, 'scripts/eval/runtime-lark.ts'))}); console.log(Object.keys(require.cache).filter(p => p.includes('/src/legacy-channels/')).length);`,
    ],
    { encoding: 'utf8' },
  ).trim()
  expect(importProbe).toBe('0')
})

test('PR #601 Codex P2-1 & P2-2: busy steer preserves image/file attachments and config reload clears removed managed keys', async () => {
  const dir = makeTempDir('vela-codex-p2-')
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
  ])

  // P2-1a: Trigger image (omitted mimeType) steers with inferred image/png AND file attachment stays queued for staged next turn
  const topicHold = join(dir, 'topic-att-hold')
  let topicStarted = false
  let steeredImgPrompt = ''
  let queuedFilePrompt = ''
  const fake = createControlledTransport()
  fake.resources.set('img_busy_1', [pngBytes])
  fake.resources.set('file_busy_1', [Buffer.from('staged-file-body\n')])

  const model = createFauxModel({
    responses: [
      () => {
        topicStarted = true
        return fauxToolCall('bash', {
          command: `while [ ! -f ${JSON.stringify(topicHold)} ]; do sleep 0.02; done; echo ok`,
        })
      },
      (req) => {
        steeredImgPrompt = JSON.stringify(req.prompt)
        return fauxText('Initial topic reply with steered image')
      },
      (req) => {
        queuedFilePrompt = JSON.stringify(req.prompt)
        return fauxText('Follow-up saw staged file path')
      },
    ],
  })
  const rt = createRuntime({
    agentDir: join(dir, 'rt-att'),
    defaultModel: model,
    logger: silentLogger,
  })
  cleanups.push(() => rt.dispose())

  const proj = await rt.projects.create({
    name: 'oc_chat_a',
    cwd: dir,
    hubSessionId: true,
  })
  await rt.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_chat_a',
    threadId: null,
    kind: 'group',
    projectId: proj.id,
    enabled: true,
  })
  await rt.registerChannel(
    createLarkChannelAdapter({
      appId: 'ou_bot',
      owners: ['ou_alice'],
      chats: ['oc_chat_a'],
      transport: fake.transport,
      logger: silentLogger,
    }),
  )

  fake.deliver(
    larkEvent({
      message_id: 'om_att_hold',
      thread_id: 'omt_att',
      root_id: 'om_att_root',
      content: JSON.stringify({ text: '@_user_1 wait for attachment' }),
    }),
  )
  await waitFor(() => topicStarted, 'topic attachment hold started')
  fake.deliver(
    larkEvent({
      message_id: 'om_att_img',
      thread_id: 'omt_att',
      root_id: 'om_att_root',
      message_type: 'image',
      content: JSON.stringify({ image_key: 'img_busy_1' }),
      mentions: undefined,
    }),
  )
  fake.deliver(
    larkEvent({
      message_id: 'om_att_file',
      thread_id: 'omt_att',
      root_id: 'om_att_root',
      message_type: 'file',
      content: JSON.stringify({
        file_key: 'file_busy_1',
        file_name: 'report.txt',
      }),
      mentions: undefined,
    }),
  )
  await waitFor(
    () => fake.resources.has('img_busy_1') && steeredImgPrompt === '',
    'ready',
  )
  await Bun.sleep(80)
  writeFileSync(topicHold, 'go')
  await rt.waitForIdle()
  expect(steeredImgPrompt).toContain('"mediaType":"image/png"')
  expect(steeredImgPrompt).toContain(pngBytes.toString('base64'))
  expect(queuedFilePrompt).toContain('[file: report.txt]')
  expect(queuedFilePrompt).toContain('report.txt')
  expect(queuedFilePrompt).toMatch(/saved at .*report\.txt/)
  expect(fake.replies.map((r) => r.text).join('\n')).toContain(
    'Follow-up saw staged file path',
  )

  // P2-1b: inlineOnly image without mimeType still infers image/png and steers cleanly
  const inlineHold = join(dir, 'inline-hold')
  let inlineStarted = false
  let steeredInlinePrompt = ''
  const inlineModel = createFauxModel({
    responses: [
      () => {
        inlineStarted = true
        return fauxToolCall('bash', {
          command: `while [ ! -f ${JSON.stringify(inlineHold)} ]; do sleep 0.02; done; echo ok`,
        })
      },
      (req) => {
        steeredInlinePrompt = JSON.stringify(req.prompt)
        return fauxText('Steered inline png ok')
      },
    ],
  })
  const inlineRt = createRuntime({
    agentDir: join(dir, 'rt-inline'),
    defaultModel: inlineModel,
    logger: silentLogger,
  })
  cleanups.push(() => inlineRt.dispose())
  const inlineProj = await inlineRt.projects.create({
    name: 'inline',
    cwd: dir,
    hubSessionId: true,
  })
  const inlineSessId = inlineProj.hubSessionId!
  let inlineCtx!: Parameters<
    Parameters<typeof inlineRt.registerChannel>[0]['start']
  >[0]
  await inlineRt.registerChannel({
    name: 'mock-inline',
    async start(ctx) {
      inlineCtx = ctx
    },
    async stop() {},
    async deliver() {
      return { externalMessageId: 'd-inline-1' }
    },
    async fetchAttachment() {
      return pngBytes
    },
  })
  inlineRt.bindings.upsert({
    channel: 'mock-inline',
    externalId: 'chat_inline',
    threadId: null,
    kind: 'group',
    projectId: inlineProj.id,
    enabled: true,
  })
  await inlineCtx.ingestWithReceipt!({
    channel: 'mock-inline',
    dedupeKey: 'hold-inline',
    externalChatId: 'chat_inline',
    kind: 'group',
    senderId: 'u1',
    senderName: 'Alice',
    text: 'hold',
    timestamp: new Date().toISOString(),
  })
  await waitFor(() => inlineStarted, 'inline hold started')
  const receipt = await inlineCtx.ingestWithReceipt!({
    channel: 'mock-inline',
    dedupeKey: 'steer-inline-img',
    externalChatId: 'chat_inline',
    kind: 'group',
    senderId: 'u1',
    senderName: 'Alice',
    text: 'look at this inline img',
    attachments: [{ ref: 'inline_clip_1', name: 'clip.bin', inlineOnly: true }],
    timestamp: new Date().toISOString(),
  })
  expect(
    await inlineCtx.steerInboxEvent!(
      inlineSessId,
      receipt.inboxEventId!,
      'look at this inline img',
    ),
  ).toBe(true)
  writeFileSync(inlineHold, 'go')
  await inlineRt.waitForIdle()
  expect(steeredInlinePrompt).toContain(pngBytes.toString('base64'))

  // P2-2: Removing `readUntagged: false` from lark chat config removes stale false on reload
  const daemonDir = join(dir, 'daemon-p2')
  mkdirSync(daemonDir, { recursive: true })
  const cfgPath = join(daemonDir, 'config.json')
  writeFileSync(
    cfgPath,
    JSON.stringify({
      lark: {
        owners: ['ou_alice'],
        chats: [{ id: 'oc_chat_p2', readUntagged: false }],
      },
    }),
  )
  const daemonFake = createControlledTransport()
  const handle = await startDaemonServer({
    agentDir: daemonDir,
    registerSignalHandlers: false,
    larkTransport: daemonFake.transport,
    logger: silentLogger,
  })
  cleanups.push(() => handle.close('test'))

  const initial = (
    await handle.runtime.bindings.list({ channel: 'lark' })
  ).find((b) => b.externalId === 'oc_chat_p2')
  expect(initial?.config?.readUntagged).toBe(false)

  writeFileSync(
    cfgPath,
    JSON.stringify({
      lark: {
        owners: ['ou_alice'],
        chats: [{ id: 'oc_chat_p2' }],
      },
    }),
  )
  await handle.runtime.reloadConfig()
  const reloaded = (
    await handle.runtime.bindings.list({ channel: 'lark' })
  ).find((b) => b.externalId === 'oc_chat_p2')
  expect(reloaded?.config?.readUntagged).toBeUndefined()
})
