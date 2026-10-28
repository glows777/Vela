import { afterEach, expect, test } from 'bun:test'
import { silentLogger } from '@glows777/vela-core'
import { fauxText } from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { fakeLark, larkEvent } from '../support/lark.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('input diagnostics separate transport, acknowledgement, preparation and model input without message text', async () => {
  const fake = fakeLark()
  const logs: string[] = []
  const reaction = Promise.withResolvers<void>()
  const history = Promise.withResolvers<void>()
  const controls = Promise.withResolvers<void>()
  const entered = { reaction: false, history: false, controls: false }
  const addReaction = fake.transport.addReaction
  fake.transport.addReaction = async (...args) => {
    if (args[1] === 'OnIt') {
      entered.reaction = true
      await reaction.promise
    }
    return addReaction(...args)
  }
  fake.transport.listTopicMessages = async () => {
    entered.history = true
    await history.promise
    return { items: [] }
  }
  const sendCard = fake.transport.sendCard
  fake.transport.sendCard = async (...args) => {
    entered.controls = true
    await controls.promise
    return sendCard(...args)
  }
  const t = createTestVela({
    responses: [fauxText('Received')],
    allowPendingResponses: true,
    logger: { ...silentLogger, debug: (line) => logs.push(line) },
    extensions: [
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  async function until(condition: () => boolean) {
    const deadline = Date.now() + 2000
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('Input stage not reached')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
  const has = (stage: string) =>
    logs.some((line) => line.includes(`input timing-message ${stage} at=`))
  try {
    await t.vela.ready()
    await t.vela.startChannels()
    fake.deliver(
      larkEvent({
        message_id: 'timing-message',
        root_id: 'root',
        thread_id: 'thread',
        create_time: '1792340069462',
        content: '{"text":"private-body-not-for-logs"}',
      }),
    )
    await until(() => entered.reaction)
    expect(has('received')).toBe(true)
    expect(logs.join('\n')).toContain('created=1792340069462')
    expect(has('prepared')).toBe(false)
    reaction.resolve()
    await until(() => entered.history)
    expect(has('acknowledged')).toBe(true)
    expect(has('prepared')).toBe(false)
    history.resolve()
    await until(() => entered.controls)
    expect(has('prepared')).toBe(true)
    expect(has('prompt')).toBe(false)
    expect(t.model.calls).toHaveLength(0)
    controls.resolve()
    await until(() => fake.sent.length === 1)
    expect(has('prompt')).toBe(true)
    expect(logs.join('\n')).not.toContain('private-body-not-for-logs')
  } finally {
    reaction.resolve()
    history.resolve()
    controls.resolve()
  }
})
