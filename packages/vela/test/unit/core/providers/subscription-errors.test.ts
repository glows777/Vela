import { expect, test } from 'bun:test'
import {
  CHATGPT_USAGE_URL,
  isNonRetryableSubscriptionError,
  isRetryableSubscriptionError,
  subscriptionErrorCode,
  subscriptionErrorKind,
  subscriptionHint,
} from '../../../../src/providers/subscription-errors.ts'

/** OpenAI's structured Responses error codes for ChatGPT plan usage, with the retry and category each one allows */
const TABLE = [
  ['subscription_sharing_usage_limit_exceeded', false, 'billing'],
  [
    'subscription_sharing_workplace_individual_usage_limit_exceeded',
    false,
    'billing',
  ],
  ['subscription_sharing_usage_unavailable', true, undefined],
  ['subscription_sharing_user_unavailable', true, undefined],
  ['subscription_sharing_user_not_eligible', false, 'provider'],
  ['subscription_sharing_unsupported_capability', false, 'provider'],
  ['subscription_sharing_route_not_supported', false, 'provider'],
  ['subscription_sharing_invalid_user', false, 'auth'],
  ['chatpass_v2_scope_not_authorized', false, 'auth'],
  ['chatpass_v2_invalid_authorization_context', false, 'auth'],
] as const

test('each documented plan code decides its own retry, whatever status carried it', () => {
  for (const [code, retry, kind] of TABLE) {
    expect(subscriptionErrorCode(`{"error":{"code":"${code}"}}`)).toBe(code)
    expect(isNonRetryableSubscriptionError(code)).toBe(!retry)
    expect(isRetryableSubscriptionError(code)).toBe(retry)
    // A retried code reads as a transient provider failure; a terminal one says what the user can change
    expect(subscriptionErrorKind(code)).toBe(kind)
  }
})

test('a body or message without a plan code is left to the normal retry rules', () => {
  for (const text of [
    '{"error":{"code":"insufficient_quota"}}',
    'Rate limit reached for gpt-6.2-sol',
    'subscription_sharing',
    '',
  ]) {
    expect(subscriptionErrorCode(text)).toBeUndefined()
    expect(isNonRetryableSubscriptionError(text)).toBe(false)
    expect(isRetryableSubscriptionError(text)).toBe(false)
  }
})

test('the usage limit hint links to the documented ChatGPT settings page', () => {
  const hint = subscriptionHint('subscription_sharing_usage_limit_exceeded')
  expect(hint).toContain(CHATGPT_USAGE_URL)
  expect(hint).toContain('app')
  expect(
    subscriptionHint(
      'subscription_sharing_usage_limit_exceeded',
      'https://example.com/usage',
    ),
  ).toContain('https://example.com/usage')
})

test('the workspace limit names the admin console and unknown codes have no hint', () => {
  expect(
    subscriptionHint(
      'subscription_sharing_workplace_individual_usage_limit_exceeded',
    ),
  ).toContain('admin.openai.com')
  expect(
    subscriptionHint('subscription_sharing_route_not_supported'),
  ).toContain('not part of ChatGPT plan usage')
  expect(subscriptionHint('subscription_sharing_invalid_user')).toContain(
    'sign in again',
  )
  expect(subscriptionHint('not_a_plan_code')).toBeUndefined()
})
