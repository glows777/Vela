import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { channelSessionId } from '../../src/channels/gateway.ts'
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from '../../src/channels/types.ts'
import { feishu } from '../../src/extensions/feishu/index.ts'
import { silentLogger } from '../../src/logger.ts'
import type { ProviderContext } from '../../src/models/index.ts'
import { createFauxModel, fauxHang, fauxText } from '../../src/testing/faux.ts'
import { fakeFeishu, feishuEvent, historyMessage } from '../support/feishu.ts'
import {
  cleanupTestVelas,
  createTestVela,
  type TestVela,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Register a fake channel; returns a function that delivers messages and the replies sent */
function fakeChannel(t: TestVela, name = 'fake') {
  const sent: OutgoingMessage[] = []
  const channel: ChannelDefinition = {
    name,
    description: 'test channel',
    start: () => {},
    stop: () => {},
    send: async (message) => {
      sent.push(message)
    },
  }
  t.internals.gateway.register(channel)
  const deliver = (senderId: string, text: string, channelId = 'c1') =>
    t.internals.gateway.handleIncoming(name, {
      channelId,
      senderId,
      senderName: senderId,
      text,
    } satisfies IncomingMessage)
  return { sent, deliver }
}

test('each sender gets its own persisted session', async () => {
  // Two sessions run concurrently in no fixed order: answer based on the user message in each request
  const answer = (req: { lastUserText: string }) =>
    fauxText(`Hello ${req.lastUserText.slice(-2)}`)
  const t = createTestVela({ responses: [answer, answer] })
  const { sent, deliver } = fakeChannel(t)

  await Promise.all([deliver('u1', 'I am u1'), deliver('u2', 'I am u2')])

  expect(
    sent
      .map((m) => [m.recipientId, m.text])
      .sort((a, b) => a[0]!.localeCompare(b[0]!)),
  ).toEqual([
    ['u1', 'Hello u1'],
    ['u2', 'Hello u2'],
  ])
  expect(channelSessionId('fake', 'c1', 'u1')).toBe('fake-c1-u1')
  expect(await t.readData('sessions/fake-c1-u1.jsonl')).toContain('I am u1')
  expect(await t.readData('sessions/fake-c1-u2.jsonl')).not.toContain('I am u1')
  expect(t.eventsIn('fake-c1-u1').map((e) => e.type)).toContain('channel_reply')
  // The CLI's default session is unaffected
  expect(t.session.messages).toEqual([])
  expect(t.exists('sessions/default.jsonl')).toBe(false)
})

test('a sender continues the conversation after a restart', async () => {
  const first = createTestVela({ responses: [fauxText('Got it: blue')] })
  await fakeChannel(first).deliver('u1', 'I like blue')
  await first.cleanup({ keepDir: true })

  const second = createTestVela({
    cwd: first.cwd,
    responses: [
      (req) =>
        fauxText(
          JSON.stringify(req.prompt).includes('I like blue')
            ? 'blue'
            : "I don't know",
        ),
    ],
  })
  try {
    const { sent, deliver } = fakeChannel(second)
    await deliver('u1', 'What color do I like?')
    expect(sent.at(-1)?.text).toBe('blue')
  } finally {
    await second.cleanup()
    rmSync(first.cwd, { recursive: true, force: true })
  }
})

test('messages from the same sender are handled one after another', async () => {
  const t = createTestVela({
    responses: [
      fauxText('reply to the first'),
      fauxText('reply to the second'),
    ],
  })
  const { sent, deliver } = fakeChannel(t)

  await Promise.all([deliver('u1', 'first'), deliver('u1', 'second')])

  expect(sent.map((m) => m.text)).toEqual([
    'reply to the first',
    'reply to the second',
  ])
  // The second request sees the full history of the first round
  expect(JSON.stringify(t.model.calls[1]!.prompt)).toContain(
    'reply to the first',
  )
  expect(
    t.eventsIn('fake-c1-u1').filter((e) => e.type === 'channel_error'),
  ).toEqual([])
})

test('stopping the gateway aborts a running channel session and reports it', async () => {
  const t = createTestVela({ responses: [fauxHang()] })
  const { sent, deliver } = fakeChannel(t)

  const handled = deliver('u1', 'keep thinking')
  while (t.model.calls.length === 0) await Bun.sleep(1)
  await t.internals.gateway.stopAll()
  await handled

  expect(sent).toEqual([])
  expect(t.eventsOf('channel_error')).toMatchObject([
    { channel: 'fake', senderId: 'u1', aborted: true },
  ])
})

test('senders whose ids sanitize to the same string get separate sessions', async () => {
  // Only replacing illegal characters would put a@b and a_b, or (fake, x-y) and (fake-x, y), in the same session file, where they see each other's history
  expect(channelSessionId('fake', 'c1', 'a@b')).not.toBe(
    channelSessionId('fake', 'c1', 'a_b'),
  )
  expect(channelSessionId('fake', 'c1', 'x-y')).not.toBe(
    channelSessionId('fake-c1', 'x', 'y'),
  )
  expect(channelSessionId('fake', 'c-1', 'u')).not.toBe(
    channelSessionId('fake', 'c', '1-u'),
  )
  const long = 'u'.repeat(200)
  expect(channelSessionId('fake', 'c1', `${long}1`)).not.toBe(
    channelSessionId('fake', 'c1', `${long}2`),
  )
  expect(channelSessionId('fake', `${long}1`, 'u1')).not.toBe(
    channelSessionId('fake', `${long}2`, 'u1'),
  )
  // Ordinary ids stay readable
  expect(channelSessionId('feishu', 'oc_9', 'ou_123')).toBe(
    'feishu-oc_9-ou_123',
  )

  const t = createTestVela({
    responses: [fauxText('OK'), fauxText("I don't know")],
  })
  const { deliver } = fakeChannel(t)
  await deliver('a@b', 'My password is hunter2')
  await deliver('a_b', 'What do you know?')
  expect(JSON.stringify(t.model.calls[1]?.prompt)).not.toContain('hunter2')
})

test('a channel session closed while idle resumes its history when reopened', async () => {
  const t = createTestVela({
    responses: [
      fauxText('Got it: blue'),
      (req) =>
        fauxText(
          JSON.stringify(req.prompt).includes('I like blue')
            ? 'blue'
            : "I don't know",
        ),
    ],
  })
  const { sent, deliver } = fakeChannel(t)
  await deliver('u1', 'I like blue')
  // A long-running bot may close idle sessions to free memory
  await t.vela.session(channelSessionId('fake', 'c1', 'u1')).close()

  await deliver('u1', 'What color do I like?')
  expect(sent.at(-1)?.text).toBe('blue')
  expect(await t.readData('sessions/fake-c1-u1.jsonl')).toContain('I like blue')
})

test('idle channel sessions are closed, so many senders do not stay in memory; the next message resumes', async () => {
  const answer = (req: { lastUserText: string; prompt: unknown }) =>
    fauxText(
      JSON.stringify(req.prompt).includes('I like blue')
        ? `blue (${req.lastUserText})`
        : `ok (${req.lastUserText})`,
    )
  const t = createTestVela({
    responses: Array.from({ length: 21 }, () => answer),
    channelIdleMs: 0,
  })
  const { sent, deliver } = fakeChannel(t)
  const channelSessions = () =>
    t.vela.sessions().filter((s) => s.id.startsWith('fake-'))

  await Promise.all(
    Array.from({ length: 20 }, (_, i) => deliver(`u${i}`, `hi ${i}`)),
  )
  expect(sent).toHaveLength(20)
  // The gateway closes each session once its sender's queue is empty
  await waitFor(() => channelSessions().length === 0)

  await deliver('u1', 'I like blue')
  await waitFor(() => channelSessions().length === 0)
  expect(sent.at(-1)?.text).toBe('blue (I like blue)')
})

test('channelIdleMs that a timer cannot wait for is rejected instead of closing every session at once', () => {
  for (const channelIdleMs of [-1, 1.5, Number.POSITIVE_INFINITY, 2 ** 31])
    expect(() => createTestVela({ responses: [], channelIdleMs })).toThrow(
      'channelIdleMs must be a whole number',
    )
})

test('a channel session busy at its idle deadline is closed once that run ends, without another message', async () => {
  const t = createTestVela({
    responses: [fauxText('hi'), fauxHang()],
    channelIdleMs: 50,
  })
  const { deliver } = fakeChannel(t)
  await deliver('u1', 'hello')
  // An SDK caller (or extension) uses the same session past its deadline
  const session = t.vela.session('fake-c1-u1')
  const run = session.prompt('long task').catch(() => {})
  await Bun.sleep(150)
  expect(t.vela.sessions().map((s) => s.id)).toContain('fake-c1-u1')
  session.abort()
  await run
  await waitFor(() => !t.vela.sessions().some((s) => s.id === 'fake-c1-u1'))
})

test('a session is not closed while its sender has messages queued', async () => {
  const t = createTestVela({
    responses: [fauxText('one'), fauxText('two')],
    channelIdleMs: 0,
  })
  const { sent, deliver } = fakeChannel(t)
  await Promise.all([deliver('u1', 'first'), deliver('u1', 'second')])
  expect(sent.map((m) => m.text)).toEqual(['one', 'two'])
  // Both turns ran in the same session: the second request still saw the first exchange
  expect(JSON.stringify(t.model.calls[1]!.prompt)).toContain('first')
})

test('sessions are keyed by conversation and sender: chats and group members stay apart', async () => {
  const t = createTestVela({
    responses: [
      fauxText('OK'),
      (req) =>
        fauxText(
          JSON.stringify(req.prompt).includes('hunter2') ? 'leaked' : 'clean',
        ),
      (req) =>
        fauxText(
          JSON.stringify(req.prompt).includes('hunter2') ? 'leaked' : 'clean',
        ),
      (req) =>
        fauxText(
          JSON.stringify(req.prompt).includes('hunter2') ? 'same chat' : 'lost',
        ),
    ],
  })
  const { sent, deliver } = fakeChannel(t)

  // u1 tells a secret in a DM
  await deliver('u1', 'My password is hunter2', 'dm_u1')
  // The same person in a group chat gets a different session
  await deliver('u1', 'What do you know?', 'group')
  // Another member of that group gets their own session too
  await deliver('u2', 'What do you know?', 'group')
  // Back in the DM, the history is still there
  await deliver('u1', 'And now?', 'dm_u1')

  expect(sent.map((m) => [m.channelId, m.recipientId, m.text])).toEqual([
    ['dm_u1', 'u1', 'OK'],
    ['group', 'u1', 'clean'],
    ['group', 'u2', 'clean'],
    ['dm_u1', 'u1', 'same chat'],
  ])
  expect(t.exists('sessions/fake-dm_u1-u1.jsonl')).toBe(true)
  expect(t.exists('sessions/fake-group-u1.jsonl')).toBe(true)
  expect(t.exists('sessions/fake-group-u2.jsonl')).toBe(true)
})

test('an input handled by an extension sends no reply (not the previous answer again)', async () => {
  const t = createTestVela({
    extensions: [
      (vela) => {
        vela.on('input', (event) =>
          event.text === 'skip' ? { action: 'handled' } : undefined,
        )
      },
    ],
    responses: [fauxText('First answer')],
  })
  const { sent, deliver } = fakeChannel(t)
  await deliver('u1', 'hello')
  await deliver('u1', 'skip')
  expect(sent.map((m) => m.text)).toEqual(['First answer'])
})

test('providers see which channel a session answers on (so a local-only sign-in can refuse it)', async () => {
  const contexts: ProviderContext[] = []
  const faux = createFauxModel({
    responses: [fauxText('from channel'), fauxText('from terminal')],
  })
  const t = createTestVela({
    model: 'p/m',
    providers: {
      p: {
        createModel: (_id, ctx) => {
          contexts.push(ctx)
          return faux
        },
      },
    },
  })
  const { deliver } = fakeChannel(t)
  await deliver('u1', 'hi')
  await t.session.prompt('hi')
  expect(contexts.map((ctx) => ctx.channel())).toEqual(['fake', undefined])
})

async function feishuGateway(
  options: {
    chats?: string[]
    owners?: string[]
    responses?: Parameters<typeof createTestVela>[0]['responses']
  } = {},
) {
  const fake = fakeFeishu()
  const logs: string[] = []
  const t = createTestVela({
    responses: options.responses ?? [
      fauxText('answer'),
      fauxText('second answer'),
    ],
    allowPendingResponses: true,
    logger: {
      ...silentLogger,
      info: (line) => logs.push(line),
      warn: (line) => logs.push(line),
    },
    extensions: [
      feishu({
        appId: 'cli_bot',
        chats: options.chats ?? ['oc_group'],
        owners: options.owners ?? ['ou_alice'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  return { t, logs, ...fake }
}

test('Feishu ignores unlisted chats and stranger DMs without a model call or reply and logs their chat ids', async () => {
  const f = await feishuGateway()
  f.deliver(feishuEvent({ chat_id: 'oc_unlisted' }))
  f.deliver(feishuEvent({ chat_id: 'oc_stranger', chat_type: 'p2p' }, 'ou_bob'))
  // A later permitted turn is a barrier, so ignored events cannot hide behind async delivery.
  f.deliver(
    feishuEvent({ chat_id: 'oc_owner', chat_type: 'p2p', message_id: 'owner' }),
  )
  await waitFor(() => f.sent.length >= 1)
  expect(f.logs).toContain('[feishu] ignored message from chat oc_unlisted')
  expect(f.logs).toContain('[feishu] ignored message from chat oc_stranger')
  expect(f.t.model.calls).toHaveLength(1)
  expect(f.sent).toEqual([{ chatId: 'oc_owner', text: 'answer' }])
  expect(f.historyCalls).toEqual([])
})

test('Feishu enabled group members share a persisted owner session and both display names reach the model', async () => {
  const f = await feishuGateway()
  f.deliver(feishuEvent({ message_id: 'alice', content: '{"text":"first"}' }))
  await waitFor(() => f.sent.length === 1)
  f.deliver(
    feishuEvent({ message_id: 'bob', content: '{"text":"second"}' }, 'ou_bob'),
  )
  await waitFor(() => f.sent.length === 2)
  expect(
    f.t.vela
      .sessions()
      .filter((s) => s.channel === 'feishu')
      .map((s) => [s.id, s.role]),
  ).toEqual([['feishu-oc_group', 'owner']])
  expect(JSON.stringify(f.t.model.calls[1]?.prompt)).toContain('Alice: first')
  expect(JSON.stringify(f.t.model.calls[1]?.prompt)).toContain('Bob: second')
  expect(f.t.model.calls[1]?.tools).toContain('bash')
  expect(await f.t.readData('sessions/feishu-oc_group.jsonl')).toContain(
    'Alice: first',
  )
})

test('Feishu group messages without a bot mention, including mentions of someone else, never run', async () => {
  const f = await feishuGateway()
  f.deliver(feishuEvent({ mentions: [], message_id: 'no_at' }))
  f.deliver(
    feishuEvent({
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bob' } }],
      message_id: 'other_at',
    }),
  )
  f.deliver(feishuEvent({ message_id: 'bot_at' }))
  await waitFor(() => f.sent.length >= 1)
  expect(f.t.model.calls).toHaveLength(1)
  expect(f.sent).toEqual([{ messageId: 'bot_at', text: 'answer' }])
})

test('Feishu mention fetches earlier group messages since this bot last replied and injects them before the question', async () => {
  const f = await feishuGateway()
  f.history.push(
    historyMessage('question', 'ou_alice', 'question', '4000'),
    historyMessage('new', 'ou_bob', 'use blue', '3000'),
    {
      ...historyMessage('bot_reply', 'cli_bot', 'previous answer', '2000'),
      sender: { id: 'cli_bot', sender_type: 'app' },
    },
    historyMessage('old', 'ou_bob', 'stale detail', '1000'),
  )
  f.deliver(
    feishuEvent({
      message_id: 'question',
      create_time: '4000',
      content: '{"text":"question"}',
    }),
  )
  await waitFor(() => f.sent.length === 1)
  expect(f.historyCalls).toEqual([
    { chatId: 'oc_group', before: '4000', limit: 50 },
  ])
  expect(f.t.model.calls[0]?.lastUserText).toBe(
    '[Chat since last reply]\nBob: use blue\n\n[Question]\nAlice: question',
  )
})

test('Feishu group answers reply to each triggering message in queue order, including a second sender during a run', async () => {
  const f = await feishuGateway({
    responses: [
      () => {
        f.deliver(feishuEvent({ message_id: 'second' }, 'ou_bob'))
        return fauxText('one')
      },
      fauxText('two'),
    ],
  })
  f.deliver(feishuEvent({ message_id: 'first' }))
  await waitFor(() => f.sent.length === 2)
  expect(f.sent).toEqual([
    { messageId: 'first', text: 'one' },
    { messageId: 'second', text: 'two' },
  ])
  expect(JSON.stringify(f.t.model.calls[1]?.prompt)).toContain('one')
  expect(f.t.eventsOf('channel_error')).toEqual([])
})

test('Feishu owner DM works with empty chats, prefixes the name, and announces the empty chat configuration', async () => {
  const f = await feishuGateway({ chats: [] })
  f.deliver(feishuEvent({ chat_id: 'oc_dm', chat_type: 'p2p', mentions: [] }))
  await waitFor(() => f.sent.length === 1)
  expect(f.sent).toEqual([{ chatId: 'oc_dm', text: 'answer' }])
  expect(f.t.model.calls[0]?.lastUserText).toBe('Alice: @_user_1 hello')
  expect(f.t.vela.session('feishu-oc_dm').role).toBe('owner')
  expect(f.logs).toContain(
    '[feishu] chats is empty; only owners’ direct chats are enabled',
  )
  expect(f.historyCalls).toEqual([])
})

test('Feishu cached sender names fall back to open_id and missing history does not lose the question', async () => {
  const f = await feishuGateway()
  f.failHistory()
  f.deliver(feishuEvent({ message_id: 'one' }, 'ou_unknown'))
  await waitFor(() => f.sent.length === 1)
  f.deliver(feishuEvent({ message_id: 'two' }, 'ou_unknown'))
  await waitFor(() => f.sent.length === 2)
  expect(f.nameCalls).toEqual(['ou_unknown'])
  expect(f.t.model.calls[0]?.lastUserText).toBe('ou_unknown: hello')
  expect(
    f.logs.some((line) => line.includes('history permission denied')),
  ).toBe(true)
})
