import { afterEach, expect, test } from 'bun:test'
import type { IncomingMessage } from '@glows777/vela-channels'
import { silentLogger } from '@glows777/vela-core'
import { fauxText } from '@glows777/vela-core/testing'
import type { LarkMessageEvent, LarkTransport } from '@glows777/vela-lark'
import { lark } from '@glows777/vela-lark'
import {
  cleanupTestVelas,
  createTestVela,
} from '../../../../test/support/vela.ts'
import { LarkChannel, UNSUPPORTED_MESSAGE } from '../../src/channel.ts'
import { messageText } from '../../src/messages.ts'

afterEach(cleanupTestVelas)

/** A fake Lark connection: `deliver` pushes an event, `sent` collects the texts sent to chats */
function fakeTransport(options: { failSend?: boolean } = {}) {
  let push: ((event: LarkMessageEvent) => void) | undefined
  const sent: { chatId?: string; messageId?: string; text: string }[] = []
  const transport: LarkTransport = {
    start: async (onMessage) => {
      push = onMessage
    },
    stop: () => {},
    startTopic: async () => {
      throw new Error('No topic creation in this fixture')
    },
    forward: async () => {
      throw new Error('No forwarding in this fixture')
    },
    getResource: async () => {
      throw new Error('No resources in this fixture')
    },
    getBotId: async () => 'ou_bot',
    getSenderName: async () => undefined,
    listTopicMessages: async () => ({ items: [] }),
    listMessages: async () => [],
    searchMessages: async () => ({ items: [] }),
    reply: async (messageId, text) => {
      if (options.failSend) throw new Error('send failed')
      sent.push({ messageId, text })
      return { messageId: 'reply', createTime: String(Date.now()) }
    },
    send: async (chatId, text) => {
      if (options.failSend) throw new Error('send failed')
      sent.push({ chatId, text })
    },
    sendCard: async () => 'card',
    patchCard: async () => {},
    addReaction: async () => 'reaction',
    removeReaction: async () => {},
  }
  return {
    transport,
    sent,
    deliver: (event: LarkMessageEvent) => push?.(event),
  }
}

const event = (
  message: Partial<LarkMessageEvent['message']>,
  openId: string | undefined = 'ou_1',
): LarkMessageEvent => ({
  message: {
    message_id: crypto.randomUUID(),
    chat_id: 'oc_1',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: 'hi' }),
    ...message,
  },
  sender: {
    sender_type: 'user',
    sender_id: openId ? { open_id: openId } : undefined,
  },
})

async function startedChannel(fake = fakeTransport()) {
  const channel = new LarkChannel({
    appId: '',
    appSecret: '',
    dataDir: '/tmp',
    owners: ['ou_owner'],
    chats: ['oc_1', 'oc_group', 'oc_g', 'oc_g2'],
    logger: silentLogger,
    transport: fake.transport,
  })
  const received: IncomingMessage[] = []
  channel.onMessage(async (msg) => {
    const prepared = await channel.prepareMessage(msg)
    if (prepared) received.push(prepared)
  })
  await channel.start()
  return { channel, received, ...fake }
}

test('text and rich-text (post) messages become plain text without @ mentions', () => {
  expect(
    messageText({
      chat_id: 'c',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 what is new?' }),
      mentions: [{ key: '@_user_1' }],
    }),
  ).toBe('what is new?')
  expect(
    messageText({
      chat_id: 'c',
      message_type: 'post',
      content: JSON.stringify({
        zh_cn: {
          title: 'Plan',
          content: [
            [
              { tag: 'at', user_id: 'ou_bot' },
              { tag: 'text', text: ' step one ' },
              { tag: 'a', text: 'link', href: 'https://example.com' },
            ],
            [
              { tag: 'img', image_key: 'x' },
              { tag: 'text', text: 'step two' },
            ],
          ],
        },
      }),
    }),
  ).toBe('Plan\n step one link\nstep two')
  expect(
    messageText({ chat_id: 'c', message_type: 'image', content: '{}' }),
  ).toBe('')
  expect(
    messageText({ chat_id: 'c', message_type: 'text', content: 'not json' }),
  ).toBe('')
})

test('a message delivered twice is handled once; chat and open_id pick the conversation and sender', async () => {
  const { received, deliver } = await startedChannel()
  const repeated = event(
    {
      message_id: 'om_1',
      chat_id: 'oc_group',
      chat_type: 'group',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
    },
    'ou_2',
  )
  deliver(repeated)
  deliver(repeated)
  deliver(event({ message_id: 'om_2' }))
  await waitFor(() => received.length === 2)
  expect(
    received
      .map((m) => [m.channelId, m.senderId, m.text])
      .sort((a, b) => a[0]!.localeCompare(b[0]!)),
  ).toEqual([
    ['oc_1', 'ou_1', 'ou_1: hi'],
    ['oc_group', 'ou_2', 'ou_2: hi'],
  ])
})

test('an unsupported message gets a short reply instead of silence; in a group only when the bot is mentioned', async () => {
  const { received, sent, deliver } = await startedChannel()
  deliver(event({ message_type: 'audio', content: '{}' }))
  deliver(event({ message_type: 'audio', chat_type: 'group', chat_id: 'oc_g' }))
  deliver(
    event({
      message_type: 'audio',
      chat_type: 'group',
      chat_id: 'oc_g2',
      message_id: 'audio_trigger',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
    }),
  )
  await Bun.sleep(0)
  expect(received).toHaveLength(0)
  expect(sent).toEqual([
    { chatId: 'oc_1', text: UNSUPPORTED_MESSAGE },
    { messageId: 'audio_trigger', text: UNSUPPORTED_MESSAGE },
  ])
})

test('replies go to the chat; a failed send throws so the gateway reports it', async () => {
  const ok = await startedChannel()
  await ok.channel.send({
    channelId: 'oc_9',
    recipientId: 'ou_1',
    text: 'answer',
  })
  expect(ok.sent).toEqual([{ chatId: 'oc_9', text: 'answer' }])

  const failing = await startedChannel(fakeTransport({ failSend: true }))
  await expect(
    failing.channel.send({
      channelId: 'oc_9',
      recipientId: 'ou_1',
      text: 'answer',
    }),
  ).rejects.toThrow('send failed')
})

test('without app id, secret or a transport the channel does not connect', async () => {
  const warnings: string[] = []
  const channel = new LarkChannel({
    appId: '',
    appSecret: '',
    dataDir: '/tmp',
    owners: [],
    logger: { ...silentLogger, warn: (message) => warnings.push(message) },
  })
  await channel.start()
  await channel.send({ channelId: 'oc_1', recipientId: 'ou_1', text: 'x' })
  expect(warnings).toHaveLength(2)
})

test('owners and enabled chats from comma-separated config give permitted senders owner tools', async () => {
  const fake = fakeTransport()
  const t = createTestVela({
    responses: [
      (req) => fauxText(`tools: ${req.tools.join(',') || 'none'}`),
      (req) => fauxText(`tools: ${req.tools.join(',') || 'none'}`),
    ],
    extensionConfig: {
      lark: { owners: ' ou_owner , ou_other ', chats: ' oc_b , oc_c ' },
    },
    extensions: [lark({ transport: fake.transport })],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  const replies = () => fake.sent.map((m) => m.text)

  fake.deliver(event({ chat_id: 'oc_a' }, 'ou_owner'))
  await waitFor(() => replies().length === 1)
  expect(replies()[0]).toContain('bash')

  fake.deliver(event({ chat_id: 'oc_b' }, 'ou_stranger'))
  await waitFor(() => replies().length === 2)
  expect(replies()[1]).toContain('bash')
  expect(replies()[1]).toContain('read_file')
})

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5)
  expect(condition()).toBe(true)
}
