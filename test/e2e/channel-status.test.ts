import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { feishu } from '../../src/extensions/feishu/index.ts'
import {
  createFauxModel,
  type FauxStep,
  fauxHang,
  fauxSummary,
} from '../../src/testing/faux.ts'
import { fakeFeishu, feishuEvent } from '../support/feishu.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Status scenario did not finish')
    await Bun.sleep(1)
  }
}

function message(
  text: string,
  mentioned = true,
  root = 'root',
  chat = 'oc_group',
) {
  return feishuEvent({
    chat_id: chat,
    root_id: root,
    thread_id: `thread-${root}`,
    content: JSON.stringify({ text: mentioned ? `@_user_1 ${text}` : text }),
    mentions: mentioned ? [{ key: '@_user_1', id: { open_id: 'ou_bot' } }] : [],
  })
}

async function setup(
  responses: FauxStep[],
  cwd?: string,
  generate: FauxStep[] = [],
) {
  const fake = fakeFeishu()
  const model = createFauxModel({ responses, generate })
  const t = createTestVela({
    cwd,
    model: 'test/priced',
    providers: {
      test: {
        models: [
          {
            id: 'priced',
            contextWindow: 200000,
            cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
          },
          { id: 'unpriced', contextWindow: 100000 },
        ],
        createModel: () => model,
      },
    },
    extensions: [
      feishu({
        owners: ['ou_alice'],
        chats: ['oc_group', 'oc_other'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.startChannels()
  return { fake, model, t }
}

test.each([false, true])(
  'live !status replies without steering or stopping (mentioned=%s)',
  async (mentioned) => {
    const { fake, model, t } = await setup([fauxHang('working')])
    fake.deliver(message('original task'))
    await until(() => model.calls.length === 1)
    const session = t.vela.session('feishu-oc_group-root')
    const before = JSON.stringify(session.messages)
    fake.deliver(message('!status', mentioned))
    await until(() =>
      fake.sent.some((m) => m.text.includes('Model: test/priced')),
    )
    const status = fake.sent.at(-1)?.text ?? ''
    expect(status).toContain('Context:')
    expect(status).toContain('estimated')
    expect(status).toContain('No usage recorded yet')
    expect(session.isRunning).toBe(true)
    expect(JSON.stringify(session.messages)).toBe(before)
    expect(session.queue.steering).toEqual([])
    expect(model.calls).toHaveLength(1)
    fake.click(0, 'stop')
    await until(() => !session.isRunning)
  },
)

test('topic/group ledger counts summaries once and survives process and generation changes', async () => {
  const priced = {
    text: 'answer',
    usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 10 },
  }
  const first = await setup(
    [
      priced,
      priced,
      priced,
      priced,
      { text: 'second topic', usage: { input: 200, output: 20 } },
      { text: 'other group', usage: { input: 1000, output: 100 } },
    ],
    undefined,
    [
      (req) => ({
        ...fauxSummary()(req),
        usage: { input: 50, output: 5, cacheRead: 10, cacheWrite: 5 },
      }),
    ],
  )
  for (let i = 0; i < 4; i++) {
    first.fake.deliver(message(`question ${i}`))
    await until(() => first.fake.sent.length === i + 1)
  }
  await first.t.vela.session('feishu-oc_group-root').compact()
  first.fake.deliver(message('second topic', true, 'second'))
  await until(() => first.fake.sent.length === 5)
  first.fake.deliver(message('other group', true, 'elsewhere', 'oc_other'))
  await until(() => first.fake.sent.length === 6)
  first.fake.deliver(message('!status', false))
  await until(() => first.fake.sent.length === 7)
  const status = first.fake.sent.at(-1)?.text ?? ''
  expect(status).toContain('Topic: 495 tokens')
  expect(status).toContain('Group: 715 tokens')
  expect(status).toContain('$0.0006')
  expect(status).toContain('$0.0009')
  expect(status).toContain('Recorded since')
  const ledger = await first.t.readData('channels/usage.jsonl')
  const rows = ledger
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(rows).toHaveLength(7)
  expect(rows.filter((r) => r.key === 'feishu-oc_group-root')).toHaveLength(5)
  expect(rows[4].tokens).toEqual({
    inputTokens: 35,
    outputTokens: 5,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
  })
  expect(rows[4].cost).toBeCloseTo(0.00006725, 10)
  expect(first.model.calls).toHaveLength(7)
  await first.t.vela.dispose()

  const next = await setup(
    [{ text: 'new generation', usage: { input: 100, output: 10 } }],
    first.t.cwd,
  )
  try {
    next.fake.deliver(message('!status', true))
    await until(() => next.fake.sent.length === 1)
    expect(next.fake.sent[0]?.text).toContain('Topic: 495 tokens')
    expect(next.fake.sent[0]?.text).toContain('Group: 715 tokens')
    expect(next.model.calls).toHaveLength(0)
    next.fake.deliver(message('!restart', false))
    await until(() => next.fake.sent.length === 2)
    next.fake.deliver(message('!status', false))
    await until(() => next.fake.sent.length === 3)
    expect(next.fake.sent[2]?.text).toContain('Topic: 495 tokens')
    expect(next.fake.sent[2]?.text).toContain('Group: 715 tokens')
    expect(next.model.calls).toHaveLength(0)
    next.fake.deliver(message('fresh task', false))
    await until(() => next.fake.sent.length === 4)
    next.fake.deliver(message('!status', false))
    await until(() => next.fake.sent.length === 5)
    expect(next.fake.sent[4]?.text).toContain('Topic: 605 tokens')
    expect(next.fake.sent[4]?.text).toContain('Group: 825 tokens')
    const appended = await next.t.readData('channels/usage.jsonl')
    expect(appended.startsWith(ledger)).toBe(true)
    expect(appended.trim().split('\n')).toHaveLength(8)
  } finally {
    await next.t.vela.dispose()
  }
})

test('mixed known and unknown prices remain visible without pretending to be a complete cost', async () => {
  const f = await setup([
    { text: 'priced answer', usage: { input: 1000, output: 100 } },
    { text: 'unpriced answer', usage: { input: 2000, output: 200 } },
  ])
  f.fake.deliver(message('priced request'))
  await until(() => f.fake.sent.length === 1)
  f.t.vela.session('feishu-oc_group-root').setModel('test/unpriced')
  f.fake.deliver(message('unpriced request', false))
  await until(() => f.fake.sent.length === 2)
  f.fake.deliver(message('!status', false))
  await until(() => f.fake.sent.length === 3)
  const status = f.fake.sent[2]?.text ?? ''
  expect(status).toContain('Model: test/unpriced')
  expect(status).toContain('Topic: 3300 tokens')
  expect(status).toContain('known cost $0.0015')
  expect(status).toContain('1 unpriced request')
  expect(status).toContain('Earlier usage is not included')
  expect(f.model.calls).toHaveLength(2)
})

test('an unmentioned status in an unowned topic writes no session, directory or ledger', async () => {
  const fake = fakeFeishu()
  let loads = 0
  let writes = 0
  const t = createTestVela({
    sessionStorage: {
      load: async () => {
        loads++
        return undefined
      },
      append: async () => {
        writes++
      },
    },
    extensions: [
      feishu({
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.startChannels()
  fake.deliver(message('!status', false))
  await until(() => loads === 1)
  await t.internals.gateway.stopAll()
  expect(fake.sent).toEqual([])
  expect(fake.reactions).toEqual([])
  expect(t.model.calls).toEqual([])
  expect(writes).toBe(0)
  expect(existsSync(t.dataPath('channels/index.json'))).toBe(false)
  expect(existsSync(t.dataPath('channels/usage.jsonl'))).toBe(false)
})
