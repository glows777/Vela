import { afterEach, expect, test } from 'bun:test'
import { silentLogger } from '@glows777/vela-core'
import { fauxText } from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { fakeLark, larkEvent } from '../support/lark.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

const larkTools = [
  'channel_routines',
  'channel_skip_reply',
  'channel_wait_for_input',
  'lark_search_history',
  'channel_start_topic',
  'channel_forward_to_topic',
  'channel_list_topics',
]

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for the channel run')
    await Bun.sleep(1)
  }
}

test('Lark tools reach channel sessions only', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    responses: [
      fauxText('plain answer'),
      fauxText('group answer'),
      fauxText('topic answer'),
    ],
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
  await t.run('hello')
  const plain = t.model.calls[0]!.tools
  expect(plain.filter((name) => name.startsWith('lark_'))).toEqual([])
  expect(plain).toContain('read_file')

  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(larkEvent({ message_id: 'group-message' }))
  await until(() => t.model.calls.length === 2)
  const group = t.model.calls[1]!.tools
  expect(group.filter((name) => name.startsWith('lark_'))).toEqual([
    'lark_search_history',
  ])
  expect(group).toEqual(
    expect.arrayContaining(
      larkTools.filter((name) => name !== 'channel_wait_for_input'),
    ),
  )
  // The group channel's own deny list still hides the topic-only tool.
  expect(group).not.toContain('channel_wait_for_input')
  expect(group).toContain('read_file')

  fake.deliver(larkEvent({ root_id: 'root', thread_id: 'thread' }))
  await until(() => t.model.calls.length === 3)
  const topic = t.model.calls[2]!.tools
  expect(topic).toEqual(
    expect.arrayContaining([
      'channel_routines',
      'lark_search_history',
      'channel_wait_for_input',
    ]),
  )
  expect(topic).not.toContain('channel_start_topic')
  expect(topic).toContain('read_file')
})

test('Lark does not start or log started without app credentials', async () => {
  const logs: string[] = []
  const t = createTestVela({
    logger: {
      ...silentLogger,
      info: (line) => logs.push(line),
      warn: (line) => logs.push(line),
    },
    extensions: [lark({ owners: ['ou_alice'], chats: ['oc_group'] })],
  })
  await t.vela.startChannels()
  expect(logs).toContain(
    '[lark] appId / appSecret not configured; channel will not connect to Lark',
  )
  expect(logs.some((line) => line.includes('✓ lark started'))).toBe(false)
})
