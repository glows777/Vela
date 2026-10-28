import { expect, test } from 'bun:test'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { TokenTracker } from '../../../../core/dist/usage/tracker.js'
import { renderUsageView } from '../../../src/cli/context-view.ts'

const usage = {
  inputTokens: 60,
  cacheReadTokens: 30,
  cacheWriteTokens: 10,
  outputTokens: 7,
}

test('/usage shows tokens but no dollar amount for a model without a price', () => {
  const tracker = new TokenTracker()
  tracker.record('some-unpriced-model', usage)
  const view = stripTerminalSequences(renderUsageView(tracker.totals()))

  expect(view).toContain('Input')
  expect(view).not.toContain('$')
  expect(view).not.toContain('Without cache')
})

test('/usage shows the cost for a priced model', () => {
  const tracker = new TokenTracker()
  tracker.record('mock-model', usage)
  const view = stripTerminalSequences(renderUsageView(tracker.totals()))

  expect(view).toMatch(/Cost\s+\$\d/)
  expect(view).toContain('Without cache')
})
