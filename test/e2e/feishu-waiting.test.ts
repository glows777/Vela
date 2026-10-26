import { afterEach, expect, test } from 'bun:test'
import { feishu } from '../../src/extensions/feishu/index.ts'
import { fauxError, fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { fakeFeishu, feishuEvent } from '../support/feishu.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('overview explains a reused topic label while preserving its current waiting reason', async () => {
  const fake = fakeFeishu()
  const t = createTestVela({
    responses: [
      fauxText('File checked.'),
      fauxToolCall('feishu_wait_for_input', {
        reason: 'Choose the title color',
      }),
      fauxText('Which color should the title use?'),
      fauxToolCall('feishu_list_topics', {}),
      (req) => fauxText(req.toolResults.at(-1)!.output),
    ],
    extensions: [
      feishu({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  const topic = { root_id: 'root', thread_id: 'thread' }
  async function deliver(overrides: Parameters<typeof feishuEvent>[0]) {
    const count = fake.reactions.filter((r) => r.emoji === 'DONE').length
    fake.deliver(feishuEvent(overrides))
    const deadline = Date.now() + 2000
    while (fake.reactions.filter((r) => r.emoji === 'DONE').length === count) {
      if (Date.now() > deadline) throw new Error('Topic did not settle')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
  await deliver({ ...topic, content: '{"text":"Check hello.txt"}' })
  await deliver({
    ...topic,
    content: '{"text":"Now ask me for a title color"}',
  })
  await deliver({ content: '{"text":"What are you working on?"}' })
  const result = JSON.parse(fake.sent.at(-1)!.text)
  expect(result.topics[0]).toMatchObject({
    task: 'Check hello.txt',
    state: 'waiting',
    waitingReason: 'Choose the title color',
  })
  expect(t.model.calls.at(-1)!.system).toContain('original title of the topic')
  expect(t.model.calls.at(-1)!.system).toContain(
    'waitingReason describes the current required input',
  )
})

test.each(['empty', 'failed'] as const)(
  'waiting requires a delivered question, not an %s answer',
  async (answer) => {
    const fake = fakeFeishu()
    const t = createTestVela({
      responses: [
        fauxToolCall('feishu_wait_for_input', {
          reason: 'Choose blue or green',
        }),
        answer === 'empty' ? fauxText('') : fauxError('400 model failed'),
      ],
      extensions: [
        feishu({
          appId: 'bot',
          owners: ['ou_alice'],
          chats: [{ id: 'oc_group', tools: [] }],
          transport: fake.transport,
        }),
      ],
    })
    await t.vela.ready()
    await t.vela.startChannels()
    fake.deliver(feishuEvent({ root_id: 'root', thread_id: 'thread' }))
    const deadline = Date.now() + 2000
    while (!fake.reactions.some((reaction) => reaction.emoji !== 'OnIt')) {
      if (Date.now() > deadline) throw new Error('Topic did not finish')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    await t.vela.dispose()
    const record = JSON.parse(await t.readData('channels/index.json'))
      .records[0]
    expect(t.model.calls[0]?.tools).toContain('feishu_wait_for_input')
    expect(record.state).toBe('done')
    expect(record.waitingReason).toBeUndefined()
  },
)
