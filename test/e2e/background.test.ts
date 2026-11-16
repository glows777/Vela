import { afterEach, expect, test } from 'bun:test'
import { fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { background } from '../../packages/core/src/extensions/background/index.ts'
import { fakeLark, larkEvent } from '../support/lark.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

async function until(check: () => boolean, what = 'condition') {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

const topicEvent = (message_id: string, text: string) =>
  larkEvent({
    message_id,
    root_id: 'root',
    thread_id: 'thread',
    content: JSON.stringify({ text }),
  })

test('a topic answers another message while a background command runs, then the exit arrives as a reply', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    responses: [
      fauxToolCall('background_start', { command: 'sleep 0.5; echo READY' }),
      fauxText('Started the check.'),
      fauxText('Still running.'),
      (request) => {
        expect(request.lastUserText).toContain(
          'Background command bg-1 finished with exit code 0.',
        )
        expect(request.lastUserText).toContain('READY')
        return fauxText('The check finished.')
      },
    ],
    extensions: [
      background(),
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(topicEvent('trigger', 'run the slow check'))
  await until(() => fake.sent.length === 1, 'the first reply')
  // The command is still sleeping: answer a new message first.
  fake.deliver(topicEvent('status', 'what is the status?'))
  await until(() => fake.sent.length === 2, 'the status reply')
  await until(() => fake.sent.length === 3, 'the exit reply')
  expect(fake.sent).toEqual([
    {
      messageId: 'trigger',
      text: '<at user_id="ou_alice"></at> Started the check.',
    },
    {
      messageId: 'status',
      text: '<at user_id="ou_alice"></at> Still running.',
    },
    // The result is a new reply in the same topic, anchored to its root message.
    {
      messageId: 'root',
      text: '<at user_id="ou_alice"></at> The check finished.',
    },
  ])
  const last = t.model.calls.at(-1)!
  expect(last.lastUserText).toStartWith('Background command bg-1 finished')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain('Started bg-1')
})

test('background_stop ends a topic job and background_output reports an id lost to !restart', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    responses: [
      fauxToolCall('background_start', { command: 'sleep 30' }),
      fauxText('Started.'),
      fauxToolCall('background_stop', { id: 'bg-1' }),
      fauxText('Stopped it.'),
      fauxToolCall('background_output', { id: 'bg-1' }),
      fauxText('It is gone.'),
    ],
    extensions: [
      background(),
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(topicEvent('trigger', 'start a long server'))
  await until(() => fake.sent.length === 1, 'the start reply')
  fake.deliver(topicEvent('stop', 'stop it'))
  await until(() => fake.sent.length === 2, 'the stop reply')
  // background_stop returns the tail in its tool result; no separate delivery turn competes with it.
  const stopResult = t.model.calls
    .flatMap((call) => call.toolResults)
    .find((result) => result.toolName === 'background_stop')!.output
  expect(stopResult).toContain('bg-1 (stopped)')
  expect(fake.sent[1]!.text).toContain('Stopped it.')

  fake.deliver(topicEvent('restart', '!restart'))
  await until(() => fake.sent.length === 3, 'the restart notice')
  fake.deliver(topicEvent('check', 'check bg-1'))
  await until(() => fake.sent.length === 4, 'the reply after restart')
  expect(fake.sent[3]!.text).toContain('It is gone.')
  expect(t.model.calls.at(-1)!.toolResults[0]!.output).toContain(
    'Unknown background command bg-1. It may have finished and its result was delivered (or returned by background_stop), or it ended with a restart or session close.',
  )
})

test('a topic session stays open while a background command runs, past its idle deadline', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    channelIdleMs: 50,
    responses: [
      fauxToolCall('background_start', { command: 'sleep 0.5; echo READY' }),
      fauxText('Started the check.'),
      fauxText('The check finished.'),
    ],
    extensions: [
      background(),
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(topicEvent('trigger', 'start the slow check'))
  await until(() => fake.sent.length === 1, 'the first reply')
  const topic = 'lark-oc_group-root'
  // Past the idle deadline the command is still running, so the session must stay open.
  await Bun.sleep(300)
  expect(t.vela.sessions().map((session) => session.id)).toContain(topic)
  await until(() => fake.sent.length === 2, 'the exit reply')
  expect(fake.sent[1]!.text).toContain('The check finished.')
  // With no command left, the same deadline closes it as usual.
  await until(
    () => !t.vela.sessions().some((session) => session.id === topic),
    'the idle close',
  )
})

test('a preopened topic session, closed idle and resumed, still queues its background results', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    channelIdleMs: 50,
    responses: [
      fauxToolCall('background_start', { command: 'echo FIRST' }),
      fauxText('Started the first check.'),
      fauxText('The first check finished.'),
      fauxToolCall('background_start', { command: 'echo SECOND' }),
      fauxText('Started the second check.'),
      fauxText('The second check finished.'),
    ],
    extensions: [
      background(),
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  const topic = 'lark-oc_group-root'
  // An SDK (or CLI) caller opens the topic session before any channel message exists. Its options
  // apply at first open only, so the background tools come from this call.
  const preopened = t.vela.session(topic, {
    tools: ['+background_start', '+background_output', '+background_stop'],
  })
  await t.vela.startChannels()
  fake.deliver(topicEvent('trigger', 'run the first check'))
  await until(() => fake.sent.length === 1, 'the first start reply')
  // The gateway took over that same object rather than opening another one.
  expect(t.vela.sessions().find((session) => session.id === topic)).toBe(
    preopened,
  )
  await until(() => fake.sent.length === 2, 'the first exit reply')
  expect(fake.sent[1]).toEqual({
    messageId: 'root',
    text: '<at user_id="ou_alice"></at> The first check finished.',
  })
  // Idle cleanup saves and closes it; the next message reopens the same id and resumes that history.
  await until(
    () => !t.vela.sessions().some((session) => session.id === topic),
    'the idle close',
  )
  fake.deliver(topicEvent('again', 'run the second check'))
  await until(() => fake.sent.length === 3, 'the second start reply')
  await until(() => fake.sent.length === 4, 'the second exit reply')
  expect(fake.sent[2]).toEqual({
    messageId: 'again',
    text: '<at user_id="ou_alice"></at> Started the second check.',
  })
  // Resumed history, and the result still enters the queue anchored at the topic root.
  expect(fake.sent[3]).toEqual({
    messageId: 'root',
    text: '<at user_id="ou_alice"></at> The second check finished.',
  })
  expect(t.model.calls.at(-1)!.lastUserText).toStartWith(
    'Background command bg-1 finished with exit code 0.',
  )
})

test('a delivered job is forgotten, so background_output explains that it has ended', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    responses: [
      fauxToolCall('background_start', { command: 'echo DONE' }),
      fauxText('Started the check.'),
      fauxText('The check finished.'),
      fauxToolCall('background_output', { id: 'bg-1' }),
      fauxText('It has ended.'),
    ],
    extensions: [
      background(),
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(topicEvent('trigger', 'run the check'))
  await until(() => fake.sent.length === 2, 'the exit reply')
  fake.deliver(topicEvent('check', 'check bg-1'))
  await until(() => fake.sent.length === 3, 'the check reply')
  expect(fake.sent[2]!.text).toContain('It has ended.')
  expect(t.model.calls.at(-1)!.toolResults[0]!.output).toContain(
    'Unknown background command bg-1. It may have finished and its result was delivered',
  )
})

test('background tools are topic tools: absent from the group session and a DM, present in the topic', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    responses: [fauxText('group answer'), fauxText('dm answer')],
    extensions: [
      background(),
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(
    larkEvent({ message_id: 'group', content: '{"text":"@_user_1 hi"}' }),
  )
  await until(() => t.model.calls.length === 1, 'the group reply')
  for (const name of [
    'background_start',
    'background_output',
    'background_stop',
  ])
    expect(t.model.calls[0]!.tools).not.toContain(name)

  fake.deliver(topicEvent('topic', 'do the work'))
  await until(() => t.model.calls.length === 2, 'the topic reply')
  expect(t.model.calls[1]!.tools).toEqual(
    expect.arrayContaining([
      'background_start',
      'background_output',
      'background_stop',
    ]),
  )

  const dm = larkEvent(
    {
      chat_id: 'oc_dm',
      chat_type: 'p2p',
      message_id: 'dm',
      content: '{"text":"hi"}',
    },
    'ou_alice',
  )
  fake.deliver(dm)
  await until(() => t.model.calls.length === 3, 'the DM reply')
  for (const name of [
    'background_start',
    'background_output',
    'background_stop',
  ])
    expect(t.model.calls[2]!.tools).not.toContain(name)
})

test('a group session cannot add the background tools back with a configured list', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    responses: [fauxText('hello')],
    extensions: [
      background(),
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: [
          {
            id: 'oc_group',
            tools: ['background_start', 'background_output', 'read_file'],
          },
        ],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(
    larkEvent({ message_id: 'group', content: '{"text":"@_user_1 hi"}' }),
  )
  await until(() => t.model.calls.length === 1, 'the group reply')
  expect(t.model.calls[0]!.tools).not.toContain('background_start')
  expect(t.model.calls[0]!.tools).not.toContain('background_output')
  expect(t.model.calls[0]!.tools).toContain('read_file')
})
