import { afterEach, expect, test } from 'bun:test'
import type {
  ChannelDefinition,
  IncomingMessage,
} from '../../../../src/channels/types.ts'
import { formatGroupContext } from '../../../../src/extensions/feishu/history.ts'
import { feishu } from '../../../../src/extensions/feishu/index.ts'
import { silentLogger } from '../../../../src/logger.ts'
import { fakeFeishu, feishuEvent } from '../../../support/feishu.ts'
import { cleanupTestVelas, createTestVela } from '../../../support/vela.ts'

afterEach(cleanupTestVelas)

test('group context puts named history before the named question and keeps only the latest 50 entries', () => {
  const history = Array.from({ length: 52 }, (_, i) => ({
    name: 'Bob',
    text: `message ${i}`,
  }))
  const result = formatGroupContext(history, {
    name: 'Alice',
    text: 'question',
  })
  expect(result).toStartWith('[Chat since last reply]\nBob: message 2\n')
  expect(result).toEndWith('Bob: message 51\n\n[Question]\nAlice: question')
  expect(result.match(/Bob:/g)).toHaveLength(50)
  expect(formatGroupContext([], { name: 'Alice', text: 'question' })).toBe(
    'Alice: question',
  )
})

test.each([{ chats: ['oc_group'] }, { chats: ' oc_group , oc_other ' }])(
  'Feishu chats config accepts arrays and comma-separated ids: %j',
  async ({ chats }) => {
    const fake = fakeFeishu()
    const t = createTestVela({
      responses: [],
      logger: silentLogger,
      extensionConfig: { feishu: { chats, owners: ' ou_alice , ou_owner ' } },
      extensions: [feishu({ transport: fake.transport })],
    })
    await t.vela.ready()
    const channel = (
      t.internals.gateway as unknown as {
        channels: Map<string, ChannelDefinition>
      }
    ).channels.get('feishu')!
    const received: IncomingMessage[] = []
    channel.onMessage?.(async (message) => {
      const prepared = channel.prepareMessage
        ? await channel.prepareMessage(message)
        : message
      if (prepared) received.push(prepared)
    })
    await t.vela.startChannels()
    fake.deliver(
      feishuEvent({ chat_id: 'disabled', chat_type: 'group' }, 'ou_alice'),
    )
    // The boundary rejects synchronously, even when an owner speaks in an unlisted group.
    expect(fake.historyCalls).toEqual([])
    fake.deliver(feishuEvent({}, 'ou_bob'))
    fake.deliver(
      feishuEvent({ chat_id: 'owner_dm', chat_type: 'p2p' }, 'ou_owner'),
    )
    const deadline = Date.now() + 2000
    while (received.length < 2) {
      if (Date.now() > deadline)
        throw new Error('Parsed chat/owner config did not admit messages')
      await Bun.sleep(1)
    }
    expect(received.map((message) => message.channelId).sort()).toEqual([
      'oc_group',
      'owner_dm',
    ])
    expect(t.model.calls).toEqual([])
  },
)
