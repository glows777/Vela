import { afterEach, expect, test } from 'bun:test'
import { z } from 'zod'
import { feishu } from '../../src/extensions/feishu/index.ts'
import type { VelaExtension } from '../../src/extensions/types.ts'
import {
  type FauxRequest,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux.ts'
import { fakeFeishu, feishuEvent } from '../support/feishu.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)
const dispatchTools = [
  'feishu_start_topic',
  'feishu_forward_to_topic',
  'feishu_list_topics',
]
async function until(condition: () => boolean) {
  const deadline = Date.now() + 1500
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for dispatch')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
function setup(
  responses: NonNullable<Parameters<typeof createTestVela>[0]>['responses'],
  extensions: VelaExtension[] = [],
) {
  const fake = fakeFeishu()
  const t = createTestVela({
    responses,
    allowPendingResponses: true,
    extensions: [
      feishu({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group', 'oc_other'],
        transport: fake.transport,
      }),
      ...extensions,
    ],
  })
  return {
    fake,
    t,
    start: async () => {
      await t.vela.ready()
      await t.vela.startChannels()
    },
  }
}

test('short channel answers and topic/DM requests have the right prompts and visible tools', async () => {
  const { fake, t, start } = setup([
    fauxText('short answer'),
    fauxText('topic result'),
    fauxText('DM answer'),
  ])
  await start()
  fake.deliver(feishuEvent({ message_id: 'short' }))
  await until(() => fake.sent.length === 1)
  expect(t.model.calls[0]?.tools).toEqual(expect.arrayContaining(dispatchTools))
  expect(t.model.calls[0]?.system).toContain('in one reply, without tools')
  expect(fake.topics).toEqual([])
  expect(fake.sent[0]).toMatchObject({
    messageId: 'short',
    text: 'short answer',
  })
  fake.deliver(feishuEvent({ root_id: 'root', thread_id: 'thread' }))
  await until(() => fake.sent.length === 2)
  fake.deliver(feishuEvent({ chat_id: 'dm', chat_type: 'p2p', mentions: [] }))
  await until(() => fake.sent.length === 3)
  for (const call of t.model.calls.slice(1)) {
    expect(call.tools.some((name) => dispatchTools.includes(name))).toBe(false)
    expect(call.tools).toContain('read_file')
  }
  expect(t.model.calls[1]?.system).toContain('one task in this topic')
  expect(t.model.calls[1]?.system).toContain(
    'ask one clear question and end the run',
  )
  expect(t.model.calls[2]?.system).not.toContain('one task in this topic')
})

test('starting a topic returns its receipt and frees the channel while its task is still running', async () => {
  const respond = (req: FauxRequest) => {
    if (!req.tools.includes('feishu_start_topic'))
      return fauxToolCall('hold_pause', {})
    if (req.lastUserText.includes('second question'))
      return fauxText('second answer')
    if (req.toolResults.length) return fauxText('handed off')
    return fauxToolCall('feishu_start_topic', { task: 'Investigate cobalt' })
  }
  let entered = false
  const { fake, t, start } = setup(Array(6).fill(respond), [
    function hold(api) {
      api.registerTool({
        name: 'pause',
        description: 'Hold a task until it is stopped',
        inputSchema: z.object({}),
        execute: async (_input, context) => {
          entered = true
          await new Promise<void>((resolve) =>
            context?.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          )
          return 'stopped'
        },
      })
    },
  ])
  await start()
  try {
    fake.deliver(
      feishuEvent({
        message_id: 'task',
        content: '{"text":"investigate cobalt; unrelated chatter"}',
      }),
    )
    await until(() => t.eventsOf('tool_execution_end').length === 1)
    expect(fake.topics).toEqual([
      { messageId: 'task', task: 'Investigate cobalt' },
    ])
    await until(() => !t.vela.session('feishu-oc_group').isRunning)
    await until(() => entered)
    const topic = t.vela.session('feishu-oc_group-task')
    expect(topic.isRunning).toBe(true)
    const taskCall = t.model.calls.find(
      (call) => !call.tools.includes('feishu_start_topic'),
    )!
    expect(taskCall.lastUserText).toContain('Alice: Investigate cobalt')
    expect(taskCall.lastUserText).not.toContain('unrelated chatter')
    const receipt = t.model.calls.find(
      (call) => call.toolResults.length,
    )?.toolResults
    expect(JSON.stringify(receipt)).toContain('thread_task')
    expect(fake.sent).toEqual([])
    fake.deliver(
      feishuEvent({
        message_id: 'second',
        content: '{"text":"second question"}',
      }),
    )
    await until(() => fake.sent.some((item) => item.text === 'second answer'))
    expect(topic.isRunning).toBe(true)
    expect(fake.topics).toHaveLength(1)
  } finally {
    await t.internals.gateway.stopAll()
  }
})

test('forwarding a channel message feeds the same-group topic once with original sender attribution', async () => {
  const { fake, t, start } = setup([
    fauxText('topic established'),
    fauxToolCall('feishu_forward_to_topic', { root_id: 'root' }),
    (req) =>
      req.tools.includes('feishu_start_topic')
        ? fauxText('forwarded')
        : fauxText('received'),
    (req) =>
      req.tools.includes('feishu_start_topic')
        ? fauxText('forwarded')
        : fauxText('received'),
  ])
  await start()
  fake.deliver(feishuEvent({ root_id: 'root', thread_id: 'thread' }))
  await until(() => fake.sent.length === 1)
  fake.deliver(
    feishuEvent(
      { message_id: 'original', content: '{"text":"also inspect cobalt"}' },
      'ou_bob',
    ),
  )
  await until(() => fake.sent.some((item) => item.text === 'received'))
  expect(fake.forwards).toEqual([{ messageId: 'original', threadId: 'thread' }])
  const call = t.model.calls.find(
    (req) =>
      req.lastUserText.includes('Bob: also inspect cobalt') &&
      !req.tools.includes('feishu_start_topic'),
  )!
  expect(call).toBeDefined()
  expect(call.lastUserText.match(/also inspect cobalt/g)).toHaveLength(1)
  expect(fake.sent.some((item) => item.messageId === 'original')).toBe(false)
})

test('a failed topic creation reports the API cause without starting a task', async () => {
  const { fake, t, start } = setup([
    fauxToolCall('feishu_start_topic', { task: 'Investigate' }),
    (req) => fauxText(JSON.stringify(req.toolResults)),
  ])
  fake.failReply()
  // Permit the final visible error reply while the topic API still fails.
  fake.transport.reply = async (messageId, text) => {
    fake.sent.push({ messageId, text })
    return { messageId: 'error', createTime: '1' }
  }
  await start()
  fake.deliver(feishuEvent())
  await until(() => fake.sent.length === 1)
  expect(fake.sent[0]?.text).toContain('topic permission denied')
  expect(fake.topics).toEqual([])
  expect(
    t.vela.sessions().filter((session) => session.channel === 'feishu'),
  ).toHaveLength(1)
})

test('forwarding rejects a topic from another enabled group before the platform call', async () => {
  const { fake, t, start } = setup([
    fauxText('other group task'),
    fauxToolCall('feishu_forward_to_topic', { root_id: 'other_root' }),
    (req) => fauxText(JSON.stringify(req.toolResults)),
  ])
  await start()
  fake.deliver(
    feishuEvent({
      chat_id: 'oc_other',
      root_id: 'other_root',
      thread_id: 'other_thread',
    }),
  )
  await until(() => fake.sent.length === 1)
  fake.deliver(feishuEvent({ message_id: 'wrong_group' }))
  await until(() => fake.sent.length === 2)
  expect(fake.forwards).toEqual([])
  expect(fake.sent[1]?.text).toContain(
    'not an observed owned topic in this group',
  )
  expect(t.eventsOf('agent_start')).toHaveLength(2)
})

test('forwarded attachments are prepared from the original service message, not the forward receipt', async () => {
  const { fake, t, start } = setup([
    fauxText('topic established'),
    fauxToolCall('feishu_forward_to_topic', { root_id: 'root' }),
    (req) =>
      req.tools.includes('feishu_start_topic')
        ? fauxText('forwarded')
        : fauxText('file received'),
    (req) =>
      req.tools.includes('feishu_start_topic')
        ? fauxText('forwarded')
        : fauxText('file received'),
  ])
  fake.resources.set('file-key', [Buffer.from('cobalt notes')])
  await start()
  fake.deliver(feishuEvent({ root_id: 'root', thread_id: 'thread' }))
  await until(() => fake.sent.length === 1)
  fake.deliver(
    feishuEvent(
      {
        message_id: 'file_original',
        message_type: 'file',
        content: '{"file_key":"file-key","file_name":"notes.txt"}',
      },
      'ou_bob',
    ),
  )
  await until(() => fake.sent.some((item) => item.text === 'file received'))
  expect(fake.resourceCalls).toEqual([
    { messageId: 'file_original', key: 'file-key', type: 'file' },
  ])
  const input = t.model.calls.find(
    (req) =>
      !req.tools.includes('feishu_start_topic') &&
      req.lastUserText.includes('notes.txt'),
  )?.lastUserText
  expect(input).toContain('Bob: [file: notes.txt')
})
