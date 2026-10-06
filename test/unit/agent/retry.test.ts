import { expect, test } from 'bun:test'
import { calculateDelay, isRetryable, sleep } from '../../../src/agent/retry'

test('rate limits, overload, timeouts and 5xx are retryable; other 4xx are not', () => {
  for (const message of ['429 Too Many Requests', '529 overloaded', '408 timeout', '503 Service Unavailable', 'ECONNRESET', 'fetch failed'])
    expect(isRetryable(new Error(message))).toBe(true)
  for (const message of ['400 Bad Request', '401 Unauthorized', '404 model not found'])
    expect(isRetryable(new Error(message))).toBe(false)
  expect(isRetryable('429')).toBe(false)
})

test('backoff grows exponentially with ±25% jitter, is capped, and 0 means no wait', () => {
  for (let i = 0; i < 50; i++) {
    const d = calculateDelay(3, 100, 10_000)
    expect(d).toBeGreaterThanOrEqual(300)
    expect(d).toBeLessThanOrEqual(500)
  }
  expect(calculateDelay(20, 500, 1000)).toBeLessThanOrEqual(1250)
  expect(calculateDelay(5, 0)).toBe(0)
})

test('retry backoff is abortable', async () => {
  const controller = new AbortController()
  const waiting = sleep(30000, controller.signal)
  controller.abort(new Error('cancel retry'))
  await expect(waiting).rejects.toThrow('cancel retry')
})
