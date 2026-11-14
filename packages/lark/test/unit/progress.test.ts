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

test('a transient card write failure is reported once and the card keeps updating', async () => {
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
    { retryDelays: [1] },
  )
  progress.event(toolStart)
  await until(() => attempts === 2)
  await progress.finish('done')
  expect(reports).toHaveLength(1)
  // The failed write, its retry, and the terminal card
  expect(attempts).toBe(3)
  expect(cards.at(-1)?.header.title.content).toBe('Finished')
})

test('a card that keeps failing stops after its retry budget and still reports once', async () => {
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
    { retryDelays: [1, 1, 1, 1] },
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
