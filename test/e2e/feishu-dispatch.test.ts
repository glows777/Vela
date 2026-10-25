import { afterEach, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { z } from 'zod'
import { feishu } from '../../src/extensions/feishu/index.ts'
import type { VelaExtension } from '../../src/extensions/types.ts'
import { memorySessionStorage } from '../../src/session/storage.ts'
import {
  type FauxRequest,
  fauxHang,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux.ts'
import { fakeFeishu, feishuEvent, historyMessage } from '../support/feishu.ts'
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
  cwd?: string,
  sessionStorage?: NonNullable<
    Parameters<typeof createTestVela>[0]
  >['sessionStorage'],
) {
  const fake = fakeFeishu()
  const t = createTestVela({
    responses,
    cwd,
    sessionStorage,
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
  expect(t.model.calls[1]?.system).toContain(
    'This topic contains a conversation about one task.',
  )
  const latestMessageInstruction = 'Respond to the latest user message.'
  expect(t.model.calls[1]?.system).toContain(latestMessageInstruction)
  expect(t.model.calls[0]?.system).not.toContain(latestMessageInstruction)
  expect(t.model.calls[2]?.system).not.toContain(latestMessageInstruction)
  const completionInstruction =
    'Acknowledgments, completion notices, and requests to stop repetition should receive only a brief acknowledgment, without repeating the report, its checklist, or the earlier task constraints.'
  expect(t.model.calls[1]?.system).toContain(completionInstruction)
  expect(t.model.calls[0]?.system).not.toContain(completionInstruction)
  expect(t.model.calls[2]?.system).not.toContain(completionInstruction)
  expect(t.model.calls[1]?.system).toContain(
    'ask one clear question and end the run',
  )
  expect(t.model.calls[2]?.system).not.toContain(
    'This topic contains a conversation about one task.',
  )
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

test('a topic handoff keeps the handled mention out of the next group input and keeps later peer messages', async () => {
  const handled = 'do issue 127'
  const respond = (req: FauxRequest) => {
    if (req.lastUserText.includes('new question'))
      return fauxText('second answer')
    if (req.toolResults.length) return fauxText('handed off')
    if (req.tools.includes('feishu_start_topic'))
      return fauxToolCall('feishu_start_topic', { task: 'Handle the request' })
    return fauxText('topic done')
  }
  const { fake, t, start } = setup(Array(6).fill(respond))
  await start()
  try {
    fake.deliver(
      feishuEvent({
        message_id: 'first',
        create_time: '3000',
        content: JSON.stringify({ text: handled }),
      }),
    )
    await until(() => fake.topics.length === 1)
    await until(() => !t.vela.session('feishu-oc_group').isRunning)
    fake.history.push(
      historyMessage('peer', 'ou_bob', 'check the tests', '4000'),
      historyMessage('first', 'ou_alice', handled, '3000'),
      historyMessage('stale', 'ou_bob', 'ancient note', '1000'),
    )
    fake.deliver(
      feishuEvent({
        message_id: 'second',
        create_time: '5000',
        content: '{"text":"new question"}',
      }),
    )
    await until(() => fake.sent.some((item) => item.text === 'second answer'))
    const second = t.model.calls.find(
      (call) =>
        call.lastUserText.includes('new question') &&
        call.tools.includes('feishu_start_topic'),
    )
    expect(second?.lastUserText).toBe(
      '[Chat since last reply]\nBob: check the tests\n\n[Question]\nAlice: new question',
    )
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
  await until(() =>
    fake.sent.some(
      (item) => item.text === '<at user_id="ou_bob"></at> received',
    ),
  )
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
  await until(() =>
    fake.sent.some(
      (item) => item.text === '<at user_id="ou_bob"></at> file received',
    ),
  )
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

const listCall = () => fauxToolCall('feishu_list_topics', {})
const listAnswer = (req: FauxRequest) =>
  fauxText(req.toolResults.at(-1)?.output ?? 'missing result')

test('topic listing after restart retains recorded same-group topics and stable coverage', async () => {
  const first = setup([fauxText('remember cobalt')])
  await first.start()
  first.fake.deliver(
    feishuEvent({ root_id: 'saved', thread_id: 'saved_thread' }),
  )
  await until(() => first.fake.sent.length === 1)
  await first.t.cleanup({ keepDir: true })
  const second = setup(
    [
      listCall(),
      listAnswer,
      fauxText('resumed cobalt'),
      listCall(),
      listAnswer,
    ],
    [],
    first.t.cwd,
  )
  try {
    await second.start()
    second.fake.deliver(
      feishuEvent({ content: '{"text":"what tasks do you see?"}' }),
    )
    await until(() => second.fake.sent.length === 1)
    const empty = JSON.parse(second.fake.sent[0]!.text)
    expect(empty.topics).toEqual([
      expect.objectContaining({
        rootId: 'saved',
        threadId: 'saved_thread',
        state: 'done',
      }),
    ])
    expect(empty.coverage).toMatch(/since .*\d{4}-\d{2}-\d{2}T/)
    expect(empty.coverage).toContain('earlier topics may exist')
    expect(empty.coverage).toContain('does not mean there are no tasks')
    second.fake.deliver(
      feishuEvent({
        root_id: 'saved',
        thread_id: 'saved_thread',
        mentions: [],
        content: '{"text":"continue cobalt"}',
      }),
    )
    await until(() => second.fake.sent.length === 2)
    expect(JSON.stringify(second.t.model.calls[2]?.prompt)).toContain(
      'remember cobalt',
    )
    second.fake.deliver(feishuEvent({ content: '{"text":"list tasks again"}' }))
    await until(() => second.fake.sent.length === 3)
    const observed = JSON.parse(second.fake.sent[2]!.text)
    expect(observed.topics).toEqual([
      expect.objectContaining({
        rootId: 'saved',
        threadId: 'saved_thread',
        state: 'done',
      }),
    ])
    expect(observed.coverage).toBe(empty.coverage)
  } finally {
    await second.t.cleanup()
    rmSync(first.t.cwd, { recursive: true, force: true })
  }
})

test('topic listing reports only this group with queued, running and stopped states', async () => {
  let entered = false
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const { fake, t, start } = setup([
    fauxText('owned'),
    fauxText('other group'),
    listCall(),
    listAnswer,
    fauxHang('working'),
    listCall(),
    listAnswer,
    listCall(),
    listAnswer,
  ])
  await start()
  try {
    fake.deliver(feishuEvent({ root_id: 'root', thread_id: 'thread' }))
    await until(() => fake.sent.length === 1)
    fake.deliver(
      feishuEvent({
        chat_id: 'oc_other',
        root_id: 'other',
        thread_id: 'other_thread',
      }),
    )
    await until(() => fake.sent.length === 2)
    fake.resources.set('queued-file', [Buffer.from('detail')])
    const download = fake.transport.getResource
    fake.transport.getResource = async (...args) => {
      entered = true
      await held
      return download(...args)
    }
    fake.deliver(
      feishuEvent({
        root_id: 'root',
        thread_id: 'thread',
        mentions: [],
        message_type: 'file',
        content: '{"file_key":"queued-file","file_name":"detail.txt"}',
      }),
    )
    await until(() => entered)
    async function list(state: string) {
      const count = fake.sent.length
      fake.deliver(feishuEvent({ content: '{"text":"list current topics"}' }))
      await until(() => fake.sent.length > count)
      const result = JSON.parse(fake.sent.at(-1)!.text)
      expect(result.topics).toEqual([
        expect.objectContaining({ rootId: 'root', threadId: 'thread', state }),
      ])
    }
    await list('queued')
    release()
    await until(() => t.model.calls.length === 5)
    await list('running')
    expect(fake.click(2, 'stop')).toMatchObject({ toast: { type: 'success' } })
    await until(() => fake.sent.some((item) => item.text.includes('Stopped')))
    await list('stopped')
  } finally {
    release()
    await t.internals.gateway.stopAll()
  }
})

test('an earlier-work follow-up has a disclosure instruction and puts its notice in the visible replacement topic entry', async () => {
  const notice =
    'The earlier topic could not be found. Continue investigating cobalt.'
  const { fake, t, start } = setup([
    listCall(),
    fauxToolCall('feishu_start_topic', { task: notice }),
    (req) =>
      req.tools.includes('feishu_start_topic')
        ? fauxText('handed off')
        : fauxText('continued'),
    (req) =>
      req.tools.includes('feishu_start_topic')
        ? fauxText('handed off')
        : fauxText('continued'),
  ])
  await start()
  fake.deliver(
    feishuEvent({
      message_id: 'followup',
      content: '{"text":"continue the earlier cobalt investigation"}',
    }),
  )
  await until(() =>
    fake.sent.some(
      (item) => item.text === '<at user_id="ou_alice"></at> continued',
    ),
  )
  expect(t.model.calls[1]?.system).toContain(
    'earlier work missing from the list',
  )
  expect(t.model.calls[1]?.system).toContain(
    'include that notice at the beginning of the task',
  )
  expect(t.model.calls[1]?.system).toContain(
    'An empty list does not mean there are no tasks',
  )
  expect(fake.topics).toEqual([{ messageId: 'followup', task: notice }])
  expect(fake.sent.some((item) => item.messageId === 'followup')).toBe(false)
})

test.each(['start', 'forward'] as const)(
  'Stop while %s is awaiting Feishu prevents task dispatch after the request returns',
  async (operation) => {
    let entered = false
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { fake, t, start } = setup([
      ...(operation === 'forward' ? [fauxText('target established')] : []),
      operation === 'start'
        ? fauxToolCall('feishu_start_topic', { task: 'cancelled task' })
        : fauxToolCall('feishu_forward_to_topic', { root_id: 'target' }),
      fauxText('must not run'),
    ])
    const create = fake.transport.startTopic
    const forward = fake.transport.forward
    fake.transport.startTopic = async (...args) => {
      entered = true
      await held
      return create(...args)
    }
    fake.transport.forward = async (...args) => {
      entered = true
      await held
      return forward(...args)
    }
    await start()
    try {
      if (operation === 'forward') {
        fake.deliver(
          feishuEvent({ root_id: 'target', thread_id: 'target_thread' }),
        )
        await until(() => fake.sent.length === 1)
      }
      fake.deliver(
        feishuEvent({
          message_id: 'source',
          content: '{"text":"do this task"}',
        }),
      )
      await until(() => entered)
      fake.deliver(
        feishuEvent({ message_id: 'cancel', content: '{"text":"stop"}' }),
      )
      await until(() => fake.cards.some((card) => card.replyToId === 'cancel'))
      const index = fake.cards.findIndex((card) => card.replyToId === 'cancel')
      expect(fake.click(index, 'stop')).toMatchObject({
        toast: { type: 'success' },
      })
      release()
      await until(() => fake.sent.some((item) => item.text.includes('Stopped')))
      await t.internals.gateway.stopAll()
      expect(t.model.calls).toHaveLength(operation === 'start' ? 1 : 2)
      expect(fake.sent.some((item) => item.text === 'must not run')).toBe(false)
      expect(t.eventsOf('agent_start')).toHaveLength(
        operation === 'start' ? 1 : 2,
      )
    } finally {
      release()
      await t.internals.gateway.stopAll()
    }
  },
)

test('a screenshot post handoff carries trigger images without copying group history images', async () => {
  const { fake, t, start } = setup([
    fauxToolCall('feishu_start_topic', {
      task: 'Fix the broken page in this screenshot',
    }),
    (req) =>
      req.tools.includes('feishu_start_topic')
        ? fauxText('handed off')
        : fauxText('fixed'),
    (req) =>
      req.tools.includes('feishu_start_topic')
        ? fauxText('handed off')
        : fauxText('fixed'),
  ])
  const png = readFileSync(
    new URL('../fixtures/images/blue.png', import.meta.url),
  )
  fake.resources.set('screenshot', [png])
  fake.resources.set('history-image', [
    readFileSync(new URL('../fixtures/images/quadrants.jpg', import.meta.url)),
  ])
  fake.history.push({
    message_id: 'old_image',
    create_time: '1000',
    msg_type: 'image',
    body: { content: '{"image_key":"history-image"}' },
    sender: { id: 'ou_bob', sender_type: 'user' },
  })
  await start()
  fake.deliver(
    feishuEvent({
      message_id: 'screenshot_post',
      message_type: 'post',
      content: JSON.stringify({
        zh_cn: {
          content: [
            [
              { tag: 'at', user_id: 'ou_bot' },
              { tag: 'text', text: 'this page is broken, fix it' },
              { tag: 'img', image_key: 'screenshot' },
            ],
          ],
        },
      }),
    }),
  )
  await until(() =>
    fake.sent.some(
      (item) => item.text === '<at user_id="ou_alice"></at> fixed',
    ),
  )
  const images = (req: FauxRequest | undefined) =>
    req?.prompt.flatMap((message) =>
      message.role === 'user'
        ? message.content.filter((part) => part.type === 'file')
        : [],
    ) ?? []
  expect(images(t.model.calls[0])).toHaveLength(2)
  expect(
    images(
      t.model.calls.find((req) =>
        req.system.includes(
          'This topic contains a conversation about one task.',
        ),
      ),
    ),
  ).toEqual([expect.objectContaining({ mediaType: 'image/png' })])
  expect(fake.resourceCalls).toHaveLength(2)
})

test('a newly dispatched topic can be listed and forwarded to while its initial storage load is pending', async () => {
  let entered = false
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const storage = memorySessionStorage()
  const { fake, t, start } = setup(
    [
      fauxToolCall('feishu_start_topic', { task: 'Investigate cobalt' }),
      listCall(),
      fauxText('listed'),
      fauxToolCall('feishu_forward_to_topic', { root_id: 'source' }),
      fauxText('forwarded'),
      fauxText('first topic answer'),
      fauxText('forwarded input answer'),
    ],
    [],
    undefined,
    {
      ...storage,
      load: async (id) => {
        if (id === 'feishu-oc_group-source') {
          entered = true
          await held
        }
        return storage.load(id)
      },
    },
  )
  await start()
  try {
    fake.deliver(feishuEvent({ message_id: 'source' }))
    await until(
      () =>
        entered &&
        t.model.calls.length === 3 &&
        !t.vela.session('feishu-oc_group').isRunning,
    )
    const listed = JSON.parse(t.model.calls[2]!.toolResults.at(-1)!.output)
    expect(listed.topics).toEqual([
      expect.objectContaining({
        rootId: 'source',
        threadId: 'thread_source',
        state: 'queued',
      }),
    ])
    fake.deliver(
      feishuEvent({
        message_id: 'followup',
        content: '{"text":"also inspect cobalt"}',
      }),
    )
    await until(() => t.model.calls.length === 5)
    expect(fake.forwards).toEqual([
      { messageId: 'followup', threadId: 'thread_source' },
    ])
    release()
    await until(() =>
      fake.sent.some(
        (item) =>
          item.text === '<at user_id="ou_alice"></at> forwarded input answer',
      ),
    )
    expect(t.model.calls[6]?.lastUserText).toContain(
      'Alice: also inspect cobalt',
    )
  } finally {
    release()
    await t.internals.gateway.stopAll()
  }
})

test('topic overview reports running, durable waiting, then done with requester and activity', async () => {
  let entered = false
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = setup(
    [
      fauxToolCall('hold_pause', {}),
      listCall(),
      listAnswer,
      fauxToolCall('feishu_wait_for_input', {
        reason: 'Which release should I use?',
      }),
      fauxText('Which release should I use?'),
      listCall(),
      listAnswer,
    ],
    [
      function hold(api) {
        api.registerTool({
          name: 'pause',
          description: 'Hold until the overview is read',
          inputSchema: z.object({}),
          execute: async () => {
            entered = true
            await held
            return 'ready'
          },
        })
      },
    ],
  )
  await first.start()
  try {
    first.fake.deliver(feishuEvent({ root_id: 'root', thread_id: 'thread' }))
    await until(() => entered)
    first.fake.deliver(feishuEvent({ message_id: 'running-list' }))
    await until(() => first.fake.sent.length === 1)
    const running = JSON.parse(first.fake.sent[0]!.text).topics[0]
    expect(running).toMatchObject({
      state: 'running',
      requester: { id: 'ou_alice', name: 'Alice' },
    })
    expect(Number.isNaN(Date.parse(running.updatedAt))).toBe(false)
    release()
    await until(() => first.fake.sent.length === 2)
    first.fake.deliver(feishuEvent({ message_id: 'waiting-list' }))
    await until(() => first.fake.sent.length === 3)
    const waiting = JSON.parse(first.fake.sent[2]!.text).topics[0]
    expect(waiting).toMatchObject({
      state: 'waiting',
      waitingReason: 'Which release should I use?',
      requester: running.requester,
    })
    expect(Date.parse(waiting.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(running.updatedAt),
    )
    await first.t.cleanup({ keepDir: true })
    const second = setup(
      [
        listCall(),
        listAnswer,
        fauxText('Release selected; done.'),
        listCall(),
        listAnswer,
      ],
      [],
      first.t.cwd,
    )
    try {
      await second.start()
      second.fake.deliver(feishuEvent({ message_id: 'after-restart-list' }))
      await until(() => second.fake.sent.length === 1)
      expect(JSON.parse(second.fake.sent[0]!.text).topics[0]).toMatchObject({
        state: 'waiting',
        waitingReason: waiting.waitingReason,
      })
      second.fake.deliver(
        feishuEvent(
          {
            message_id: 'decision',
            root_id: 'root',
            thread_id: 'thread',
            mentions: [],
            content: '{"text":"Use release blue"}',
          },
          'ou_bob',
        ),
      )
      await until(() => second.fake.sent.length === 2)
      second.fake.deliver(feishuEvent({ message_id: 'done-list' }))
      await until(() => second.fake.sent.length === 3)
      const done = JSON.parse(second.fake.sent[2]!.text).topics[0]
      expect(done).toMatchObject({
        state: 'done',
        requester: running.requester,
      })
      expect(done.waitingReason).toBeUndefined()
      expect(Date.parse(done.updatedAt)).toBeGreaterThanOrEqual(
        Date.parse(waiting.updatedAt),
      )
    } finally {
      await second.t.cleanup()
    }
  } finally {
    release()
    await first.t.cleanup()
    rmSync(first.t.cwd, { recursive: true, force: true })
  }
})
