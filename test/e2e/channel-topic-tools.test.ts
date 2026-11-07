import { afterEach, expect, test } from 'bun:test'
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from '@glows777/vela-channels'
import { topicSessionOptions } from '@glows777/vela-channels'
import { drainChannels } from '@glows777/vela-channels/testing'
import { fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('a non-Lark channel starts, reads, waits and forwards through shared topic tools', async () => {
  let receive!: (message: IncomingMessage) => void | Promise<void>
  const sent: OutgoingMessage[] = []
  const started: string[] = []
  const forwarded: string[] = []
  const channel: ChannelDefinition = {
    name: 'fixture',
    description: 'Generic topic fixture',
    start() {},
    stop() {},
    async send(message) {
      sent.push(message)
    },
    onMessage(handler) {
      receive = handler
    },
    sessionOptions: topicSessionOptions,
    topicCapabilities: {
      async startTopic(_msg, title) {
        started.push(title)
        return { messageId: 'entry', rootId: 'root', threadId: 'thread' }
      },
      async forwardToTopic(msg, target) {
        forwarded.push(target.rootId)
        return { ...msg, replyToId: 'forwarded' }
      },
      async readTopic(chatId, threadId) {
        expect(chatId).toBe('group')
        expect(threadId).toBe('thread')
        return 'Visible topic answer'
      },
    },
  }
  const t = createTestVela({
    responses: [
      (req) => {
        expect(req.tools).toContain('channel_start_topic')
        expect(req.tools.some((name) => name.startsWith('lark_'))).toBe(false)
        return fauxToolCall('channel_start_topic', {
          title: 'Review report',
          brief: 'Review the report',
        })
      },
      (req) =>
        req.tools.includes('channel_start_topic')
          ? fauxText('Dispatched')
          : fauxText('Initial result'),
      (req) =>
        req.tools.includes('channel_start_topic')
          ? fauxText('Dispatched')
          : fauxText('Initial result'),
    ],
    extensions: [
      function fixture(api) {
        api.registerChannel(channel)
      },
    ],
  })
  await t.vela.startChannels()
  const message = {
    channelId: 'group',
    senderId: 'alice',
    senderName: 'Alice',
    text: 'Please review the report',
    replyToId: 'trigger',
  }
  await receive(message)
  await drainChannels(t.vela)
  expect(started).toEqual(['Review report'])
  expect(sent).toHaveLength(1)
  expect(sent[0]!.topic?.rootId).toBe('root')
  const topicCall = t.model.calls.find(
    (call) => !call.tools.includes('channel_start_topic'),
  )!
  expect(JSON.stringify(topicCall.prompt)).toContain(
    "Alice's original message, verbatim",
  )

  t.model.push(
    fauxToolCall('channel_list_topics', {}),
    fauxToolCall('channel_read_topic', { root_id: 'root' }),
    fauxText('Listed and read'),
  )
  await receive({ ...message, text: 'Read topic', replyToId: 'read' })
  expect(t.model.calls.at(-1)!.toolResults.at(-1)!.output).toContain(
    'Visible topic answer',
  )

  t.model.push(
    fauxToolCall('channel_wait_for_input', { reason: 'Choose a version' }),
    fauxText('Which version?'),
  )
  await receive({
    ...message,
    text: 'Choose',
    topic: { rootId: 'root', threadId: 'thread' },
    replyToId: 'choice',
  })
  t.model.push(fauxToolCall('channel_list_topics', {}), fauxText('Waiting'))
  await receive({ ...message, text: 'Status', replyToId: 'status' })
  expect(t.model.calls.at(-1)!.toolResults.at(-1)!.output).toContain(
    'Choose a version',
  )

  t.model.push(
    fauxToolCall('channel_forward_to_topic', { root_id: 'root' }),
    (req) =>
      req.tools.includes('channel_start_topic')
        ? fauxText('Forwarded')
        : fauxText('Version accepted'),
    (req) =>
      req.tools.includes('channel_start_topic')
        ? fauxText('Forwarded')
        : fauxText('Version accepted'),
  )
  await receive({ ...message, text: 'Use version two', replyToId: 'followup' })
  await drainChannels(t.vela)
  expect(forwarded).toEqual(['root'])
  expect(sent.at(-1)!.text).toBe('Version accepted')
})
