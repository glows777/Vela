import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { channelSessionId } from '../../src/channels/gateway.ts'
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from '../../src/channels/types.ts'
import { messageTime } from '../../src/extensions/feishu/history.ts'
import { feishu } from '../../src/extensions/feishu/index.ts'
import { silentLogger } from '../../src/logger.ts'
import type { ProviderContext } from '../../src/models/index.ts'
import { memorySessionStorage } from '../../src/session/storage.ts'
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

/** `[HH:MM] ` for a Feishu create_time in the machine's local time */
const at = (ms: string) => `[${messageTime(ms)}] `

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

test('senders in one chat share a persisted session', async () => {
  // One queue preserves both senders in the shared chat history.
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
  expect(channelSessionId('fake', 'c1')).toBe('fake-c1')
  expect(await t.readData('sessions/fake-c1.jsonl')).toContain('I am u1')
  expect(await t.readData('sessions/fake-c1.jsonl')).toContain('I am u2')
  expect(t.eventsIn('fake-c1').map((e) => e.type)).toContain('channel_reply')
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
    t.eventsIn('fake-c1').filter((e) => e.type === 'channel_error'),
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

test('chat ids that sanitize to the same string still have separate sessions', async () => {
  expect(channelSessionId('fake', 'a@b')).not.toBe(
    channelSessionId('fake', 'a_b'),
  )
  expect(channelSessionId('fake', 'x-y')).not.toBe(
    channelSessionId('fake-x', 'y'),
  )
  const long = 'c'.repeat(200)
  expect(channelSessionId('fake', `${long}1`)).not.toBe(
    channelSessionId('fake', `${long}2`),
  )
  expect(channelSessionId('feishu', 'oc_9')).toBe('feishu-oc_9')
  const t = createTestVela({
    responses: [fauxText('OK'), fauxText("I don't know")],
  })
  const { deliver } = fakeChannel(t)
  await deliver('u1', 'My password is hunter2', 'a@b')
  await deliver('u1', 'What do you know?', 'a_b')
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
  await t.vela.session(channelSessionId('fake', 'c1')).close()

  await deliver('u1', 'What color do I like?')
  expect(sent.at(-1)?.text).toBe('blue')
  expect(await t.readData('sessions/fake-c1.jsonl')).toContain('I like blue')
})

test('idle channel sessions are closed, so many chats do not stay in memory; the next message resumes', async () => {
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
    Array.from({ length: 20 }, (_, i) => deliver(`u${i}`, `hi ${i}`, `c${i}`)),
  )
  expect(sent).toHaveLength(20)
  // The gateway closes each session once its chat's queue is empty
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
  const session = t.vela.session('fake-c1')
  const run = session.prompt('long task').catch(() => {})
  await Bun.sleep(150)
  expect(t.vela.sessions().map((s) => s.id)).toContain('fake-c1')
  session.abort()
  await run
  await waitFor(() => !t.vela.sessions().some((s) => s.id === 'fake-c1'))
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

test('sessions are keyed by conversation: group members share history and direct chats stay separate', async () => {
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
  // Another group member shares the group session, which still cannot see the DM
  await deliver('u2', 'What do you know?', 'group')
  // Back in the DM, the history is still there
  await deliver('u1', 'And now?', 'dm_u1')

  expect(sent.map((m) => [m.channelId, m.recipientId, m.text])).toEqual([
    ['dm_u1', 'u1', 'OK'],
    ['group', 'u1', 'clean'],
    ['group', 'u2', 'clean'],
    ['dm_u1', 'u1', 'same chat'],
  ])
  expect(t.exists('sessions/fake-dm_u1.jsonl')).toBe(true)
  expect(t.exists('sessions/fake-group.jsonl')).toBe(true)
  expect(t.vela.sessions().filter((s) => s.channel === 'fake')).toHaveLength(2)
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
    chats?: NonNullable<Parameters<typeof feishu>[0]>['chats']
    owners?: string[]
    responses?: NonNullable<Parameters<typeof createTestVela>[0]>['responses']
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

test('Feishu ignores unlisted chats and stranger DMs without a model call, reply or per-message log', async () => {
  const f = await feishuGateway()
  f.deliver(feishuEvent({ chat_id: 'oc_unlisted' }))
  f.deliver(feishuEvent({ chat_id: 'oc_stranger', chat_type: 'p2p' }, 'ou_bob'))
  // A later permitted turn is a barrier, so ignored events cannot hide behind async delivery.
  f.deliver(
    feishuEvent({ chat_id: 'oc_owner', chat_type: 'p2p', message_id: 'owner' }),
  )
  await waitFor(() => f.sent.length >= 1)
  expect(f.logs.join('\n')).not.toContain('oc_unlisted')
  expect(f.logs.join('\n')).not.toContain('oc_stranger')
  expect(f.t.model.calls).toHaveLength(1)
  expect(f.sent).toEqual([{ chatId: 'oc_owner', text: 'answer' }])
  expect(f.historyCalls).toEqual([])
})

test('Feishu enabled group members share a persisted session and both display names reach the model', async () => {
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
      .map((s) => s.id),
  ).toEqual(['feishu-oc_group'])
  expect(JSON.stringify(f.t.model.calls[1]?.prompt)).toContain('Alice: first')
  expect(JSON.stringify(f.t.model.calls[1]?.prompt)).toContain('Bob: second')
  expect(f.t.model.calls[1]?.tools).toContain('bash')
  expect(await f.t.readData('sessions/feishu-oc_group.jsonl')).toContain(
    'Alice: first',
  )
})

test('Feishu readUntagged off keeps mention-only top-level behavior', async () => {
  const f = await feishuGateway({
    chats: [{ id: 'oc_group', readUntagged: false }],
  })
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
    `[Chat since last reply]\n${at('3000')}Bob: use blue` +
      `\n\n[Question]\n${at('4000')}Alice: question`,
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

test('Feishu keeps slash command dispatch for both owner DMs and group mentions', async () => {
  const fake = fakeFeishu()
  const commands: string[] = []
  const t = createTestVela({
    responses: [],
    extensions: [
      feishu({
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
      (api) =>
        api.registerCommand('ping', {
          description: 'ping',
          handler: async (args) => {
            commands.push(args)
          },
        }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(
    feishuEvent({
      chat_id: 'oc_dm',
      chat_type: 'p2p',
      content: '{"text":"/ping dm"}',
    }),
  )
  fake.deliver(feishuEvent({ content: '{"text":"@_user_1 /ping group"}' }))
  await waitFor(() => commands.length === 2)
  expect(commands.sort()).toEqual(['dm', 'group'])
  expect(t.model.calls).toEqual([])
  expect(fake.sent).toEqual([])
})

test('Feishu unsupported replies wait for earlier context preparation and cannot erase its history', async () => {
  const f = await feishuGateway()
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const preparing = new Promise<void>((resolve) => {
    started = resolve
  })
  f.transport.listMessages = async () => {
    started()
    await gate
    return [historyMessage('earlier', 'ou_bob', 'keep this detail', '1000')]
  }
  f.deliver(feishuEvent({ message_id: 'text', create_time: '2000' }))
  await preparing
  f.deliver(
    feishuEvent({
      message_id: 'audio',
      message_type: 'audio',
      create_time: '3000',
    }),
  )
  try {
    expect(f.sent).toEqual([])
  } finally {
    release()
  }
  await waitFor(() => f.sent.length === 2)
  expect(f.t.model.calls[0]?.lastUserText).toContain('Bob: keep this detail')
  expect(f.sent.map((reply) => reply.messageId)).toEqual(['text', 'audio'])
})

function failingStorage() {
  const storage = memorySessionStorage()
  const failing = new Set(['fake-c1'])
  return {
    failing,
    storage: {
      ...storage,
      async append(...args: Parameters<typeof storage.append>) {
        if (failing.has(args[0])) throw new Error('disk full')
        await storage.append(...args)
      },
    },
  }
}

test('the gateway logs the first session save failure at error level with its session id', async () => {
  const { storage } = failingStorage()
  const errors: string[] = []
  const t = createTestVela({
    responses: [fauxText('answer')],
    sessionStorage: storage,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error: (message) => errors.push(message),
    },
  })
  await fakeChannel(t).deliver('u1', 'hello')
  expect(t.eventsOf('session_save_failed')).toHaveLength(1)
  expect(errors).toHaveLength(1)
  expect(errors[0]).toContain('fake-c1')
  expect(errors[0]).toContain('disk full')
})

test('after three save failures the gateway refuses queued prompts without calling the model again', async () => {
  const { storage } = failingStorage()
  const t = createTestVela({
    responses: [
      fauxText('one'),
      fauxText('two'),
      fauxText('three'),
      fauxText('other chat'),
    ],
    sessionStorage: storage,
  })
  const { sent, deliver } = fakeChannel(t)
  await Promise.all(
    ['first', 'second', 'third', 'refused', 'refused again'].map((text) =>
      deliver('u1', text),
    ),
  )
  expect(t.eventsOf('session_save_failed')).toHaveLength(3)
  expect(t.model.calls).toHaveLength(3)
  expect(sent.slice(0, 3).map((reply) => reply.text)).toEqual([
    'one',
    'two',
    'three',
  ])
  expect(sent).toHaveLength(5)
  for (const reply of sent.slice(3)) {
    expect(reply).toMatchObject({ channelId: 'c1', recipientId: 'u1' })
    expect(reply.text).toContain("can't be saved")
  }
  expect(JSON.stringify(t.vela.session('fake-c1').getEntries())).not.toContain(
    'refused',
  )
  expect(t.eventsOf('channel_reply')).toHaveLength(5)
  await deliver('u2', 'unaffected', 'c2')
  expect(sent.at(-1)?.text).toBe('other chat')
})

test('a successful save resets consecutive failures, including SDK saves after refusal', async () => {
  const { storage, failing } = failingStorage()
  const t = createTestVela({
    responses: Array.from({ length: 7 }, (_, i) => fauxText(`answer ${i + 1}`)),
    sessionStorage: storage,
    allowPendingResponses: true,
  })
  const { sent, deliver } = fakeChannel(t)
  await deliver('u1', 'failure 1')
  await deliver('u1', 'failure 2')
  failing.clear()
  await deliver('u1', 'successful turn')
  failing.add('fake-c1')
  await deliver('u1', 'new failure 1')
  await deliver('u1', 'new failure 2')
  await deliver('u1', 'new failure 3')
  await deliver('u1', 'refused')
  expect(t.model.calls).toHaveLength(6)
  expect(sent.at(-1)?.text).toContain("can't be saved")
  failing.clear()
  await t.vela.session('fake-c1').save()
  await deliver('u1', 'recovered')
  expect(t.model.calls).toHaveLength(7)
  expect(sent.at(-1)?.text).toBe('answer 7')
  expect(JSON.stringify(await storage.load('fake-c1'))).toContain('failure 1')
})

test('handling an input without saving does not clear failures from channel or SDK prompts', async () => {
  const { storage } = failingStorage()
  const errors: string[] = []
  const t = createTestVela({
    responses: [fauxText('one'), fauxText('two'), fauxText('three')],
    sessionStorage: storage,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error: (message) => errors.push(message),
    },
    extensions: [
      (vela) => {
        vela.on('input', (event) =>
          event.text === 'skip' ? { action: 'handled' } : undefined,
        )
      },
    ],
  })
  const { sent, deliver } = fakeChannel(t)
  await deliver('u1', 'first')
  await t.vela.session('fake-c1').prompt('SDK turn')
  await deliver('u1', 'skip')
  await deliver('u1', 'third')
  await deliver('u1', 'refused')
  expect(t.model.calls).toHaveLength(3)
  expect(errors).toHaveLength(3)
  expect(sent.at(-1)?.text).toContain("can't be saved")
})

test('an idle save failure retains the same session and its pending history', async () => {
  const { storage } = failingStorage()
  const t = createTestVela({
    responses: [fauxText('one'), fauxText('two')],
    sessionStorage: storage,
    channelIdleMs: 0,
  })
  const { sent, deliver } = fakeChannel(t)
  await deliver('u1', 'first')
  const session = t.vela.session('fake-c1')
  await waitFor(() => t.eventsOf('session_save_failed').length >= 2)
  expect(t.vela.sessions()).toContain(session)
  await deliver('u1', 'third failure')
  await deliver('u1', 'refused')
  expect(t.vela.session('fake-c1')).toBe(session)
  expect(t.model.calls).toHaveLength(2)
  expect(sent.at(-1)?.text).toContain("can't be saved")
  expect(JSON.stringify(session.getEntries())).toContain('first')
  expect(JSON.stringify(session.getEntries())).not.toContain('refused')
})

test('a retained blocked session still replies when storage reads also fail', async () => {
  const { storage } = failingStorage()
  let failReads = false
  let failedReads = 0
  const t = createTestVela({
    responses: [fauxText('one'), fauxText('two'), fauxText('three')],
    channelIdleMs: 0,
    sessionStorage: {
      ...storage,
      async load(id) {
        if (failReads) {
          failedReads++
          throw new Error('storage unavailable')
        }
        return storage.load(id)
      },
    },
  })
  const { sent, deliver } = fakeChannel(t)
  await Promise.all(
    ['first', 'second', 'third'].map((text) => deliver('u1', text)),
  )
  await waitFor(() => t.eventsOf('session_save_failed').length >= 4)
  const session = t.vela.session('fake-c1')
  failReads = true
  await deliver('u1', 'refused during full outage')
  await deliver('u1', 'still refused during full outage')
  expect(sent).toHaveLength(5)
  for (const reply of sent.slice(3))
    expect(reply.text).toContain("can't be saved")
  expect(failedReads).toBe(0)
  expect(t.model.calls).toHaveLength(3)
  expect(t.vela.session('fake-c1')).toBe(session)
  expect(t.eventsOf('channel_message')).toHaveLength(5)
  expect(t.eventsOf('channel_reply')).toHaveLength(5)
})

test('a blocked retained session saves its real batch before accepting a new prompt', async () => {
  const { storage, failing } = failingStorage()
  let emptyAppends = 0
  const t = createTestVela({
    responses: ['one', 'two', 'three', 'recovered', 'continued'].map((text) =>
      fauxText(text),
    ),
    allowPendingResponses: true,
    channelIdleMs: 0,
    sessionStorage: {
      ...storage,
      async append(id, entries) {
        // An empty append can be a no-op even while real writes still fail.
        if (!entries.length) {
          emptyAppends++
          return
        }
        return storage.append(id, entries)
      },
    },
  })
  const { sent, deliver } = fakeChannel(t)
  await Promise.all(
    ['first', 'second', 'third'].map((text) => deliver('u1', text)),
  )
  const session = t.vela.session('fake-c1')
  await waitFor(() => t.eventsOf('session_save_failed').length >= 4)
  expect(t.vela.sessions()).toContain(session)
  await deliver('u1', 'refused while broken')
  expect(sent.at(-1)?.text).toContain("can't be saved")
  expect(t.model.calls).toHaveLength(3)
  failing.clear()
  await deliver('u1', 'after repair')
  expect(sent.at(-1)?.text).toBe('recovered')
  expect(t.model.calls).toHaveLength(4)
  expect(JSON.stringify(t.model.calls[3]?.prompt)).toContain('first')
  const saved = JSON.stringify(await storage.load('fake-c1'))
  expect(saved).toContain('after repair')
  expect(saved).not.toContain('refused while broken')
  expect(emptyAppends).toBe(0)
  await waitFor(() => !t.vela.sessions().some((s) => s.id === 'fake-c1'))
  await deliver('u1', 'after successful idle close')
  expect(sent.at(-1)?.text).toBe('continued')
  expect(JSON.stringify(t.model.calls[4]?.prompt)).toContain('after repair')
})

test('repairing writes recovers the retained context without needing a storage reload', async () => {
  const { storage, failing } = failingStorage()
  let failReads = false
  let failedReads = 0
  const t = createTestVela({
    responses: ['one', 'two', 'three', 'recovered'].map((text) =>
      fauxText(text),
    ),
    allowPendingResponses: true,
    channelIdleMs: 0,
    sessionStorage: {
      ...storage,
      async load(id) {
        if (failReads) {
          failedReads++
          throw new Error('reads unavailable')
        }
        return storage.load(id)
      },
    },
  })
  const { sent, deliver } = fakeChannel(t)
  await Promise.all(
    ['first', 'second', 'third'].map((text) => deliver('u1', text)),
  )
  await waitFor(() => t.eventsOf('session_save_failed').length >= 4)
  failing.clear()
  failReads = true
  await deliver('u1', 'after writes repair')
  expect(sent.at(-1)?.text).toBe('recovered')
  expect(t.model.calls).toHaveLength(4)
  expect(JSON.stringify(t.model.calls[3]?.prompt)).toContain('first')
  expect(failedReads).toBe(0)
})

for (const persistedBaseline of [false, true]) {
  test(`SDK recovery uses the retained idle session with persisted baseline=${persistedBaseline}`, async () => {
    const { storage, failing } = failingStorage()
    const t = createTestVela({
      responses: [
        ...(persistedBaseline ? ['saved'] : []),
        'one',
        'two',
        'three',
        'continued',
      ].map((text) => fauxText(text)),
      allowPendingResponses: true,
      channelIdleMs: 0,
      sessionStorage: storage,
    })
    const { sent, deliver } = fakeChannel(t)
    const id = 'fake-c1'
    const closed = () => !t.vela.sessions().some((session) => session.id === id)
    if (persistedBaseline) {
      failing.clear()
      await deliver('u1', 'saved before outage')
      await waitFor(closed)
      failing.add(id)
    }
    await Promise.all(
      ['unsaved 1', 'unsaved 2', 'unsaved 3'].map((text) =>
        deliver('u1', text),
      ),
    )
    const original = t.vela.session(id)
    await waitFor(() => t.eventsOf('session_save_failed').length >= 4)
    expect(t.vela.sessions()).toContain(original)
    expect(t.vela.session(id)).toBe(original)
    failing.clear()
    const sdk = t.vela.session(id)
    await sdk.resume()
    sdk.appendEntry('sdk-repair', { healthy: true })
    await sdk.save()
    // Saving through the SDK clears failures without scheduling a close during SDK work.
    // biome-ignore lint/complexity/useLiteralKeys: bracket access reads a private ChannelGateway field; dot access does not typecheck
    expect(t.internals.gateway['idleTimers'].has(id)).toBe(false)
    expect(t.vela.session(id)).toBe(original)
    await deliver('u1', 'after SDK recovery')
    expect(sent.at(-1)?.text).toBe('continued')
    const saved = await storage.load(id)
    expect(saved?.filter((entry) => entry.type === 'session')).toHaveLength(1)
    for (const text of ['unsaved 1', 'unsaved 2', 'unsaved 3', 'sdk-repair'])
      expect(JSON.stringify(saved)).toContain(text)
    const prompt = JSON.stringify(t.model.calls.at(-1)?.prompt)
    for (const text of ['unsaved 1', 'unsaved 2', 'unsaved 3'])
      expect(prompt).toContain(text)
    if (persistedBaseline) expect(prompt).toContain('saved before outage')
    await waitFor(closed)
  })
}

test('disposal closes an unsaved retained channel session without retrying indefinitely', async () => {
  const { storage } = failingStorage()
  const t = createTestVela({
    responses: [fauxText('answer')],
    sessionStorage: storage,
    channelIdleMs: 0,
  })
  const { deliver } = fakeChannel(t)
  await deliver('u1', 'unsaved')
  const session = t.vela.session('fake-c1')
  await waitFor(() => t.eventsOf('session_save_failed').length >= 2)
  expect(t.vela.sessions()).toContain(session)
  await t.vela.dispose()
  expect(t.vela.sessions()).toEqual([])
  expect(t.eventsOf('session_save_failed')).toHaveLength(3)
  await deliver('u1', 'after disposal')
  expect(t.model.calls).toHaveLength(1)
})

test('a message queued during idle saving keeps the current session open', async () => {
  const storage = memorySessionStorage()
  let blockWrites = false
  let releaseWrite!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  const t = createTestVela({
    responses: [fauxText('first'), fauxText('second')],
    allowPendingResponses: true,
    channelIdleMs: 0,
    sessionStorage: {
      ...storage,
      async append(id, entries) {
        if (blockWrites) await gate
        await storage.append(id, entries)
      },
    },
  })
  const { deliver } = fakeChannel(t)
  await deliver('u1', 'first input')
  const session = t.vela.session('fake-c1')
  blockWrites = true
  session.appendEntry('idle-write', {})
  // Synchronize on the idle save operation rather than assuming a timer duration.
  // biome-ignore lint/complexity/useLiteralKeys: bracket access reads a private ChannelGateway field; dot access does not typecheck
  await waitFor(() => t.internals.gateway['closing'].has(session.id))
  const queued = deliver('u1', 'queued while saving')
  blockWrites = false
  releaseWrite()
  await queued
  expect(t.vela.session(session.id)).toBe(session)
  expect(t.model.calls).toHaveLength(2)
  expect(JSON.stringify(t.model.calls[1]?.prompt)).toContain('first input')
})
