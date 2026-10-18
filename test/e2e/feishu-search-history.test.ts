import { afterEach, expect, test } from 'bun:test'
import { feishu } from '../../src/extensions/feishu/index.ts'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { fakeFeishu, feishuEvent, historyMessage } from '../support/feishu.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)
async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for history search')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

test('history search bounds pages, matches and characters and uses the logical group in channels and restarted topics', async () => {
  const fake = fakeFeishu()
  const calls: {
    chatId: string
    startTime: string
    endTime: string
    pageToken?: string
    limit: number
  }[] = []
  let mode: 'scan' | 'matches' | 'characters' | 'scope' | 'denied' = 'scan'
  fake.transport.searchMessages = async (chatId, options) => {
    calls.push({ chatId, ...options })
    if (mode === 'denied')
      throw new Error('Feishu 99991672: history permission denied')
    const page = Number(options.pageToken ?? 0)
    if (mode === 'scope')
      return {
        items: [
          historyMessage(
            `${chatId}-fact`,
            'ou_bob',
            `${chatId} cobalt`,
            '1760000099000',
          ),
        ],
      }
    return {
      items: Array.from({ length: 50 }, (_, index) => {
        const offset = page * 50 + index
        return historyMessage(
          `m-${offset}`,
          'ou_bob',
          mode === 'scan'
            ? offset === 73
              ? 'COBALT chosen'
              : 'other discussion'
            : mode === 'characters'
              ? `cobalt ${'x'.repeat(12000)}`
              : `cobalt ${offset}`,
          String(1760000099000 - offset * 1000),
        )
      }),
      pageToken: String(page + 1),
    }
  }
  const query = {
    keyword: 'cobalt',
    start_time: '2025-10-09T08:00:00Z',
    end_time: '2025-10-09T09:00:00Z',
  }
  const search = () => fauxToolCall('feishu_search_history', query)
  const answer = (req: import('../../src/testing/faux.ts').FauxRequest) =>
    fauxText(req.toolResults.at(-1)?.output ?? 'missing result')
  const t = createTestVela({
    responses: [
      search(),
      answer,
      search(),
      answer,
      search(),
      answer,
      search(),
      answer,
      search(),
      answer,
      search(),
      answer,
    ],
    allowPendingResponses: true,
    extensions: [
      feishu({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group', 'oc_other'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  let serial = 0
  async function run(chatId = 'oc_group', topic = false) {
    const count = fake.sent.length
    fake.deliver(
      feishuEvent({
        message_id: `search-${++serial}`,
        chat_id: chatId,
        ...(topic ? { root_id: 'root', thread_id: 'thread' } : {}),
      }),
    )
    await until(() => fake.sent.length > count)
    return fake.sent.at(-1)!.text.replace(/^<at[^>]*><\/at> /, '')
  }
  const scan = JSON.parse(await run())
  expect(scan.scanned).toBe(250)
  expect(scan.matches).toHaveLength(1)
  expect(scan.matches[0].text).toBe('COBALT chosen')
  expect(scan.truncated).toBe(true)
  expect(scan.scannedRange).toEqual({
    newest: '1760000099000',
    oldest: '1759999850000',
  })
  expect(scan.coverage).toContain('topic roots')
  expect(scan.coverage).toContain('end_time')
  expect(calls).toHaveLength(5)
  expect(calls.map((call) => call.pageToken)).toEqual([
    undefined,
    '1',
    '2',
    '3',
    '4',
  ])
  expect(
    calls.every(
      (call) =>
        call.chatId === 'oc_group' &&
        call.limit === 50 &&
        call.startTime === String(Date.parse(query.start_time) / 1000) &&
        call.endTime === String(Date.parse(query.end_time) / 1000),
    ),
  ).toBe(true)
  mode = 'matches'
  calls.length = 0
  const matches = JSON.parse(await run())
  expect(matches.matches).toHaveLength(20)
  expect(matches.truncated).toBe(true)
  expect(calls).toHaveLength(1)
  mode = 'characters'
  const characters = JSON.parse(await run())
  expect(characters.matches.length).toBeGreaterThan(0)
  expect(JSON.stringify(characters).length).toBeLessThanOrEqual(20000)
  expect(characters.truncated).toBe(true)
  mode = 'scope'
  calls.length = 0
  const topic = JSON.parse(await run('oc_other', true))
  expect(topic.matches[0].text).toBe('oc_other cobalt')
  expect(calls[0]?.chatId).toBe('oc_other')
  // A fresh physical session id must still resolve the topic's original group.
  fake.deliver(
    feishuEvent({
      message_id: 'restart',
      chat_id: 'oc_other',
      root_id: 'root',
      thread_id: 'thread',
      content: '{"text":"!restart"}',
    }),
  )
  await until(() => fake.sent.some((item) => item.text.includes('Restarted')))
  const restarted = JSON.parse(await run('oc_other', true))
  expect(restarted.matches[0].text).toBe('oc_other cobalt')
  expect(calls.every((call) => call.chatId === 'oc_other')).toBe(true)
  expect(
    t.vela.sessions().some((session) => session.id.startsWith('channel-')),
  ).toBe(true)
  mode = 'denied'
  expect(await run()).toContain('history permission denied')
})
