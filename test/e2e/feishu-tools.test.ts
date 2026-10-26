import { afterEach, expect, test } from 'bun:test'
import { feishu } from '../../src/extensions/feishu/index.ts'
import { silentLogger } from '../../src/logger.ts'
import { fauxText } from '../../src/testing/faux.ts'
import { fakeFeishu, feishuEvent } from '../support/feishu.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

const feishuTools = [
  'feishu_routines',
  'feishu_skip_reply',
  'feishu_wait_for_input',
  'feishu_search_history',
  'feishu_start_topic',
  'feishu_forward_to_topic',
  'feishu_list_topics',
]

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for the channel run')
    await Bun.sleep(1)
  }
}

test('Feishu tools reach channel sessions only', async () => {
  const fake = fakeFeishu()
  const t = createTestVela({
    responses: [
      fauxText('plain answer'),
      fauxText('group answer'),
      fauxText('topic answer'),
    ],
    allowPendingResponses: true,
    extensions: [
      feishu({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.run('hello')
  const plain = t.model.calls[0]!.tools
  expect(plain.filter((name) => name.startsWith('feishu_'))).toEqual([])
  expect(plain).toContain('read_file')

  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(feishuEvent({ message_id: 'group-message' }))
  await until(() => t.model.calls.length === 2)
  const group = t.model.calls[1]!.tools
  expect(group).toEqual(
    expect.arrayContaining(
      feishuTools.filter((name) => name !== 'feishu_wait_for_input'),
    ),
  )
  // The group channel's own deny list still hides the topic-only tool.
  expect(group).not.toContain('feishu_wait_for_input')
  expect(group).toContain('read_file')

  fake.deliver(feishuEvent({ root_id: 'root', thread_id: 'thread' }))
  await until(() => t.model.calls.length === 3)
  const topic = t.model.calls[2]!.tools
  expect(topic).toEqual(
    expect.arrayContaining([
      'feishu_routines',
      'feishu_search_history',
      'feishu_wait_for_input',
    ]),
  )
  expect(topic).not.toContain('feishu_start_topic')
  expect(topic).toContain('read_file')
})

test('Feishu does not start or log started without app credentials', async () => {
  const logs: string[] = []
  const t = createTestVela({
    logger: {
      ...silentLogger,
      info: (line) => logs.push(line),
      warn: (line) => logs.push(line),
    },
    extensions: [feishu({ owners: ['ou_alice'], chats: ['oc_group'] })],
  })
  await t.vela.startChannels()
  expect(logs).toContain(
    '[feishu] appId / appSecret not configured; channel will not connect to Feishu',
  )
  expect(logs.some((line) => line.includes('✓ feishu started'))).toBe(false)
})
