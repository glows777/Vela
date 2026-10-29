import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type FauxRequest,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { fakeLark, larkEvent } from '../support/lark.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

type Respond = (req: FauxRequest) => ReturnType<typeof fauxText>

function setup(respond: Respond, cwd?: string) {
  const fake = fakeLark()
  const t = createTestVela({
    cwd,
    responses: Array(20).fill(respond),
    allowPendingResponses: true,
    extensions: [
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  return {
    fake,
    t,
    start: async () => {
      await t.vela.ready()
      await t.vela.startChannels()
    },
    topic: (root: string, text: string) =>
      fake.deliver(
        larkEvent({
          message_id: `trigger_${root}`,
          root_id: root,
          thread_id: `thread_${root}`,
          content: JSON.stringify({ text }),
        }),
      ),
    notes: (): string[] => {
      const path = join(t.vela.dataDir, 'channels', 'index.json')
      if (!existsSync(path)) return []
      return (
        JSON.parse(readFileSync(path, 'utf8')).notes?.['lark-oc_group'] ?? []
      )
    },
  }
}

const isNote = (req: FauxRequest) =>
  req.lastUserText.startsWith("Message from Vela's")
/** The topic a request belongs to, from its topic context section. */
const topicOf = (req: FauxRequest) =>
  req.system.match(/This topic is .*\(root_id (\w+)\)/)?.[1]

test('topic A hands a result straight to topic B; nothing is posted for the hop', async () => {
  const { fake, t, start, topic, notes } = setup((req) => {
    if (isNote(req)) return fauxText('Release confirmed with ORBIT-73')
    if (topicOf(req) === 'root_b') return fauxText('Waiting for topic A')
    return req.toolResults.length
      ? fauxText('Handed the code to topic B')
      : fauxToolCall('channel_message_topic', {
          root_id: 'root_b',
          text: 'The verification code is ORBIT-73',
        })
  })
  await start()
  topic('root_b', 'confirm the release with the code from topic A')
  await until(() => fake.sent.length === 1)
  topic('root_a', 'find the code and hand it to topic B')
  await until(() => fake.sent.length === 3)
  expect(fake.sent.map((item) => item.text)).toEqual([
    '<at user_id="ou_alice"></at> Waiting for topic A',
    '<at user_id="ou_alice"></at> Handed the code to topic B',
    '<at user_id="ou_alice"></at> Release confirmed with ORBIT-73',
  ])
  expect(fake.sent[2]?.messageId).toBe('root_b')
  expect(fake.forwards).toEqual([])
  expect(fake.topics).toEqual([])
  const note = t.model.calls.find(isNote)!
  expect(note.lastUserText).toBe(
    'Message from Vela\'s topic "find the code and hand it to topic B" (root_id root_a) (not from a person):\nThe verification code is ORBIT-73',
  )
  // B's first run, A's two requests and B's note run: no group-session request at all.
  expect(t.model.calls).toHaveLength(4)
  // A new topic starts with its context ahead of its first input.
  const [context, input] = t.model.calls[1]!.prompt.filter(
    (message) => message.role === 'user',
  )
  expect(JSON.stringify(context)).toContain(
    '(root_id root_a), requested by Alice.',
  )
  expect(JSON.stringify(input)).toContain('find the code and hand it')
  await until(() => notes().length === 4)
  expect(notes()).toEqual([
    'topic "confirm the release with the code from topic A" (root_id root_b) finished: Waiting for topic A',
    'topic "find the code and hand it to topic B" (root_id root_a) → topic "confirm the release with the code from topic A" (root_id root_b): The verification code is ORBIT-73',
    'topic "find the code and hand it to topic B" (root_id root_a) finished: Handed the code to topic B',
    'topic "confirm the release with the code from topic A" (root_id root_b) finished: Release confirmed with ORBIT-73',
  ])
})

test('a topic note reaches the group session, which passes it on silently', async () => {
  const { fake, t, start, topic } = setup((req) => {
    if (req.tools.includes('lark_start_topic')) {
      // The group session handling A's note.
      if (!req.toolResults.length)
        return fauxToolCall('channel_message_topic', {
          root_id: 'root_b',
          text: 'Topic A found ORBIT-73',
        })
      if (req.toolResults[0]?.toolName === 'channel_message_topic')
        return fauxToolCall('lark_skip_reply', {})
      return fauxText('')
    }
    if (isNote(req)) return fauxText('Release confirmed with ORBIT-73')
    if (topicOf(req) === 'root_b') return fauxText('Waiting')
    return req.toolResults.length
      ? fauxText('Told the group session')
      : fauxToolCall('channel_message_group', {
          text: 'Topic B needs the code ORBIT-73',
        })
  })
  await start()
  topic('root_b', 'confirm the release')
  await until(() => fake.sent.length === 1)
  topic('root_a', 'find the code')
  await until(() => fake.sent.length === 3)
  expect(fake.sent.map((item) => item.text)).toEqual([
    '<at user_id="ou_alice"></at> Waiting',
    '<at user_id="ou_alice"></at> Told the group session',
    '<at user_id="ou_alice"></at> Release confirmed with ORBIT-73',
  ])
  const group = t.model.calls.find((call) =>
    call.tools.includes('lark_start_topic'),
  )!
  expect(group.lastUserText).toBe(
    'Message from Vela\'s topic "find the code" (root_id root_a) (not from a person), about a request from Alice:\nTopic B needs the code ORBIT-73',
  )
  expect(group.system).toContain('This input is a note from a topic')
  const hopText =
    "Message from Vela's group session (not from a person):\nTopic A found ORBIT-73"
  expect(
    t.model.calls.find((call) => call.lastUserText === hopText)?.lastUserText,
  ).toBe(hopText)
  // Nothing was posted for the group run, the note or the hop.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(fake.sent).toHaveLength(3)
  expect(fake.forwards).toEqual([])
})

test('a finished topic adds one status line to the group session without a model call', async () => {
  const respond: Respond = (req) =>
    fauxText(req.tools.includes('lark_start_topic') ? 'group answer' : 'done')
  const first = setup(respond)
  await first.start()
  first.topic('root', 'compile the report')
  await until(() => first.fake.sent.length === 1)
  await until(() => first.notes().length === 1)
  expect(first.t.model.calls).toHaveLength(1)
  await first.t.cleanup({ keepDir: true })

  // The line is on disk, so it survives a restart.
  const second = setup(respond, first.t.cwd)
  await second.start()
  second.fake.deliver(larkEvent({ content: '{"text":"@_user_1 status?"}' }))
  await until(() => second.fake.sent.length === 1)
  const status =
    'Status from Vela since your last run (not from a person):\ntopic "compile the report" (root_id root) finished: done'
  const texts = (index: number) =>
    second.t.model.calls[index]!.prompt.flatMap((message) =>
      message.role === 'user' && Array.isArray(message.content)
        ? message.content.flatMap((part) =>
            part.type === 'text' ? [part.text] : [],
          )
        : [],
    )
  // The status line comes before the new question.
  expect(texts(0)).toEqual([status, expect.stringContaining('status?')])
  await until(() => second.notes().length === 0)
  second.fake.deliver(larkEvent({ content: '{"text":"@_user_1 again"}' }))
  await until(() => second.fake.sent.length === 2)
  expect(texts(1).filter((text) => text === status)).toHaveLength(1)
})

test('a hand-off chain stops after three hops', async () => {
  const { fake, t, start, topic } = setup((req) => {
    const self = topicOf(req)
    if (req.toolResults.length) return fauxText('ok')
    if (self === 'root_b' && !isNote(req)) return fauxText('ready')
    return fauxToolCall('channel_message_topic', {
      root_id: self === 'root_a' ? 'root_b' : 'root_a',
      text: `ping from ${self}`,
    })
  })
  await start()
  topic('root_b', 'wait for pings')
  await until(() => fake.sent.length === 1)
  topic('root_a', 'start pinging')
  // A→B, B→A, A→B succeed; B's fourth hop is refused.
  await until(() =>
    t.model.calls.some((call) =>
      call.toolResults.some((result) =>
        result.output.includes('Hand-off chain limit reached'),
      ),
    ),
  )
  await until(() => fake.sent.length === 5)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const hops = t.model.calls.filter((call) =>
    call.toolResults.some(
      (result) => result.toolName === 'channel_message_topic',
    ),
  )
  expect(hops).toHaveLength(4)
  expect(fake.sent).toHaveLength(5)
})

test('a topic reads another topic’s visible messages and lists the group’s topics', async () => {
  const { fake, t, start, topic } = setup((req) => {
    if (topicOf(req) === 'root_b') return fauxText('B posted its plan')
    if (!req.toolResults.length)
      return fauxToolCall('lark_read_topic', { root_id: 'root_b' })
    if (req.toolResults[0]?.toolName === 'lark_read_topic')
      return fauxToolCall('lark_read_topic', { root_id: 'missing' })
    return fauxText('read it')
  })
  await start()
  topic('root_b', 'plan the launch')
  await until(() => fake.sent.length === 1)
  fake.topicHistory.push([
    {
      message_id: 'b1',
      create_time: '1000',
      msg_type: 'text',
      body: { content: JSON.stringify({ text: 'Launch on Friday' }) },
      sender: { id: 'bot', sender_type: 'app' },
    },
  ])
  topic('root_a', 'check what topic B decided')
  await until(() => fake.sent.length === 2)
  const [read, missing] = t.model.calls
    .flatMap((call) => call.toolResults)
    .filter((result) => result.toolName === 'lark_read_topic')
  expect(read?.output).toContain('Vela: Launch on Friday')
  expect(read?.output).toContain('plan the launch')
  expect(missing?.output).toContain('not an observed owned topic')
  expect(fake.topicHistoryCalls.at(-1)).toEqual({
    threadId: 'thread_root_b',
    pageToken: undefined,
  })
})

test('a note keeps a person’s pending decision and the receiving topic can stay silent', async () => {
  const { fake, t, start, topic } = setup((req) => {
    if (isNote(req))
      return req.toolResults.length
        ? fauxText('')
        : fauxToolCall('lark_skip_reply', {})
    if (topicOf(req) === 'root_b')
      return req.toolResults.length
        ? fauxText('Which region?')
        : fauxToolCall('lark_wait_for_input', { reason: 'Which region?' })
    return req.toolResults.length
      ? fauxText('sent')
      : fauxToolCall('channel_message_topic', {
          root_id: 'root_b',
          text: 'FYI the build is green',
        })
  })
  await start()
  topic('root_b', 'deploy the release')
  await until(() => fake.sent.length === 1)
  topic('root_a', 'tell B the build is green')
  await until(
    () => t.model.calls.filter(isNote).length === 2 && fake.sent.length === 2,
  )
  // Wait for B's note run to finish, not a fixed delay.
  const recordB = () =>
    JSON.parse(
      readFileSync(join(t.vela.dataDir, 'channels', 'index.json'), 'utf8'),
    ).records.find((record: { rootId?: string }) => record.rootId === 'root_b')
  await until(() => recordB()?.state !== 'running')
  // B's silent note run posts nothing; only B's question and A's reply are visible.
  expect(fake.sent.map((item) => item.text)).toEqual([
    '<at user_id="ou_alice"></at> Which region?',
    '<at user_id="ou_alice"></at> sent',
  ])
  const b = recordB()
  expect(b).toMatchObject({
    state: 'waiting',
    waitingReason: 'Which region?',
    pendingMessageIds: [],
  })
})
