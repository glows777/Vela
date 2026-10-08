import { expect, test } from 'bun:test'
import type { LanguageModelUsage } from 'ai'
import { normalizeUsage, TokenTracker } from '../../../src/usage/tracker.ts'

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

test('records cumulative usage per step', () => {
  const tracker = new TokenTracker()
  tracker.record('mock-model', {
    inputTokens: 60,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
    outputTokens: 7,
  })

  expect(tracker.totals().steps).toBe(1)
  expect(tracker.totals().inputTokens).toBe(60)
  expect(tracker.totals().cacheReadTokens).toBe(30)
  expect(tracker.totals().cacheWriteTokens).toBe(10)

})

const sampleUsage = { inputTokens: 60, cacheReadTokens: 30, cacheWriteTokens: 10, outputTokens: 7 }

test('a model without a known price has no cost', () => {
  const tracker = new TokenTracker()
  const record = tracker.record('some-unpriced-model', sampleUsage)

  expect(record.cost).toBeUndefined()
  const totals = tracker.totals()
  expect(totals.inputTokens).toBe(60)
  expect(totals.cost).toBeUndefined()
  expect(totals.baselineCost).toBeUndefined()
  expect(totals.savedCost).toBeUndefined()
})

test('the mock model keeps its demo price', () => {
  const tracker = new TokenTracker()
  expect(tracker.record('mock-model', sampleUsage).cost).toBeGreaterThan(0)
  expect(tracker.totals().cost).toBeGreaterThan(0)
})

test('totals add up only the priced requests', () => {
  const tracker = new TokenTracker()
  tracker.setPricing({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })
  tracker.record('priced', { inputTokens: 3, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  tracker.setPricing(undefined)
  tracker.record('unpriced', { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })

  const totals = tracker.totals()
  expect(totals.inputTokens).toBe(8)
  expect(totals.cost).toBeCloseTo(3)
  expect(totals.baselineCost).toBeCloseTo(3)
})
