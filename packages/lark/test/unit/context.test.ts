import { afterEach, expect, test } from 'bun:test'
import type {
  ChannelDefinition,
  IncomingMessage,
} from '@glows777/vela-channels'
import { silentLogger } from '@glows777/vela-core'
import { lark } from '@glows777/vela-lark'
import { fakeLark, larkEvent } from '../../../../test/support/lark.ts'
import {
  cleanupTestVelas,
  createTestVela,
} from '../../../../test/support/vela.ts'
import { formatGroupContext, messageTime } from '../../src/history.ts'

afterEach(cleanupTestVelas)

test('group context puts named history before the named question and keeps only the latest 50 entries', () => {
  const history = Array.from({ length: 52 }, (_, i) => ({
    name: 'Bob',
    text: `message ${i}`,
    time: '10:32',
  }))
  const result = formatGroupContext(history, {
    name: 'Alice',
    text: 'question',
    time: '10:33',
  })
  expect(result).toStartWith(
    '[Chat since last reply]\n[10:32] Bob: message 2\n',
  )
  expect(result).toEndWith(
    '[10:32] Bob: message 51\n\n[Question]\n[10:33] Alice: question',
  )
  expect(result.match(/\[10:32\] Bob:/g)).toHaveLength(50)
  expect(formatGroupContext([], { name: 'Alice', text: 'question' })).toBe(
    'Alice: question',
  )
})

test('a Lark create_time becomes a local HH:MM label', () => {
  const local = new Date(2026, 0, 2, 10, 32, 15)
  expect(messageTime(String(local.getTime()))).toBe('10:32')
  expect(messageTime(undefined)).toBeUndefined()
  expect(messageTime('not a time')).toBeUndefined()
})

test.each([{ chats: ['oc_group'] }, { chats: ' oc_group , oc_other ' }])(
  'Lark chats config accepts arrays and comma-separated ids: %j',
  async ({ chats }) => {
    const fake = fakeLark()
    const t = createTestVela({
      responses: [],
      logger: silentLogger,
      extensionConfig: { lark: { chats, owners: ' ou_alice , ou_owner ' } },
      extensions: [lark({ transport: fake.transport })],
    })
    await t.vela.ready()
    const channel = (
      t.internals.gateway as unknown as {
        channels: Map<string, ChannelDefinition>
      }
    ).channels.get('lark')!
    const received: IncomingMessage[] = []
    channel.onMessage?.(async (message) => {
      const prepared = channel.prepareMessage
        ? await channel.prepareMessage(message)
        : message
      if (prepared) received.push(prepared)
    })
    await t.vela.startChannels()
    fake.deliver(
      larkEvent({ chat_id: 'disabled', chat_type: 'group' }, 'ou_alice'),
    )
    // The boundary rejects synchronously, even when an owner speaks in an unlisted group.
    expect(fake.historyCalls).toEqual([])
    fake.deliver(larkEvent({}, 'ou_bob'))
    fake.deliver(
      larkEvent({ chat_id: 'owner_dm', chat_type: 'p2p' }, 'ou_owner'),
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
