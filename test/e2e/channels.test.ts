import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import type { ProviderContext } from '../../packages/vela/src/driver/index.ts'
import { silentLogger } from '../../packages/vela/src/driver/index.ts'
import { messageTime } from '../../packages/vela/src/lark/history.ts'
import { lark } from '../../packages/vela/src/lark/index.ts'
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from '../../packages/vela/src/legacy-channels/index.ts'
import { channelSessionId } from '../../packages/vela/src/legacy-channels/index.ts'
import {
  createFauxModel,
  fauxHang,
  fauxText,
} from '../../packages/vela/src/testing/core/index.ts'
import { fakeLark, historyMessage, larkEvent } from '../support/lark.ts'
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

/** `[HH:MM] ` for a Lark create_time in the machine's local time */
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
  const c1Entries = JSON.stringify(t.vela.session('fake-c1').getEntries())
  expect(c1Entries).toContain('I am u1')
  expect(c1Entries).toContain('I am u2')
  expect(t.eventsIn('fake-c1').map((e) => e.type)).toContain('channel_reply')
  // The CLI's default session is unaffected
  expect(t.session.messages).toEqual([])
  expect((await t.vela.listSessions()).map((s) => s.id)).not.toContain(
    'default',
  )
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
  expect(channelSessionId('lark', 'oc_9')).toBe('lark-oc_9')
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
  expect(JSON.stringify(t.vela.session('fake-c1').getEntries())).toContain(
    'I like blue',
  )
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
    generate: [
      fauxText(JSON.stringify({ ops: [], report: 'No durable facts' })),
    ],
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
  const listed = (await t.vela.listSessions()).map((s) => s.id)
  expect(listed).toContain('fake-dm_u1')
  expect(listed).toContain('fake-group')
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

async function larkGateway(
  options: {
    chats?: NonNullable<Parameters<typeof lark>[0]>['chats']
    owners?: string[]
    responses?: NonNullable<Parameters<typeof createTestVela>[0]>['responses']
  } = {},
) {
  const fake = fakeLark()
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
      lark({
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

test('Lark ignores unlisted chats and stranger DMs without a model call, reply or per-message log', async () => {
  const f = await larkGateway()
  f.deliver(larkEvent({ chat_id: 'oc_unlisted' }))
  f.deliver(larkEvent({ chat_id: 'oc_stranger', chat_type: 'p2p' }, 'ou_bob'))
  // A later permitted turn is a barrier, so ignored events cannot hide behind async delivery.
  f.deliver(
    larkEvent({ chat_id: 'oc_owner', chat_type: 'p2p', message_id: 'owner' }),
  )
  await waitFor(() => f.sent.length >= 1)
  expect(f.logs.join('\n')).not.toContain('oc_unlisted')
  expect(f.logs.join('\n')).not.toContain('oc_stranger')
  expect(f.t.model.calls).toHaveLength(1)
  expect(f.sent).toEqual([{ chatId: 'oc_owner', text: 'answer' }])
  expect(f.historyCalls).toEqual([])
})

test('Lark enabled group members share a persisted session and both display names reach the model', async () => {
  const f = await larkGateway()
  f.deliver(larkEvent({ message_id: 'alice', content: '{"text":"first"}' }))
  await waitFor(() => f.sent.length === 1)
  f.deliver(
    larkEvent({ message_id: 'bob', content: '{"text":"second"}' }, 'ou_bob'),
  )
  await waitFor(() => f.sent.length === 2)
  expect(
    f.t.vela
      .sessions()
      .filter((s) => s.channel === 'lark')
      .map((s) => s.id),
  ).toEqual(['lark-oc_group'])
  expect(JSON.stringify(f.t.model.calls[1]?.prompt)).toContain('Alice: first')
  expect(JSON.stringify(f.t.model.calls[1]?.prompt)).toContain('Bob: second')
  expect(f.t.model.calls[1]?.tools).toContain('read')
  // A hub runs quick work itself; a longer task is still dispatched to a topic (#421).
  expect(f.t.model.calls[1]?.tools).toContain('bash')
  expect(
    JSON.stringify(f.t.vela.session('lark-oc_group').getEntries()),
  ).toContain('Alice: first')
})

test('Lark readUntagged off keeps mention-only top-level behavior', async () => {
  const f = await larkGateway({
    chats: [{ id: 'oc_group', readUntagged: false }],
  })
  f.deliver(larkEvent({ mentions: [], message_id: 'no_at' }))
  f.deliver(
    larkEvent({
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bob' } }],
      message_id: 'other_at',
    }),
  )
  f.deliver(larkEvent({ message_id: 'bot_at' }))
  await waitFor(() => f.sent.length >= 1)
  expect(f.t.model.calls).toHaveLength(1)
  expect(f.sent).toEqual([{ messageId: 'bot_at', text: 'answer' }])
})

test('Lark mention fetches earlier group messages since this bot last replied and injects them before the question', async () => {
  const f = await larkGateway()
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
    larkEvent({
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

test('Lark group answers reply to each triggering message in queue order, including a second sender during a run', async () => {
  const f = await larkGateway({
    responses: [
      () => {
        f.deliver(larkEvent({ message_id: 'second' }, 'ou_bob'))
        return fauxText('one')
      },
      fauxText('two'),
    ],
  })
  f.deliver(larkEvent({ message_id: 'first' }))
  await waitFor(() => f.sent.length === 2)
  expect(f.sent).toEqual([
    { messageId: 'first', text: 'one' },
    { messageId: 'second', text: 'two' },
  ])
  expect(JSON.stringify(f.t.model.calls[1]?.prompt)).toContain('one')
  expect(f.t.eventsOf('channel_error')).toEqual([])
})

test('Lark owner DM works with empty chats, prefixes the name, and announces the empty chat configuration', async () => {
  const f = await larkGateway({ chats: [] })
  f.deliver(larkEvent({ chat_id: 'oc_dm', chat_type: 'p2p', mentions: [] }))
  await waitFor(() => f.sent.length === 1)
  expect(f.sent).toEqual([{ chatId: 'oc_dm', text: 'answer' }])
  expect(f.t.model.calls[0]?.lastUserText).toBe('Alice: @_user_1 hello')
  expect(f.logs).toContain(
    '[lark] chats is empty; only owners’ direct chats are enabled',
  )
  expect(f.historyCalls).toEqual([])
})

test('Lark cached sender names fall back to open_id and missing history does not lose the question', async () => {
  const f = await larkGateway()
  f.failHistory()
  const first = larkEvent({ message_id: 'one' }, 'ou_unknown')
  f.deliver(first)
  await waitFor(() => f.sent.length === 1)
  f.deliver(larkEvent({ message_id: 'two' }, 'ou_unknown'))
  await waitFor(() => f.sent.length === 2)
  expect(f.nameCalls).toEqual(['ou_unknown'])
  // Without history the question keeps its own send time
  expect(f.t.model.calls[0]?.lastUserText).toBe(
    `${at(first.message.create_time!)}ou_unknown: hello`,
  )
  expect(
    f.logs.some((line) => line.includes('history permission denied')),
  ).toBe(true)
})

test('Lark keeps slash command dispatch for both owner DMs and group mentions', async () => {
  const fake = fakeLark()
  const commands: string[] = []
  const t = createTestVela({
    responses: [],
    extensions: [
      lark({
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
    larkEvent({
      chat_id: 'oc_dm',
      chat_type: 'p2p',
      content: '{"text":"/ping dm"}',
    }),
  )
  fake.deliver(larkEvent({ content: '{"text":"@_user_1 /ping group"}' }))
  await waitFor(() => commands.length === 2)
  expect(commands.sort()).toEqual(['dm', 'group'])
  expect(t.model.calls).toEqual([])
  expect(fake.sent).toEqual([])
})

test('Lark unsupported replies wait for earlier context preparation and cannot erase its history', async () => {
  const f = await larkGateway()
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
  f.deliver(larkEvent({ message_id: 'text', create_time: '2000' }))
  await preparing
  f.deliver(
    larkEvent({
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

test('a message queued during idle saving keeps the current session open', async () => {
  let blockWrites = false
  let releaseWrite!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  const t = createTestVela({
    ephemeralSessions: true,
    responses: [fauxText('first'), fauxText('second')],
    allowPendingResponses: true,
    channelIdleMs: 0,
  })
  const { deliver } = fakeChannel(t)
  await deliver('u1', 'first input')
  const session = t.vela.session('fake-c1')
  const origSave = session.save.bind(session)
  session.save = async () => {
    if (blockWrites) await gate
    return origSave()
  }
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
