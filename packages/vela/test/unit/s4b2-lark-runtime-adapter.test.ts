import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
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
  fauxHang,
  fauxText,
  fauxToolCall,
} from '../../src/testing/core/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

function makeTempDir(prefix = 'vela-s4b2-adapter-'): string {
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

function createFakeTransport() {
  let onMessage: ((event: LarkMessageEvent) => void) | undefined
  let onAction: ((event: LarkCardAction) => LarkCardResponse) | undefined
  const sent: Array<{ chatId?: string; messageId?: string; text: string }> = []
  const sentFiles: Array<{
    chatId: string
    kind: 'image' | 'file'
    name: string
    bytes: Uint8Array
    replyToId?: string
    replyInThread?: boolean
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
  const topics: Array<{ messageId: string; title: string }> = []
  const forwards: Array<{ messageId: string; threadId: string }> = []
  const resources = new Map<string, Buffer[]>()
  const names = new Map<string, string>([
    ['ou_alice', 'Alice'],
    ['ou_bob', 'Bob'],
  ])
  const history: LarkHistoryMessage[] = []
  const topicHistory: LarkHistoryMessage[][] = []
  const searchResults: LarkHistoryMessage[] = []

  const transport: LarkTransport = {
    start: async (msgHandler, actionHandler) => {
      onMessage = msgHandler
      onAction = actionHandler
    },
    stop: () => {},
    startTopic: async (messageId, title) => {
      topics.push({ messageId, title })
      return {
        messageId: `topic_${messageId}`,
        rootId: messageId,
        threadId: `thread_${messageId}`,
        createTime: String(Date.now()),
      }
    },
    forward: async (messageId, threadId) => {
      forwards.push({ messageId, threadId })
      return {
        messageId: `forward_${messageId}`,
        createTime: String(Date.now()),
      }
    },
    send: async (chatId, text) => {
      sent.push({ chatId, text })
      return {
        messageId: `sent_${sent.length}`,
        createTime: String(Date.now()),
      }
    },
    reply: async (messageId, text) => {
      sent.push({ messageId, text })
      return {
        messageId: `reply_${messageId}`,
        createTime: String(Date.now()),
      }
    },
    sendFile: async (chatId, file, options) => {
      sentFiles.push({ chatId, ...file, ...options })
      return {
        messageId: `file_${sentFiles.length}`,
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
      const match = reactions.find((r) => r.id === id)
      if (match) match.removed = true
    },
    getResource: async (_messageId, key) => {
      const chunks = resources.get(key)
      if (!chunks) throw new Error(`Missing resource ${key}`)
      return Readable.from(chunks)
    },
    getBotId: async () => 'ou_bot',
    getSenderName: async (id) => names.get(id),
    listMessages: async () => [...history],
    listTopicMessages: async (_threadId, token) => {
      const page = Number(token ?? 0)
      return {
        items: topicHistory[page] ?? [],
        pageToken:
          page + 1 < topicHistory.length ? String(page + 1) : undefined,
      }
    },
    searchMessages: async () => ({
      items: [...searchResults],
    }),
  }

  return {
    transport,
    sent,
    sentFiles,
    cards,
    patches,
    reactions,
    topics,
    forwards,
    resources,
    history,
    topicHistory,
    searchResults,
    deliver: (event: LarkMessageEvent) => onMessage?.(event),
    action: (event: LarkCardAction) => onAction?.(event),
  }
}

function larkMsg(
  overrides: Partial<LarkMessageEvent['message']> = {},
  senderId = 'ou_alice',
  senderType = 'user',
): LarkMessageEvent {
  return {
    sender: { sender_type: senderType, sender_id: { open_id: senderId } },
    message: {
      chat_id: 'oc_group',
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

test('LarkChannelAdapter handles group mentions, dedup, self-ignore, owner DM vs non-owner DM', async () => {
  const dir = makeTempDir()
  const fake = createFakeTransport()
  const prompts: string[] = []
  const model = createFauxModel({
    responses: [
      (ctx) => {
        prompts.push(JSON.stringify(ctx.prompt))
        return fauxText('Reply from runtime')
      },
      (ctx) => {
        prompts.push(JSON.stringify(ctx.prompt))
        return fauxText('Owner DM reply')
      },
    ],
  })
  const runtime = createRuntime({
    agentDir: dir,
    defaultModel: model,
    logger: silentLogger,
  })
  cleanups.push(() => runtime.dispose())

  const project = await runtime.projects.create({
    name: 'oc_group',
    cwd: dir,
    hubSessionId: true,
    defaultLocation: { environment: 'local', cwd: dir },
  })
  await runtime.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_group',
    threadId: null,
    kind: 'group',
    projectId: project.id,
    enabled: true,
  })

  const adapter = createLarkChannelAdapter({
    appId: 'ou_bot',
    owners: ['ou_alice'],
    chats: ['oc_group'],
    transport: fake.transport,
    logger: silentLogger,
  })
  await runtime.registerChannel(adapter)

  // Duplicate group mention -> handled once
  const mentionEvt = larkMsg({ message_id: 'om_m1' })
  fake.deliver(mentionEvt)
  fake.deliver(mentionEvt)
  // Self bot message -> ignored
  fake.deliver(larkMsg({ message_id: 'om_self' }, 'ou_bot', 'app'))
  // Non-owner DM -> ignored
  fake.deliver(
    larkMsg(
      {
        chat_id: 'oc_dm_bob',
        chat_type: 'p2p',
        message_id: 'om_dm_bob',
        content: JSON.stringify({ text: 'secret' }),
        mentions: undefined,
      },
      'ou_bob',
    ),
  )

  await waitFor(() => fake.sent.length === 1, 'group reply')
  expect(fake.sent[0]).toEqual({
    messageId: 'om_m1',
    text: 'Reply from runtime',
  })
  expect(prompts[0]).toContain('Alice: hello')

  // Owner DM -> accepted and creates direct session
  fake.deliver(
    larkMsg(
      {
        chat_id: 'oc_dm_alice',
        chat_type: 'p2p',
        message_id: 'om_dm_alice',
        content: JSON.stringify({ text: 'owner ping' }),
        mentions: undefined,
      },
      'ou_alice',
    ),
  )
  await waitFor(() => fake.sent.length === 2, 'owner DM reply')
  expect(fake.sent[1]).toEqual({
    chatId: 'oc_dm_alice',
    text: 'Owner DM reply',
  })
  expect(adapter.status().connected).toBe(true)
})

test('LarkChannelAdapter supports passive group evaluation, skip_reply, readUntagged: false, and topic routing', async () => {
  const dir = makeTempDir()
  const fake = createFakeTransport()
  const model = createFauxModel({
    responses: [
      // 1. Passive message in oc_passive -> model chooses skip_reply
      () => fauxToolCall('skip_reply', { reason: 'casual chat' }),
      () => fauxText(''),
      // 2. Passive burst in oc_passive -> model replies with replyToMessageId preserved
      () => fauxText('Passive answer for Bob'),
      // 3. Mentioned topic message -> creates topic session & replies
      () => fauxText('Topic answer 1'),
      // 4. Follow-up unmentioned in same topic -> routes to existing topic session
      () => fauxText('Topic answer 2'),
    ],
  })
  const runtime = createRuntime({
    agentDir: dir,
    defaultModel: model,
    logger: silentLogger,
  })
  cleanups.push(() => runtime.dispose())

  const p1 = await runtime.projects.create({
    name: 'oc_passive',
    cwd: dir,
    hubSessionId: true,
  })
  const p2 = await runtime.projects.create({
    name: 'oc_strict',
    cwd: dir,
    hubSessionId: true,
  })
  await runtime.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_passive',
    threadId: null,
    kind: 'group',
    projectId: p1.id,
    enabled: true,
    config: { readUntagged: true },
  })
  await runtime.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_strict',
    threadId: null,
    kind: 'group',
    projectId: p2.id,
    enabled: true,
    config: { readUntagged: false },
  })

  await runtime.registerChannel(
    createLarkChannelAdapter({
      appId: 'ou_bot',
      owners: ['ou_alice'],
      chats: [
        { id: 'oc_passive', readUntagged: true },
        { id: 'oc_strict', readUntagged: false },
      ],
      transport: fake.transport,
      logger: silentLogger,
    }),
  )

  // Untagged in oc_strict -> completely ignored
  fake.deliver(
    larkMsg({
      chat_id: 'oc_strict',
      message_id: 'om_strict_1',
      content: JSON.stringify({ text: 'untagged ignored' }),
      mentions: undefined,
    }),
  )
  // Passive in oc_passive -> model skips reply (reaction removed, no sent msg)
  fake.deliver(
    larkMsg(
      {
        chat_id: 'oc_passive',
        message_id: 'om_pass_1',
        content: JSON.stringify({ text: 'just chatting' }),
        mentions: undefined,
      },
      'ou_bob',
    ),
  )
  await waitFor(
    async () =>
      (await runtime.sessions.list()).some(
        (s) => s.projectId === p1.id && s.state === 'idle',
      ),
    'skip_reply completed cleanly',
  )
  await runtime.waitForIdle()
  expect(
    fake.reactions.filter((r) => r.messageId === 'om_pass_1'),
  ).toHaveLength(0)
  expect(fake.sent).toHaveLength(0)

  // Passive in oc_passive that chooses to reply -> keeps replyToMessageId
  fake.deliver(
    larkMsg(
      {
        chat_id: 'oc_passive',
        message_id: 'om_pass_2',
        content: JSON.stringify({ text: 'anyone know CI status?' }),
        mentions: undefined,
      },
      'ou_bob',
    ),
  )
  await waitFor(() => fake.sent.length === 1, 'passive reply sent')
  expect(fake.sent[0]).toEqual({
    messageId: 'om_pass_2',
    text: 'Passive answer for Bob',
  })

  // Unmentioned message in unknown thread -> ignored (requireExistingSession)
  fake.deliver(
    larkMsg({
      chat_id: 'oc_passive',
      message_id: 'om_unknown_topic',
      thread_id: 'omt_unknown',
      root_id: 'om_unknown_root',
      content: JSON.stringify({ text: 'unmentioned unknown topic' }),
      mentions: undefined,
    }),
  )

  // Mentioned message in topic -> creates topic binding & replies
  fake.deliver(
    larkMsg({
      chat_id: 'oc_passive',
      message_id: 'om_t_1',
      thread_id: 'omt_known',
      root_id: 'om_t_root',
      content: JSON.stringify({ text: '@_user_1 check topic' }),
    }),
  )
  await waitFor(() => fake.sent.length === 2, 'topic reply 1')
  expect(fake.sent[1]).toEqual({
    messageId: 'om_t_1',
    text: '<at user_id="ou_alice"></at> Topic answer 1',
  })

  // Follow-up unmentioned in omt_known -> routes to existing topic session
  fake.deliver(
    larkMsg({
      chat_id: 'oc_passive',
      message_id: 'om_t_2',
      thread_id: 'omt_known',
      root_id: 'om_t_root',
      content: JSON.stringify({ text: 'follow up without @' }),
      mentions: undefined,
    }),
  )
  await waitFor(() => fake.sent.length === 3, 'topic reply 2')
  expect(fake.sent[2]).toEqual({
    messageId: 'om_t_2',
    text: '<at user_id="ou_alice"></at> Topic answer 2',
  })
})

test('LarkChannelAdapter handles attachments, FileTooLarge, unsupported message types, deliver(topic_start/forward/file), and announce', async () => {
  const dir = makeTempDir()
  const fake = createFakeTransport()
  fake.resources.set('img_ok', [
    Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
      'hex',
    ),
  ])
  fake.resources.set('file_big', [Buffer.alloc(21 * 1024 * 1024)])

  const model = createFauxModel({
    responses: [() => fauxText('Saw image')],
  })
  const runtime = createRuntime({
    agentDir: dir,
    defaultModel: model,
    logger: silentLogger,
  })
  cleanups.push(() => runtime.dispose())

  const project = await runtime.projects.create({
    name: 'oc_group',
    cwd: dir,
    hubSessionId: true,
  })
  await runtime.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_group',
    threadId: null,
    kind: 'group',
    projectId: project.id,
    enabled: true,
  })

  const adapter = createLarkChannelAdapter({
    appId: 'ou_bot',
    owners: ['ou_alice'],
    chats: ['oc_group'],
    transport: fake.transport,
    logger: silentLogger,
  })
  await runtime.registerChannel(adapter)

  // Unsupported sticker -> immediate reply
  fake.deliver(
    larkMsg({
      message_id: 'om_sticker',
      message_type: 'sticker',
      content: JSON.stringify({ file_key: 'st_1' }),
    }),
  )
  await waitFor(() => fake.sent.length === 1, 'unsupported message reply')
  expect(fake.sent[0]?.text).toContain('Only text, images and files')

  // Oversized file -> FileTooLarge reply
  fake.deliver(
    larkMsg({
      message_id: 'om_big',
      message_type: 'file',
      content: JSON.stringify({ file_key: 'file_big', file_name: 'huge.zip' }),
    }),
  )
  await waitFor(() => fake.sent.length === 2, 'file too large reply')
  expect(fake.sent[1]?.text).toBe('File too large. The limit is 20MB.')

  // Valid image attachment -> routed into model turn
  fake.deliver(
    larkMsg({
      message_id: 'om_img',
      message_type: 'image',
      content: JSON.stringify({ image_key: 'img_ok' }),
    }),
  )
  await waitFor(() => fake.sent.length === 3, 'image reply')
  expect(fake.sent[2]).toEqual({ messageId: 'om_img', text: 'Saw image' })

  // Direct adapter delivery kinds: topic_start, forward, file, announce
  const topicRes = await adapter.deliver({
    outboxId: 'ob-topic',
    kind: 'topic_start',
    channel: 'lark',
    externalChatId: 'oc_group',
    text: 'Incident #42',
  })
  expect(topicRes).toEqual({
    externalMessageId: 'topic_sent_4',
    threadId: 'thread_sent_4',
    rootId: 'sent_4',
  })

  const fwdRes = await adapter.deliver({
    outboxId: 'ob-fwd',
    kind: 'forward',
    channel: 'lark',
    externalChatId: 'oc_group',
    threadId: 'thread_sent_4',
    forwardMessageId: 'om_orig',
    text: '',
  })
  expect(fwdRes).toEqual({
    externalMessageId: 'forward_om_orig',
    threadId: 'thread_sent_4',
  })

  const txtFile = join(dir, 'notes.txt')
  writeFileSync(txtFile, 'hello attachment')
  const fileRes = await adapter.deliver({
    outboxId: 'ob-file',
    kind: 'file',
    channel: 'lark',
    externalChatId: 'oc_group',
    threadId: 'thread_sent_4',
    text: '',
    files: [{ path: txtFile, name: 'notes.txt' }],
  })
  expect(fileRes).toEqual({ externalMessageId: 'file_1' })
  expect(fake.sentFiles[0]).toMatchObject({
    chatId: 'oc_group',
    kind: 'file',
    name: 'notes.txt',
    replyToId: 'sent_4',
    replyInThread: true,
  })

  const ann = await adapter.announce!({
    externalChatId: 'oc_group',
    text: 'Build finished',
    idempotencyKey: 'ann-1',
  })
  expect(ann?.externalMessageId).toBeDefined()
})

test('LarkChannelAdapter supports listChats, listMessages, submitFromHost, lark_search_history, and run-control card stop', async () => {
  const dir = makeTempDir()
  const fake = createFakeTransport()
  fake.searchResults.push({
    message_id: 'hist_1',
    create_time: '1700000000000',
    msg_type: 'text',
    body: { content: JSON.stringify({ text: 'Release checklist ready' }) },
    sender: { id: 'ou_bob', sender_type: 'user' },
  })
  fake.history.push({
    message_id: 'h_root',
    create_time: '1700000001000',
    msg_type: 'text',
    body: { content: JSON.stringify({ text: 'Recent group ping' }) },
    sender: { id: 'ou_alice', sender_type: 'user' },
  })

  let slowStarted = false
  const model = createFauxModel({
    responses: [
      () => fauxToolCall('lark_search_history', { query: 'release' }),
      (ctx) => {
        const toolOutput = JSON.stringify(ctx.prompt)
        return fauxText(
          toolOutput.includes('Release checklist ready')
            ? 'Searched and found release checklist'
            : 'Missing search result',
        )
      },
      () => {
        slowStarted = true
        return fauxHang()
      },
    ],
  })

  const runtime = createRuntime({
    agentDir: dir,
    defaultModel: model,
    logger: silentLogger,
  })
  cleanups.push(() => runtime.dispose())

  const project = await runtime.projects.create({
    name: 'oc_group',
    cwd: dir,
    hubSessionId: true,
  })
  await runtime.bindings.upsert({
    channel: 'lark',
    externalId: 'oc_group',
    threadId: null,
    kind: 'group',
    projectId: project.id,
    enabled: true,
  })

  const adapter = createLarkChannelAdapter({
    appId: 'ou_bot',
    owners: ['ou_alice'],
    chats: ['oc_group'],
    transport: fake.transport,
    logger: silentLogger,
  })
  await runtime.registerChannel(adapter)

  fake.topicHistory.push([
    {
      message_id: 'th_1',
      create_time: '1700000002000',
      msg_type: 'text',
      body: { content: JSON.stringify({ text: 'Topic thread history' }) },
      sender: { id: 'ou_alice', sender_type: 'user' },
    },
  ])
  expect(await adapter.listChats()).toEqual([{ chatId: 'oc_group' }])
  const page = await adapter.listMessages({
    sessionId: 's-1',
    externalChatId: 'oc_group',
    kind: 'group',
  })
  expect(page.messages[0]?.text).toContain('Release checklist ready')
  const topicPage = await adapter.listMessages({
    sessionId: 's-1',
    externalChatId: 'oc_group',
    threadId: 'omt_hist',
    kind: 'group',
  })
  expect(topicPage.messages[0]?.text).toContain('Topic thread history')

  // 1. Trigger tool call turn via submitFromHost
  const submitted = await adapter.submitFromHost({
    chatId: 'oc_group',
    sessionId: project.hubSessionId!,
    author: { id: 'liam', name: 'Liam' },
    text: 'Find release notes',
  })
  expect(submitted.outcome).toBe('posted')
  await waitFor(
    () =>
      fake.sent.some((m) => m.text === 'Searched and found release checklist'),
    'lark_search_history answer',
  )

  // Unconfigured chat rejects host submit
  const disabledSubmit = await adapter.submitFromHost({
    chatId: 'oc_unknown',
    sessionId: 'missing-sid',
    author: { id: 'liam', name: 'Liam' },
    text: 'No such chat',
  })
  expect(disabledSubmit.outcome).toBe('not-sent')

  // 2. Busy run + second inbound message posts run-control card and stop callback cancels run
  fake.deliver(
    larkMsg({
      message_id: 'om_slow',
      content: JSON.stringify({ text: '@_user_1 start slow work' }),
    }),
  )
  await waitFor(() => slowStarted, 'slow turn started')

  fake.deliver(
    larkMsg({
      message_id: 'om_interrupt',
      content: JSON.stringify({ text: '@_user_1 interrupt now' }),
    }),
  )
  await waitFor(
    () =>
      fake.cards.some((c) =>
        JSON.stringify(c.card).includes('"action":"stop"'),
      ),
    'run-control card posted',
  )

  const controlCard = fake.cards.find((c) =>
    JSON.stringify(c.card).includes('"action":"stop"'),
  )!
  const stopButton = controlCard.card.body.elements
    .flatMap((el) => el.columns ?? [])
    .flatMap((col) => col.elements ?? [])
    .flatMap((btn) => btn.behaviors ?? [])
    .find(
      (b) =>
        b.type === 'callback' &&
        typeof b.value === 'object' &&
        b.value !== null &&
        (b.value as { action?: string }).action === 'stop',
    )!

  const callbackRes = fake.action({
    operator: { open_id: 'ou_alice' },
    context: { open_chat_id: 'oc_group' },
    action: { value: stopButton.value },
  })
  expect(callbackRes?.toast?.content).toBe('Stopping the current run.')
  await waitFor(
    () => fake.reactions.some((r) => r.messageId === 'om_slow' && r.removed),
    'slow run finished/stopped cleanly',
  )
})
