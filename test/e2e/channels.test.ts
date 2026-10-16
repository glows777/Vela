import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { channelSessionId } from '../../src/channels/gateway.ts'
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from '../../src/channels/types.ts'
import type { ProviderContext } from '../../src/models/index.ts'
import { memorySessionStorage } from '../../src/session/storage.ts'
import { createFauxModel, fauxHang, fauxText } from '../../src/testing/faux.ts'
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

/** Real session persistence and retry handling, with a switchable storage outage. */
function failingStorage() {
  const storage = memorySessionStorage()
  const failing = new Set(['fake-c1-u1'])
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
  expect(errors[0]).toContain('fake-c1-u1')
  expect(errors[0]).toContain('disk full')
})

test('after three save failures the gateway refuses queued prompts without calling the model again', async () => {
  const { storage } = failingStorage()
  const t = createTestVela({
    responses: [
      fauxText('one'),
      fauxText('two'),
      fauxText('three'),
      fauxText('other sender'),
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
  expect(
    JSON.stringify(t.vela.session('fake-c1-u1').getEntries()),
  ).not.toContain('refused')
  expect(t.eventsOf('channel_reply')).toHaveLength(5)
  await deliver('u2', 'unaffected')
  expect(sent.at(-1)?.text).toBe('other sender')
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
  failing.add('fake-c1-u1')
  await deliver('u1', 'new failure 1')
  await deliver('u1', 'new failure 2')
  await deliver('u1', 'new failure 3')
  await deliver('u1', 'refused')
  expect(t.model.calls).toHaveLength(6)
  expect(sent.at(-1)?.text).toContain("can't be saved")
  failing.clear()
  await t.vela.session('fake-c1-u1').save()
  await deliver('u1', 'recovered')
  expect(t.model.calls).toHaveLength(7)
  expect(sent.at(-1)?.text).toBe('answer 7')
  expect(JSON.stringify(await storage.load('fake-c1-u1'))).toContain(
    'failure 1',
  )
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
  await t.vela.session('fake-c1-u1').prompt('SDK turn')
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
  const session = t.vela.session('fake-c1-u1')
  await waitFor(() => t.eventsOf('session_save_failed').length >= 2)
  expect(t.vela.sessions()).toContain(session)
  await deliver('u1', 'third failure')
  await deliver('u1', 'refused')
  expect(t.vela.session('fake-c1-u1')).toBe(session)
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
  const session = t.vela.session('fake-c1-u1')
  failReads = true
  await deliver('u1', 'refused during full outage')
  await deliver('u1', 'still refused during full outage')
  expect(sent).toHaveLength(5)
  for (const reply of sent.slice(3))
    expect(reply.text).toContain("can't be saved")
  expect(failedReads).toBe(0)
  expect(t.model.calls).toHaveLength(3)
  expect(t.vela.session('fake-c1-u1')).toBe(session)
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
  const session = t.vela.session('fake-c1-u1')
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
  const saved = JSON.stringify(await storage.load('fake-c1-u1'))
  expect(saved).toContain('after repair')
  expect(saved).not.toContain('refused while broken')
  expect(emptyAppends).toBe(0)
  await waitFor(() => !t.vela.sessions().some((s) => s.id === 'fake-c1-u1'))
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
    const id = 'fake-c1-u1'
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
  const session = t.vela.session('fake-c1-u1')
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
  const session = t.vela.session('fake-c1-u1')
  blockWrites = true
  session.appendEntry('idle-write', {})
  // Synchronize on the idle save operation rather than assuming a timer duration.
  await waitFor(() => t.internals.gateway['closing'].has(session.id))
  const queued = deliver('u1', 'queued while saving')
  blockWrites = false
  releaseWrite()
  await queued
  expect(t.vela.session(session.id)).toBe(session)
  expect(t.model.calls).toHaveLength(2)
  expect(JSON.stringify(t.model.calls[1]?.prompt)).toContain('first input')
})
