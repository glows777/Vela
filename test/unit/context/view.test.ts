import { expect, test } from 'bun:test'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { renderUsageView } from '../../../src/context/view.ts'
import { TokenTracker } from '../../../src/usage/tracker.ts'

const usage = { inputTokens: 60, cacheReadTokens: 30, cacheWriteTokens: 10, outputTokens: 7 }

test('/usage shows tokens but no dollar amount for a model without a price', () => {
  const tracker = new TokenTracker()
  tracker.record('some-unpriced-model', usage)
  const view = stripTerminalSequences(renderUsageView(tracker))

  expect(view).toContain('Input')
  expect(view).not.toContain('$')
  expect(view).not.toContain('Without cache')
})

test('/usage shows the cost for a priced model', () => {
  const tracker = new TokenTracker()
  tracker.record('mock-model', usage)
  const view = stripTerminalSequences(renderUsageView(tracker))

  expect(view).toMatch(/Cost\s+\$\d/)
  expect(view).toContain('Without cache')
})
