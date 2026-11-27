import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { connectRuntime } from '../../src/daemon/client.ts'
import {
  acquireOwnerLock,
  DaemonAlreadyRunningError,
} from '../../src/daemon/owner-lock.ts'
import { startDaemonServer } from '../../src/daemon/server.ts'
import {
  createLarkChannelAdapter,
  type LarkCard,
  type LarkCardAction,
  type LarkCardResponse,
  type LarkHistoryMessage,
  type LarkMessageEvent,
  type LarkTransport,
} from '../../src/lark/index.ts'
import { createRuntime } from '../../src/runtime-sdk.ts'
import { silentLogger } from '../../src/shared/logger.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../src/testing/core/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

function makeTempDir(prefix = 'vela-s4b2-r1-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
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

function createProbeTransport(opts?: {
  historyDelayMs?: number
  failStart?: boolean
  slowGetBotIdMs?: number
}) {
  let onMessage: ((event: LarkMessageEvent) => void) | undefined
  let onAction: ((event: LarkCardAction) => LarkCardResponse) | undefined
  const sends: Array<{ chatId: string; text: string; uuid?: string }> = []
  const replies: Array<{ messageId: string; text: string; uuid?: string }> = []
  const topicStarts: Array<{
    messageId: string
    title: string
    uuid?: string
  }> = []
  const forwards: Array<{
    messageId: string
    threadId: string
    uuid?: string
  }> = []
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
  let stoppedCalls = 0
  let deliveredCount = 0

  const transport: LarkTransport = {
    start: async (msgHandler, actionHandler) => {
      if (opts?.failStart) throw new Error('boom on start')
      onMessage = msgHandler
      onAction = actionHandler
    },
    stop: () => {
      stoppedCalls++
    },
    getBotId: async () => {
      if (opts?.slowGetBotIdMs) await Bun.sleep(opts.slowGetBotIdMs)
      return 'ou_bot'
    },
    getSenderName: async (id) => (id === 'ou_alice' ? 'Alice' : 'Bob'),
    send: async (chatId, text, uuid) => {
      sends.push({ chatId, text, uuid })
      deliveredCount++
      return {
        messageId: `sent_${deliveredCount}`,
        createTime: String(Date.now()),
      }
    },
    reply: async (messageId, text, uuid) => {
      replies.push({ messageId, text, uuid })
      deliveredCount++
      return {
        messageId: `reply_${deliveredCount}`,
        createTime: String(Date.now()),
      }
    },
    startTopic: async (messageId, title, uuid) => {
      topicStarts.push({ messageId, title, uuid })
      deliveredCount++
      return {
        messageId: `topicmsg_${deliveredCount}`,
        rootId: messageId,
        threadId: `thread_${messageId}`,
        createTime: String(Date.now()),
      }
    },
    forward: async (messageId, threadId, uuid) => {
      forwards.push({ messageId, threadId, uuid })
      deliveredCount++
      return {
        messageId: `fwd_${deliveredCount}`,
        createTime: String(Date.now()),
      }
    },
    sendCard: async (chatId, card, replyToId) => {
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
      const item = reactions.find((r) => r.id === id)
      if (item) item.removed = true
    },
    getResource: async (_messageId, key) => {
      const chunks = resources.get(key)
      if (!chunks) throw new Error(`Missing resource ${key}`)
      return Readable.from(chunks)
    },
    listMessages: async () => [],
    listTopicMessages: async (threadId) => {
      if (opts?.historyDelayMs) await Bun.sleep(opts.historyDelayMs)
      return { items: topicHistory.get(threadId) ?? [] }
    },
    searchMessages: async () => ({ items: [] }),
  }

  return {
    transport,
    sends,
    replies,
    topicStarts,
    forwards,
    cards,
    patches,
    reactions,
    resources,
    topicHistory,
    getStoppedCalls: () => stoppedCalls,
    deliver: (event: LarkMessageEvent) => onMessage?.(event),
    action: (event: LarkCardAction) => onAction?.(event),
  }
}

function makeEvent(
  overrides: Partial<LarkMessageEvent['message']> = {},
  sender = 'ou_alice',
): LarkMessageEvent {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: sender } },
    message: {
      chat_id: 'oc_group',
      chat_type: 'group',
      message_id: crypto.randomUUID(),
      create_time: String(Date.now()),
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 hi' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      ...overrides,
    },
  }
}

test('R1 #1,#2,#14: topic rootId persists across restart, thread replies & host submit use reply_in_thread (startTopic), and outbox steps have distinct UUIDs', async () => {
  const dir = makeTempDir()
  const model = createFauxModel({
    responses: [
      () => fauxText('Initial topic reply'),
      () => fauxText('Host-triggered topic reply'),
    ],
  })

  // Phase 1: create inbound topic, persist rootId in binding config
  const fake1 = createProbeTransport()
  const rt1 = createRuntime({
    agentDir: dir,
    defaultModel: model,
    logger: silentLogger,
  })
  const project = await rt1.projects.create({
    name: 'oc_group',
    cwd: dir,
    hubSessionId: true,
  })
  await rt1.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_group',
    threadId: null,
    kind: 'group',
    projectId: project.id,
    enabled: true,
  })
  const adapter1 = createLarkChannelAdapter({
    appId: 'ou_bot',
    owners: ['ou_alice'],
    chats: ['oc_group'],
    transport: fake1.transport,
    logger: silentLogger,
  })
  await rt1.registerChannel(adapter1)
  fake1.deliver(
    makeEvent({
      message_id: 'om_init',
      root_id: 'om_root_real',
      thread_id: 'omt_restart',
    }),
  )
  await waitFor(() => fake1.replies.length === 1, 'initial topic reply')
  const topicBinding = (await rt1.bindings.list({ channel: 'lark' })).find(
    (b) => b.threadId === 'omt_restart',
  )
  expect(topicBinding?.config?.rootId).toBe('om_root_real')
  await rt1.dispose()

  // Phase 2: restart fresh adapter over same DB; deliver thread-only reply & host submit without root in memory
  const fake2 = createProbeTransport()
  fake2.transport.startTopic = async (messageId, title, uuid) => {
    fake2.topicStarts.push({ messageId, title, uuid })
    return {
      messageId: `topicmsg_${fake2.topicStarts.length}`,
      rootId: messageId,
      threadId:
        messageId === 'om_root_real' ? 'omt_restart' : `thread_${messageId}`,
      createTime: String(Date.now()),
    }
  }
  const rt2 = createRuntime({
    agentDir: dir,
    defaultModel: model,
    logger: silentLogger,
  })
  cleanups.push(() => rt2.dispose())
  const adapter2 = createLarkChannelAdapter({
    appId: 'ou_bot',
    owners: ['ou_alice'],
    chats: ['oc_group'],
    transport: fake2.transport,
    logger: silentLogger,
  })
  await rt2.registerChannel(adapter2)

  // Thread-only delivery (no replyToMessageId) MUST use startTopic(rootId, ...), never group send()
  const threadOnly = await adapter2.deliver({
    outboxId: 'ob-thread-1',
    kind: 'reply',
    channel: 'lark',
    externalChatId: 'oc_group',
    threadId: 'omt_restart',
    text: 'Anchored after restart',
  })
  expect(fake2.sends).toHaveLength(0)
  expect(fake2.topicStarts).toHaveLength(1)
  expect(fake2.topicStarts[0]).toMatchObject({
    messageId: 'om_root_real',
    title: 'Anchored after restart',
    uuid: 'ob-thread-1:reply',
  })
  expect(threadOnly.threadId).toBe('omt_restart')

  // Host submit to existing topic ALSO uses startTopic(rootId, signed), never reply(omt_restart)
  const submitted = await adapter2.submitFromHost({
    chatId: 'oc_group',
    sessionId: topicBinding!.sessionId!,
    author: { id: 'liam', name: 'Liam' },
    text: 'Check restart',
  })
  expect(submitted.outcome).toBe('posted')
  expect(fake2.topicStarts[1]).toMatchObject({
    messageId: 'om_root_real',
    title: 'Liam: Check restart',
  })

  // Distinct per-step idempotency UUIDs for unanchored topic_start & forward
  await adapter2.deliver({
    outboxId: 'ob-new-topic',
    kind: 'topic_start',
    channel: 'lark',
    externalChatId: 'oc_group',
    text: 'Fresh topic',
  })
  expect(fake2.sends.at(-1)?.uuid).toBe('ob-new-topic:root')
  expect(fake2.topicStarts.at(-1)?.uuid).toBe('ob-new-topic:topic')

  await adapter2.deliver({
    outboxId: 'ob-fwd-1',
    kind: 'forward',
    channel: 'lark',
    externalChatId: 'oc_group',
    threadId: 'omt_restart',
    forwardMessageId: 'om_orig',
    text: '',
  })
  expect(fake2.forwards.at(-1)).toEqual({
    messageId: 'om_orig',
    threadId: 'omt_restart',
    uuid: 'ob-fwd-1:fwd',
  })
})

test('R1 #3,#4,#5,#6,#8,#32: reload preserves DB disable & SDK bindings, enforces chat.tools, reconciles session env/model, surfaces malformed lark, validates timezone', async () => {
  const dir = makeTempDir()
  const agentDir = join(dir, 'agent')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      tools: ['read', 'bash'],
      lark: {
        owners: ['ou_alice'],
        timezone: 'Asia/Shanghai',
        chats: [
          {
            id: 'oc_chat_1',
            tools: ['read'],
            model: 'eval/m1',
          },
        ],
      },
    }),
  )

  const fake = createProbeTransport()
  const handle = await startDaemonServer({
    agentDir,
    socketPath: join(dir, 'vela.sock'),
    hostEnv: { LARK_APP_ID: 'cli_1', LARK_APP_SECRET: 'sec_1' },
    enableLark: true,
    larkTransport: fake.transport,
    registerSignalHandlers: false,
  })
  cleanups.push(() => handle.close('test'))

  const client = await connectRuntime({
    agentDir,
    socketPath: handle.socketPath,
  })
  cleanups.push(() => client.dispose())

  // #5: inspected tools on hub and topic exclude 'bash' even though owner settings allow ['read', 'bash']
  const proj = (await handle.runtime.projects.list()).find(
    (p) => p.name === 'oc_chat_1',
  )!
  const topic = await handle.runtime.sessions.create({
    projectId: proj.id,
    kind: 'topic',
  })
  const hubInspect = await handle.runtime.sessions.inspect(proj.hubSessionId!)
  const topicInspect = await handle.runtime.sessions.inspect(topic.id)
  expect(hubInspect.activeTools).not.toContain('bash')
  expect(hubInspect.activeTools).toContain('read')
  expect(topicInspect.activeTools).not.toContain('bash')
  expect(proj.config?.timezone).toBe('Asia/Shanghai')

  // #3 + #4: SDK-created extra binding stays untouched; explicit DB disable stays disabled across reload and blocks host submits
  const extraProj = await handle.runtime.projects.create({
    name: 'oc_sdk_only',
    cwd: dir,
    hubSessionId: true,
  })
  await handle.runtime.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_sdk_only',
    threadId: null,
    kind: 'group',
    projectId: extraProj.id,
    enabled: true,
  })
  const cfgBinding = (
    await handle.runtime.bindings.list({ channel: 'lark' })
  ).find((b) => b.externalId === 'oc_chat_1')!
  await handle.runtime.bindings.setEnabled(cfgBinding.id, false)

  // #6: Reload updates environment/model -> existing hub & topic reconcile while keeping session IDs
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({
      lark: {
        owners: ['ou_alice'],
        chats: [
          {
            id: 'oc_chat_1',
            tools: ['read'],
            model: 'eval/m2',
            topicModel: 'eval/topic-m2',
          },
        ],
      },
    }),
  )
  await handle.runtime.reloadConfig()

  const afterReloadBindings = await handle.runtime.bindings.list({
    channel: 'lark',
  })
  expect(
    afterReloadBindings.find((b) => b.externalId === 'oc_chat_1')?.enabled,
  ).toBe(false)
  expect(
    afterReloadBindings.find((b) => b.externalId === 'oc_sdk_only')?.enabled,
  ).toBe(true)

  const hubAfter = await handle.runtime.sessions.get(proj.hubSessionId!)
  const topicAfter = await handle.runtime.sessions.get(topic.id)
  expect(hubAfter?.model).toBe('eval/m2')
  expect(topicAfter?.model).toBe('eval/topic-m2')

  // #4: Disabled root binding blocks submitFromHost & channels.chats()
  const activeChats = await client.channels.chats('lark')
  expect(activeChats.map((c) => c.chatId)).toEqual(['oc_sdk_only'])
  const blockedSubmit = await client.channels.submit('lark', {
    chatId: 'oc_chat_1',
    sessionId: proj.hubSessionId!,
    author: { id: 'liam', name: 'Liam' },
    text: 'Should not send',
  })
  expect(blockedSubmit.outcome).toBe('not-sent')
  expect(fake.sends).toHaveLength(0)

  // #8: Malformed top-level `"lark": []` does not crash reload and surfaces error in channels.list()
  writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ lark: [] }))
  await handle.runtime.reloadConfig()
  const badStatus = (await client.channels.list()).find(
    (c) => c.name === 'lark',
  )
  expect(badStatus?.connected).toBe(false)
  expect(badStatus?.error).toContain('lark must be an object')
})

test('R1 #9,#10,#11,#12,#13,#15,#24: per-route ordering, passive/explicit partition, atomic Steer/Stop, stop() cleanup, failed registration rollback', async () => {
  const dir = makeTempDir()

  // #15: failed start() rolls back channel registration and stops transport
  const failFake = createProbeTransport({ failStart: true })
  const rtFail = createRuntime({
    agentDir: join(dir, 'fail'),
    logger: silentLogger,
  })
  cleanups.push(() => rtFail.dispose())
  const badAdapter = createLarkChannelAdapter({
    appId: 'ou_bot',
    owners: ['ou_alice'],
    chats: ['oc_group'],
    transport: failFake.transport,
    logger: silentLogger,
  })
  await expect(rtFail.registerChannel(badAdapter)).rejects.toThrow(
    'boom on start',
  )
  expect(
    (await rtFail.channels.list()).find((c) => c.name === 'lark'),
  ).toBeUndefined()
  expect(failFake.getStoppedCalls()).toBe(1)

  // #9,#11,#12,#13: delayed history on topic creation serializes untagged follow-up + card steer runs text once + stop() cancels live writer
  const seenPrompts: string[] = []
  const releaseBusyPath = join(dir, 'release-busy')
  const releasePartitionPath = join(dir, 'release-partition')
  const waitFileCmd = (file: string) =>
    `while [ ! -f ${JSON.stringify(file)} ]; do sleep 0.02; done; echo released`
  let slowStarted = false
  let partitionStarted = false
  const model = createFauxModel({
    responses: [
      (req) => {
        seenPrompts.push(JSON.stringify(req.prompt))
        return fauxText('First topic answer')
      },
      (req) => {
        seenPrompts.push(JSON.stringify(req.prompt))
        return fauxText('Follow-up topic answer')
      },
      () => {
        slowStarted = true
        return fauxToolCall('bash', { command: waitFileCmd(releaseBusyPath) })
      },
      (req) => {
        seenPrompts.push(`STEERED:${JSON.stringify(req.prompt)}`)
        return fauxText('Recovered after steer')
      },
      () => {
        partitionStarted = true
        return fauxToolCall('bash', {
          command: waitFileCmd(releasePartitionPath),
        })
      },
      () => fauxText('Partition hold finished'),
      (req) => {
        seenPrompts.push(`BATCH1:${req.lastUserText}`)
        return fauxText('Passive batch answer')
      },
      (req) => {
        seenPrompts.push(`BATCH2:${req.lastUserText}`)
        return fauxText('Explicit batch answer')
      },
    ],
  })
  const fake = createProbeTransport({ historyDelayMs: 60 })
  fake.topicHistory.set('omt_race', [
    {
      message_id: 'th_0',
      create_time: '1000',
      msg_type: 'text',
      body: { content: JSON.stringify({ text: 'Earlier thread context' }) },
      sender: { id: 'ou_bob', sender_type: 'user' },
    },
  ])
  const rt = createRuntime({
    agentDir: join(dir, 'ok'),
    defaultModel: model,
    logger: silentLogger,
  })
  cleanups.push(() => rt.dispose())

  const proj = await rt.projects.create({
    name: 'oc_group',
    cwd: dir,
    hubSessionId: true,
  })
  await rt.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_group',
    threadId: null,
    kind: 'group',
    projectId: proj.id,
    enabled: true,
  })
  const adapter = createLarkChannelAdapter({
    appId: 'ou_bot',
    owners: ['ou_alice'],
    chats: ['oc_group'],
    transport: fake.transport,
    logger: silentLogger,
  })
  await rt.registerChannel(adapter)

  // Send @mention in new topic immediately followed by unmentioned message in same thread
  fake.deliver(
    makeEvent({
      message_id: 'om_race_1',
      thread_id: 'omt_race',
      root_id: 'om_race_root',
      content: JSON.stringify({ text: '@_user_1 first' }),
    }),
  )
  fake.deliver(
    makeEvent(
      {
        message_id: 'om_race_2',
        thread_id: 'omt_race',
        root_id: 'om_race_root',
        content: JSON.stringify({ text: 'second without @' }),
        mentions: undefined,
      },
      'ou_bob',
    ),
  )
  await waitFor(
    () => seenPrompts.length >= 2 && fake.replies.length >= 1,
    'both topic messages processed in order',
  )
  await rt.waitForIdle()
  expect(seenPrompts[0]).toContain('first')
  expect(seenPrompts[1]).toContain('second without @')

  // Busy run in hub + second message -> click 'steer': inbox item must NOT run a second time after steer
  fake.deliver(
    makeEvent({
      message_id: 'om_busy',
      content: JSON.stringify({ text: '@_user_1 start busy task' }),
    }),
  )
  await waitFor(() => slowStarted, 'busy run started')
  fake.deliver(
    makeEvent({
      message_id: 'om_steer_once',
      content: JSON.stringify({ text: '@_user_1 pivot now' }),
    }),
  )
  await waitFor(
    () =>
      fake.cards.some((c) =>
        JSON.stringify(c.card).includes('"action":"steer"'),
      ),
    'steer control card sent',
  )
  const ctrlCard = fake.cards.find((c) =>
    JSON.stringify(c.card).includes('"action":"steer"'),
  )!
  const steerBtn = ctrlCard.card.body.elements
    .flatMap((el) => el.columns ?? [])
    .flatMap((col) => col.elements ?? [])
    .flatMap((btn) => btn.behaviors ?? [])
    .find(
      (b) =>
        b.type === 'callback' &&
        typeof b.value === 'object' &&
        b.value !== null &&
        (b.value as { action?: string }).action === 'steer',
    )!
  const steerRes = fake.action({
    operator: { open_id: 'ou_alice' },
    context: { open_chat_id: 'oc_group' },
    action: { value: steerBtn.value },
  })
  expect(steerRes?.toast?.content).toBe(
    'Adding the message to the current run.',
  )
  writeFileSync(releaseBusyPath, 'go')
  await rt.waitForIdle()
  // Only ONE turn saw 'pivot now' (it was cancelled out of pending inbox when steered)
  const steerOccurrences = seenPrompts.filter((p) => p.includes('pivot now'))
  expect(steerOccurrences).toHaveLength(1)

  // #10: passive waking message + explicit @ message arriving while busy do not merge into one run
  fake.deliver(
    makeEvent({
      message_id: 'om_part_hold',
      content: JSON.stringify({ text: '@_user_1 hold session' }),
    }),
  )
  await waitFor(() => partitionStarted, 'partition hold run started')
  fake.deliver(
    makeEvent(
      {
        message_id: 'om_part_passive',
        content: JSON.stringify({ text: 'passive chatter during busy' }),
        mentions: undefined,
      },
      'ou_bob',
    ),
  )
  fake.deliver(
    makeEvent({
      message_id: 'om_part_explicit',
      content: JSON.stringify({ text: '@_user_1 explicit question' }),
    }),
  )
  await waitFor(
    () =>
      fake.cards.filter((c) =>
        JSON.stringify(c.card).includes('"action":"steer"'),
      ).length >= 2,
    'queued messages registered before releasing partition hold',
  )
  writeFileSync(releasePartitionPath, 'go')
  await rt.waitForIdle()
  const batchPrompts = seenPrompts.filter((p) => p.startsWith('BATCH'))
  expect(batchPrompts).toHaveLength(2)
  expect(batchPrompts[0]).toContain('passive chatter during busy')
  expect(batchPrompts[0]).not.toContain('explicit question')
  expect(batchPrompts[1]).toContain('explicit question')
  expect(batchPrompts[1]).not.toContain('passive chatter during busy')

  // Stop adapter cleans up without errors (wait beyond the 250ms card interval)
  await rt.unregisterChannel('lark')
  const patchCountAfterStop = fake.patches.length
  await Bun.sleep(320)
  expect(fake.patches.length).toBe(patchCountAfterStop)
})

test('R1 Owner lock serializes concurrent stale-lock check safely', async () => {
  const dir = makeTempDir('vela-s4b2-lock-')
  const lockPath = join(dir, 'daemon.lock')
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: 99999999, instanceId: 'dead-1' }),
  )
  const ownerLockMod = join(import.meta.dir, '../../src/daemon/owner-lock.ts')
  const script = `
    import { acquireOwnerLock } from ${JSON.stringify(ownerLockMod)};
    const id = process.argv[2];
    const rel = acquireOwnerLock(${JSON.stringify(lockPath)}, id, ${JSON.stringify(join(dir, 'vela.sock'))});
    console.log('ACQUIRED:' + id);
    await Bun.sleep(400);
    rel();
  `
  const p1 = Bun.spawn(['bun', '-e', script, 'live-1'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const p2 = Bun.spawn(['bun', '-e', script, 'live-2'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [c1, c2] = await Promise.all([p1.exited, p2.exited])
  const [out1, out2] = await Promise.all([
    new Response(p1.stdout).text(),
    new Response(p2.stdout).text(),
  ])
  const acquired = [out1, out2].filter((s) => s.includes('ACQUIRED:')).length
  expect(acquired).toBe(1)
  expect([c1, c2].sort()).toEqual([0, 1])

  const release = acquireOwnerLock(lockPath, 'live-3', join(dir, 'vela.sock'))
  expect(() =>
    acquireOwnerLock(lockPath, 'live-4', join(dir, 'vela.sock')),
  ).toThrow(DaemonAlreadyRunningError)
  release()
})
