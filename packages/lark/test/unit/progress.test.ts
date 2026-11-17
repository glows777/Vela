import { expect, test } from 'bun:test'
import type { VelaEvent } from '@glows777/vela-core/extension-api'
import type { LarkCard } from '../../src/cards.ts'
import { LarkProgress } from '../../src/progress.ts'
import type { LarkTransport } from '../../src/transport.ts'

const card: LarkCard = {
  schema: '2.0',
  header: { title: { tag: 'plain_text', content: 'A run is in progress' } },
  body: {
    elements: [
      { tag: 'markdown', content: 'Working' },
      { tag: 'column_set', columns: [] },
    ],
  },
}

const toolStart = {
  type: 'tool_execution_start',
  toolCallId: 'call_1',
  toolName: 'bash',
  args: { command: 'bun test' },
} as VelaEvent

function transport(patchCard: LarkTransport['patchCard']): LarkTransport {
  return { patchCard } as LarkTransport
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Condition did not arrive')
    await Bun.sleep(1)
  }
}

test('a transient live write failure is reported once and the card keeps updating', async () => {
  const reports: unknown[] = []
  const cards: LarkCard[] = []
  let attempts = 0
  const progress = new LarkProgress(
    transport(async (_messageId, next) => {
      attempts++
      if (attempts === 1) throw new Error('read ECONNRESET')
      cards.push(next)
    }),
    'card_1',
    card,
    async (error) => {
      reports.push(error)
    },
    { retryDelays: [1], writeInterval: 1 },
  )
  progress.event(toolStart)
  await until(() => attempts === 2)
  await progress.finish('done')
  expect(reports).toHaveLength(1)
  // The failed write, its retry, and the terminal card
  expect(attempts).toBe(3)
  expect(cards.at(-1)?.header.title.content).toBe('Finished')
})

test('a card that keeps failing live stops after its retry budget and reports once', async () => {
  const reports: unknown[] = []
  let attempts = 0
  const progress = new LarkProgress(
    transport(async () => {
      attempts++
      throw new Error('card permission denied')
    }),
    'card_2',
    card,
    async (error) => {
      reports.push(error)
    },
    { retryDelays: [1, 1, 1, 1], writeInterval: 1 },
  )
  progress.event(toolStart)
  await until(() => attempts === 5)
  expect(reports).toHaveLength(1)
  // Giving up skips the terminal write instead of retrying forever after delivery
  await expect(progress.finish('done')).rejects.toThrow(
    'card permission denied',
  )
  expect(attempts).toBe(5)
})

test('the first failed write may be the final card: it retries instead of giving up', async () => {
  const reports: unknown[] = []
  const cards: LarkCard[] = []
  let attempts = 0
  const progress = new LarkProgress(
    transport(async (_messageId, next) => {
      attempts++
      if (attempts === 1) throw new Error('read ECONNRESET')
      cards.push(next)
    }),
    'card_3',
    card,
    async (error) => {
      reports.push(error)
    },
    { finalRetryDelays: [1], writeInterval: 1 },
  )
  // A text-only run settles before its first live write, so the terminal write fails first
  await progress.finish('done')
  expect(attempts).toBe(2)
  expect(cards.at(-1)?.header.title.content).toBe('Finished')
  // The caller reports a final failure; nothing was reported as if the run were still live
  expect(reports).toEqual([])
})

test('a final card that keeps failing exhausts its own budget and rejects once', async () => {
  let attempts = 0
  const progress = new LarkProgress(
    transport(async () => {
      attempts++
      throw new Error('card permission denied')
    }),
    'card_4',
    card,
    async () => {
      throw new Error('unexpected report')
    },
    { finalRetryDelays: [1, 1], writeInterval: 1 },
  )
  await expect(progress.finish('done')).rejects.toThrow(
    'card permission denied',
  )
  expect(attempts).toBe(3)
})

test('live writes wait for the write interval and a burst coalesces', async () => {
  const writes: number[] = []
  const progress = new LarkProgress(
    transport(async () => {
      writes.push(Date.now())
    }),
    'card_5',
    card,
    async () => {
      throw new Error('unexpected report')
    },
    { writeInterval: 50 },
  )
  progress.event(toolStart)
  await until(() => writes.length >= 1)
  progress.event(toolStart)
  await until(() => writes.length >= 2)
  expect(writes[1]! - writes[0]!).toBeGreaterThanOrEqual(40)
  // Events arriving inside the next interval coalesce instead of each patching the card.
  for (let index = 0; index < 5; index++) progress.event(toolStart)
  await until(() => writes.length >= 3)
  await Bun.sleep(120)
  expect(writes).toHaveLength(3)
  await progress.finish('done')
})

test('the default live write interval keeps card updates a second apart', async () => {
  const writes: number[] = []
  const progress = new LarkProgress(
    transport(async () => {
      writes.push(Date.now())
    }),
    'card_6',
    card,
    async () => {
      throw new Error('unexpected report')
    },
  )
  progress.event(toolStart)
  await until(() => writes.length >= 1)
  progress.event(toolStart)
  await Bun.sleep(400)
  expect(writes).toHaveLength(1)
  await until(() => writes.length >= 2)
  expect(writes[1]! - writes[0]!).toBeGreaterThanOrEqual(950)
  await progress.finish('done')
})
