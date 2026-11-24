import { expect, test } from 'bun:test'
import { APICallError } from '@ai-sdk/provider'
import {
  calculateDelay,
  isRetryable,
  sleep,
} from '../../../../src/driver/agent/retry.ts'

test('rate limits, overload, timeouts and 5xx are retryable; other 4xx are not', () => {
  for (const message of [
    '429 Too Many Requests',
    '529 overloaded',
    '408 timeout',
    '503 Service Unavailable',
    'ECONNRESET',
    'fetch failed',
  ])
    expect(isRetryable(new Error(message))).toBe(true)
  for (const message of [
    '400 Bad Request',
    '401 Unauthorized',
    '404 model not found',
  ])
    expect(isRetryable(new Error(message))).toBe(false)
  expect(isRetryable('429')).toBe(false)
})

test('provider API errors are classified by status code, not by message text', () => {
  const apiError = (statusCode: number, message: string) =>
    new APICallError({ message, statusCode, url: 'x', requestBodyValues: {} })
  expect(isRetryable(apiError(429, 'Rate limit reached for gpt'))).toBe(true)
  expect(isRetryable(apiError(500, 'The server had an error'))).toBe(true)
  expect(isRetryable(apiError(400, 'Invalid value: 500 tokens'))).toBe(false)
})

test('a ChatGPT plan limit is billed, not retried, even when it arrives as a 429 or 503', async () => {
  const { classifyAgentError } = await import(
    '../../../../src/driver/agent/retry.ts'
  )
  const api = (statusCode: number, responseBody: string) =>
    new APICallError({
      statusCode,
      responseBody,
      message: 'Request failed',
      url: 'https://api.openai.com/v1/responses',
      requestBodyValues: {},
    })
  const limit = api(
    429,
    '{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"Plan limit reached"}}',
  )
  expect(isRetryable(limit)).toBe(false)
  expect(classifyAgentError(limit)).toBe('billing')
  // The code decides on its own when the 503 says the plan check failed
  const usageUnavailable = api(
    503,
    '{"error":{"code":"subscription_sharing_usage_unavailable"}}',
  )
  expect(isRetryable(usageUnavailable)).toBe(true)
  // A plan limit is not retryable as a rate limit, whichever layer carries the code
  expect(
    isRetryable(
      new Error('429 Plan limit: subscription_sharing_usage_limit_exceeded'),
    ),
  ).toBe(false)
  // Without a plan code the status still decides, and other provider errors are untouched
  expect(
    isRetryable(api(429, '{"error":{"message":"Too many requests"}}')),
  ).toBe(true)
  expect(
    classifyAgentError(api(429, '{"error":{"message":"Too many requests"}}')),
  ).toBe('rate_limit')
  expect(isRetryable(api(400, '{"error":{"code":"invalid_request"}}'))).toBe(
    false,
  )
  expect(
    classifyAgentError(api(400, '{"error":{"code":"invalid_request"}}')),
  ).toBe('provider')
})

test('a plan code that refuses the credentials or grant reads as auth, not as billing', async () => {
  const { classifyAgentError } = await import(
    '../../../../src/driver/agent/retry.ts'
  )
  const api = (statusCode: number, code: string) =>
    new APICallError({
      statusCode,
      responseBody: `{"error":{"code":"${code}"}}`,
      message: 'Request failed',
      url: 'https://api.openai.com/v1/responses',
      requestBodyValues: {},
    })
  // OpenAI's recovery table for these codes: check the account or the grant, and never change the billing path
  for (const [status, code] of [
    [401, 'subscription_sharing_invalid_user'],
    [403, 'chatpass_v2_scope_not_authorized'],
    [403, 'chatpass_v2_invalid_authorization_context'],
  ] as const) {
    expect(isRetryable(api(status, code))).toBe(false)
    expect(classifyAgentError(api(status, code))).toBe('auth')
  }
  // A request the plan route does not serve, or an account it does not cover, is a provider failure
  for (const [status, code] of [
    [403, 'subscription_sharing_user_not_eligible'],
    [400, 'subscription_sharing_unsupported_capability'],
    [403, 'subscription_sharing_route_not_supported'],
  ] as const) {
    expect(isRetryable(api(status, code))).toBe(false)
    expect(classifyAgentError(api(status, code))).toBe('provider')
  }
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

test('terminal kinds prefer provider bodies and context detection without changing retry policy', async () => {
  const { classifyAgentError } = await import(
    '../../../../src/driver/agent/retry.ts'
  )
  const api = (statusCode: number, responseBody: string) =>
    new APICallError({
      statusCode,
      responseBody,
      message: 'Request failed',
      url: 'x',
      requestBodyValues: {},
    })
  expect(
    classifyAgentError(api(429, '{"error":{"code":"insufficient_quota"}}')),
  ).toBe('billing')
  expect(
    classifyAgentError(
      api(400, '{"error":{"message":"Your credit balance is too low"}}'),
    ),
  ).toBe('billing')
  expect(
    classifyAgentError(
      api(400, '{"error":{"code":"context_length_exceeded"}}'),
    ),
  ).toBe('context_overflow')
  expect(
    classifyAgentError(
      api(429, '{"error":{"message":"Too many tokens, rate limit reached"}}'),
    ),
  ).toBe('rate_limit')
  expect(
    classifyAgentError(
      api(400, '{"error":{"message":"Invalid value: 401 tokens"}}'),
    ),
  ).toBe('provider')
  expect(classifyAgentError(new Error('401 Unauthorized'))).toBe('auth')
  expect(classifyAgentError(new Error('503 Service unavailable'))).toBe(
    'provider',
  )
  expect(classifyAgentError(new Error('Failure at line 401'))).toBe('unknown')
  expect(classifyAgentError(new Error('ETIMEDOUT'))).toBe('network')
  expect(classifyAgentError('something unexpected')).toBe('unknown')
})
