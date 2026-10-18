import { afterEach, expect, test } from 'bun:test'
import { feishu } from '../../src/extensions/feishu/index.ts'
import { fauxError, fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { fakeFeishu, feishuEvent } from '../support/feishu.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

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
