import { afterEach, expect, test } from 'bun:test'
import { z } from 'zod'
import type {
  ChannelDefinition,
  ChannelFeedbackUpdate,
  ChannelOutcome,
  ChannelRuntime,
  IncomingMessage,
  OutgoingMessage,
} from '../../src/channels/types.ts'
import { FeishuChannel } from '../../src/extensions/feishu/channel.ts'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { fakeFeishu } from '../support/feishu.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)
const message: IncomingMessage = {
  channelId: 'chat',
  senderId: 'alice',
  senderName: 'Alice',
  text: 'question',
  replyToId: 'original',
  topic: { rootId: 'root', threadId: 'thread' },
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error('Feedback lifecycle did not complete')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function basicChannel(send: ChannelDefinition['send']): ChannelDefinition {
  return {
    name: 'recording',
    description: 'Recording feedback',
    start() {},
    stop() {},
    send,
  }
}

test('the single feedback hook runs admission, controls, agent events and finish around preparation and delivery', async () => {
  const order: string[] = []
  const t = createTestVela({ responses: [fauxText('answer')] })
  const channel: ChannelDefinition = {
    ...basicChannel(async () => {
      order.push('reply')
    }),
    prepareMessage: async (msg) => {
      order.push('prepare')
      return msg
    },
    startRun: async (_msg, { acknowledge }) => {
      order.push(`admit:${acknowledge}`)
      return {
        event: async (update: ChannelFeedbackUpdate) => {
          if (update.type === 'controls') order.push('controls')
          else if (update.event.type === 'agent_start') order.push('agent')
        },
        finish: async (outcome: ChannelOutcome) => {
          order.push(`finish:${outcome}`)
        },
      }
    },
  }
  t.internals.gateway.register(channel)
  await t.internals.gateway.handleIncoming(channel.name, { ...message })
  expect(order).toEqual([
    'admit:true',
    'prepare',
    'controls',
    'agent',
    'reply',
    'finish:done',
  ])
})

test('handoff transfers input feedback and starts destination presentation without a second acknowledgement', async () => {
  const started: { text: string; acknowledge: boolean }[] = []
  const finished: { text: string; outcome: ChannelOutcome }[] = []
  const sent: OutgoingMessage[] = []
  let runtime!: ChannelRuntime
  let release!: () => void
  let entered = false
  const respond = (req: import('../../src/testing/faux.ts').FauxRequest) => {
    const source = req.lastUserText === 'source'
    return req.toolResults.length
      ? fauxText(source ? 'handed off' : 'resolved')
      : fauxToolCall(source ? 'handoff_go' : 'handoff_hold', {})
  }
  const channel: ChannelDefinition = {
    ...basicChannel(async (msg) => {
      sent.push(msg)
    }),
    connect: (value) => {
      runtime = value
    },
    startRun: async (msg, { acknowledge }) => {
      started.push({ text: msg.text, acknowledge })
      return {
        event() {},
        finish: async (outcome: ChannelOutcome) => {
          finished.push({ text: msg.text, outcome })
        },
      }
    },
  }
  const t = createTestVela({
    responses: Array(4).fill(respond),
    extensions: [
      function handoff(api) {
        api.registerChannel(channel)
        api.registerTool({
          name: 'go',
          description: 'Hand off',
          inputSchema: z.object({}),
          execute: async () => {
            runtime.dispatch('recording-chat', { ...message, text: 'target' })
            return 'dispatched'
          },
        })
        api.registerTool({
          name: 'hold',
          description: 'Hold target',
          inputSchema: z.object({}),
          execute: async () => {
            entered = true
            await new Promise<void>((resolve) => {
              release = resolve
            })
            return 'done'
          },
        })
      },
    ],
  })
  await t.vela.ready()
  try {
    await t.internals.gateway.handleIncoming(channel.name, {
      ...message,
      topic: undefined,
      text: 'source',
    })
    await until(() => entered)
    expect(started).toEqual([
      { text: 'source', acknowledge: true },
      { text: 'target', acknowledge: false },
    ])
    expect(finished).toEqual([])
    release()
    await until(() => finished.length === 2)
    expect(finished).toEqual([
      { text: 'target', outcome: 'done' },
      { text: 'source', outcome: 'done' },
    ])
    expect(sent.map((msg) => msg.text)).toEqual(['resolved'])
  } finally {
    release?.()
    await t.internals.gateway.stopAll()
  }
})

test('a channel without startRun still processes and replies to its input', async () => {
  const t = createTestVela({ responses: [fauxText('plain answer')] })
  const sent: OutgoingMessage[] = []
  const channel = basicChannel(async (msg) => {
    sent.push(msg)
  })
  t.internals.gateway.register(channel)
  await t.internals.gateway.handleIncoming(channel.name, { ...message })
  expect(sent).toEqual([
    {
      topic: message.topic,
      channelId: 'chat',
      recipientId: 'alice',
      text: 'plain answer',
      replyToId: 'original',
    },
  ])
})

test('Feishu starts feedback from normalized topic and reply data without a raw receive event', async () => {
  const fake = fakeFeishu()
  const t = createTestVela({
    responses: [fauxText('recovered answer')],
    extensions: [
      function normalized(api) {
        api.registerChannel(
          new FeishuChannel({
            appId: 'bot',
            appSecret: '',
            owners: ['alice'],
            chats: ['chat'],
            dataDir: api.dataDir,
            logger: api.logger,
            transport: fake.transport,
          }),
        )
      },
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  const reconstructed: IncomingMessage = JSON.parse(JSON.stringify(message))
  expect(reconstructed.raw).toBeUndefined()
  await t.internals.gateway.handleIncoming('feishu', reconstructed)
  expect(
    fake.reactions.map(({ messageId, emoji }) => ({ messageId, emoji })),
  ).toEqual([
    { messageId: 'original', emoji: 'OnIt' },
    { messageId: 'original', emoji: 'DONE' },
  ])
  expect(fake.cards).toHaveLength(1)
  expect(fake.sent.at(-1)?.text).toBe(
    '<at user_id="alice"></at> recovered answer',
  )
})
