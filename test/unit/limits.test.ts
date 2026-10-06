import { expect, test } from 'bun:test'
import { DEFAULT_LIMITS, resolveLimits } from '../../src/limits'

test('defaults match the values the CLI has always used', () => {
  expect(DEFAULT_LIMITS).toEqual({
    maxTurns: 15,
    maxRetries: 3,
    retryBaseMs: 500,
    retryMaxMs: 30_000,
    tokenBudget: 200_000,
    microcompactThreshold: 120_000,
    summaryThreshold: 150_000,
    minMicroSavings: 20_000,
    maxInputTokens: 183_616,
    bashTimeoutMs: 10_000,
  })
})

test('overrides apply field by field and undefined keeps the default', () => {
  const limits = resolveLimits({ maxTurns: 3, retryBaseMs: undefined })
  expect(limits.maxTurns).toBe(3)
  expect(limits.retryBaseMs).toBe(500)
  expect(DEFAULT_LIMITS.maxTurns).toBe(15)
})
