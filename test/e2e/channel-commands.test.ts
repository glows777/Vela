import { afterEach, expect, test } from 'bun:test'
import { feishu } from '../../src/extensions/feishu/index.ts'
import { fauxHang, fauxText } from '../../src/testing/faux.ts'
import { fakeFeishu, feishuEvent, historyMessage } from '../support/feishu.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

async function until(check: () => boolean) {
  const deadline = Date.now() + 1500
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Topic command did not finish')
    await Bun.sleep(1)
  }
}

function message(text: string, mentioned = true) {
  return feishuEvent({
    root_id: 'root',
    thread_id: 'thread',
    content: JSON.stringify({ text: mentioned ? `@_user_1 ${text}` : text }),
    mentions: mentioned ? [{ key: '@_user_1', id: { open_id: 'ou_bot' } }] : [],
  })
}

async function setup(response = fauxText('original answer')) {
  const fake = fakeFeishu()
  const t = createTestVela({
    responses: [response],
    extensions: [
      feishu({
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  return { fake, t }
}

test.each([false, true])(
  '!stop retains the topic and continues its history (mentioned=%s)',
  async (mentioned) => {
    const { fake, t } = await setup(fauxHang('working'))
    fake.deliver(message('remember cobalt'))
    await until(() => t.model.calls.length === 1)
    fake.deliver(message('!stop', mentioned))
    await until(() =>
      fake.sent.some((m) => m.text.includes('Stopped the current run')),
    )
    const session = t.vela.session('feishu-oc_group-root')
    expect(session.isRunning).toBe(false)
    expect(t.model.calls).toHaveLength(1)
    t.model.push(fauxText('continued cobalt'))
    fake.deliver(message('continue', false))
    await until(() =>
      fake.sent.some((m) => m.text.includes('continued cobalt')),
    )
    expect(
      t.model.calls[1]?.prompt.some((m) =>
        JSON.stringify(m).includes('remember cobalt'),
      ),
    ).toBe(true)
    expect(JSON.stringify(t.model.calls[1]?.prompt)).not.toContain('!stop')
    const index = JSON.parse(await t.readData('channels/index.json'))
    expect(index.records[0].activeSessionId).toBe(session.id)
    expect(index.records[0].previousSessionIds).toEqual([])
  },
)

test.each([false, true])(
  '!restart archives idle history and the next unmentioned message loads the topic (mentioned=%s)',
  async (mentioned) => {
    const { fake, t } = await setup()
    fake.deliver(message('original task'))
    await until(() => fake.sent.length === 1)
    const oldId = 'feishu-oc_group-root'
    fake.deliver(message('!restart', mentioned))
    await until(() =>
      fake.sent.some((m) => m.text.includes('Restarted with a fresh session')),
    )
    expect(t.model.calls).toHaveLength(1)
    const index = JSON.parse(await t.readData('channels/index.json'))
    const freshId = index.records[0].activeSessionId
    expect(freshId).not.toBe(oldId)
    expect(index.records[0].previousSessionIds).toEqual([oldId])
    expect(await t.readData(`sessions/${oldId}.jsonl`)).toContain(
      'original task',
    )
    fake.topicHistory.push([
      historyMessage('prior', 'ou_bob', 'historical cobalt fact'),
    ])
    fake.topicHistoryCalls.length = 0
    t.model.push(fauxText('fresh answer'))
    fake.deliver(message('next question', false))
    await until(() => fake.sent.some((m) => m.text.includes('fresh answer')))
    expect(fake.topicHistoryCalls).toHaveLength(1)
    expect(t.model.calls[1]?.lastUserText).toContain('historical cobalt fact')
    expect(t.eventsIn(freshId).some((e) => e.type === 'agent_start')).toBe(true)
    expect(
      t.eventsIn(oldId).filter((e) => e.type === 'agent_start'),
    ).toHaveLength(1)
  },
)
