import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { channelSessionId } from '../../src/channels/gateway.ts'
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from '../../src/channels/types.ts'
import { fauxHang, fauxText } from '../../src/testing/faux.ts'
import {
  cleanupTestVelas,
  createTestVela,
  type TestVela,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

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
          JSON.stringify(req.prompt).includes('I like blue') ? 'blue' : "I don't know",
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
    responses: [fauxText('reply to the first'), fauxText('reply to the second')],
  })
  const { sent, deliver } = fakeChannel(t)

  await Promise.all([deliver('u1', 'first'), deliver('u1', 'second')])

  expect(sent.map((m) => m.text)).toEqual(['reply to the first', 'reply to the second'])
  // The second request sees the full history of the first round
  expect(JSON.stringify(t.model.calls[1]!.prompt)).toContain('reply to the first')
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
  expect(channelSessionId('feishu', 'oc_9', 'ou_123')).toBe('feishu-oc_9-ou_123')

  const t = createTestVela({ responses: [fauxText('OK'), fauxText("I don't know")] })
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
          JSON.stringify(req.prompt).includes('I like blue') ? 'blue' : "I don't know",
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

test('sessions are keyed by conversation and sender: chats and group members stay apart', async () => {
  const t = createTestVela({
    responses: [
      fauxText('OK'),
      (req) =>
        fauxText(JSON.stringify(req.prompt).includes('hunter2') ? 'leaked' : 'clean'),
      (req) =>
        fauxText(JSON.stringify(req.prompt).includes('hunter2') ? 'leaked' : 'clean'),
      (req) =>
        fauxText(JSON.stringify(req.prompt).includes('hunter2') ? 'same chat' : 'lost'),
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
