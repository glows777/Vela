import { afterEach, expect, test } from 'bun:test'
import { formatGroupContext } from '../../../../src/extensions/feishu/channel.ts'
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

test.each([['oc_group'], ' oc_group , oc_other '])(
  'Feishu chats config accepts arrays and comma-separated ids: %j',
  async (chats) => {
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
        channels: Map<string, { roleFor(msg: unknown): string }>
      }
    ).channels.get('feishu')!
    expect(channel.roleFor({ channelId: 'oc_group', senderId: 'ou_bob' })).toBe(
      'owner',
    )
    await t.vela.startChannels()
    fake.deliver(
      feishuEvent({ chat_id: 'disabled', chat_type: 'group' }, 'ou_alice'),
    )
    // The boundary rejects synchronously, even when an owner speaks in an unlisted group.
    expect(fake.historyCalls).toEqual([])
    expect(t.model.calls).toEqual([])
  },
)
