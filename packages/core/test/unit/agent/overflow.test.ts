import { expect, test } from 'bun:test'
import { APICallError } from '@ai-sdk/provider'
import { isContextOverflow } from '../../../src/agent/overflow.ts'

test('provider context-overflow errors are recognised (patterns from pi)', () => {
  for (const message of [
    'prompt is too long: 213462 tokens > 200000 maximum',
    'Your input exceeds the context window of this model',
    "This model's maximum context length is 128000 tokens. However, you requested about 130000 tokens",
    "Requested token count exceeds the model's maximum context length of 131072 tokens",
    'the request exceeds the available context size, try increasing it',
  ])
    expect(isContextOverflow(new Error(message))).toBe(true)
})

test('the provider response body is checked too, and rate limits are not overflow', () => {
  const error = new APICallError({
    message: 'Bad Request',
    statusCode: 413,
    url: 'https://api.anthropic.com/v1/messages',
    requestBodyValues: {},
    responseBody:
      '{"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
  })
  expect(isContextOverflow(error)).toBe(true)
  expect(
    isContextOverflow(new Error('Rate limit: too many tokens per minute')),
  ).toBe(false)
  expect(isContextOverflow(new Error('400 Bad Request: invalid model'))).toBe(
    false,
  )
})
