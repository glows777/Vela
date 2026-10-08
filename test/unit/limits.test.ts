import { expect, test } from 'bun:test'
import { DEFAULT_LIMITS, resolveLimits } from '../../src/limits.ts'

test('defaults match the values the CLI has always used', () => {
  expect(DEFAULT_LIMITS).toEqual({
    maxRetries: 3,
    retryBaseMs: 500,
    retryMaxMs: 30_000,
    microcompactThreshold: 120_000,
    summaryThreshold: 150_000,
    minMicroSavings: 20_000,
    maxInputTokens: 183_616,
    bashTimeoutMs: 10_000,
  })
})

test('overrides apply field by field and undefined keeps the default', () => {
  const limits = resolveLimits({ maxRetries: 1, retryBaseMs: undefined })
  expect(limits.maxRetries).toBe(1)
  expect(limits.retryBaseMs).toBe(500)
  expect(DEFAULT_LIMITS.maxRetries).toBe(3)
})

test('an unknown limit (e.g. the removed maxTurns) is an error, not silently ignored', () => {
  expect(() => resolveLimits({ maxTurns: 3 } as never)).toThrow('Unknown key maxTurns in limits')
})
