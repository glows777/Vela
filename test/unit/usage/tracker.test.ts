import { expect, test } from 'bun:test'
import type { LanguageModelUsage } from 'ai'
import { normalizeUsage, TokenTracker } from '../../../src/usage/tracker'

test('normalizes AI SDK usage detail fields', () => {
  const usage: LanguageModelUsage = {
    inputTokens: 100,
    inputTokenDetails: {
      noCacheTokens: 60,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
    },
    outputTokens: 7,
    outputTokenDetails: {
      textTokens: 7,
      reasoningTokens: undefined,
    },
    totalTokens: 107,
  }

  expect(normalizeUsage(usage)).toEqual({
    inputTokens: 60,
    outputTokens: 7,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
  })
})

test('keeps loop budget separate from cumulative usage', () => {
  const tracker = new TokenTracker()
  tracker.record('mock-model', {
    inputTokens: 60,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
    outputTokens: 7,
  })

  expect(tracker.loopTokens).toBe(107)
  expect(tracker.totals().steps).toBe(1)
  expect(tracker.totals().inputTokens).toBe(60)
  expect(tracker.totals().cacheReadTokens).toBe(30)
  expect(tracker.totals().cacheWriteTokens).toBe(10)

  tracker.beginLoop()
  expect(tracker.loopTokens).toBe(0)
  expect(tracker.totals().steps).toBe(1)
})
