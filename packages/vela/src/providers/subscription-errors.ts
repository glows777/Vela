/**
 * OpenAI's structured Responses errors for ChatGPT plan usage. The request layer (which tells the user where the
 * limit lives) and the retry layer (which decides whether the request may run again) both read this table, so a
 * code cannot be retryable in one place and terminal in the other.
 * https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
 */

/** Where ChatGPT plan usage is managed: OpenAI's documented link for `subscription_sharing_usage_limit_exceeded` */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'

/** Stands in for the usage URL in a hint until the provider's own URL is known */
const USAGE_PLACEHOLDER = '{usage}'

/**
 * Failure categories of the plan codes, named like the host's `AgentErrorKind` members so the driver can use the
 * value directly: an exhausted allowance is billing, a credential or grant the plan route refuses is auth, and a
 * request the plan route does not serve is a provider error (OpenAI's recovery column says which, per code).
 */
export type SubscriptionErrorKind = 'billing' | 'auth' | 'provider'

interface SubscriptionError {
  /** `error.code` of the Responses error object */
  code: string
  /** Whether the same request may be sent again */
  retry: boolean
  /** One sentence for the user */
  hint: string
  /** How the failure reads to the host, for the codes that must not be retried */
  kind?: SubscriptionErrorKind
}

const SUBSCRIPTION_ERRORS: readonly SubscriptionError[] = [
  {
    code: 'subscription_sharing_usage_limit_exceeded',
    retry: false,
    kind: 'billing',
    hint: `Check plan usage at ${USAGE_PLACEHOLDER}; the limit can be the plan's or one set for this app only.`,
  },
  {
    code: 'subscription_sharing_workplace_individual_usage_limit_exceeded',
    retry: false,
    kind: 'billing',
    hint: 'A workspace admin sets this limit for you in the OpenAI admin console at admin.openai.com.',
  },
  {
    code: 'subscription_sharing_usage_unavailable',
    retry: true,
    hint: 'ChatGPT plan usage could not be checked right now, so the request is retried.',
  },
  {
    code: 'subscription_sharing_user_unavailable',
    retry: true,
    hint: 'Your ChatGPT account details are temporarily unavailable, so the request is retried.',
  },
  {
    code: 'subscription_sharing_user_not_eligible',
    retry: false,
    kind: 'provider',
    hint: 'ChatGPT plan usage is not available for this account, workspace or policy.',
  },
  {
    code: 'subscription_sharing_unsupported_capability',
    retry: false,
    kind: 'provider',
    hint: 'The request used a model, tool or option that the ChatGPT plan route does not accept.',
  },
  {
    code: 'subscription_sharing_route_not_supported',
    retry: false,
    kind: 'provider',
    hint: 'This endpoint is not part of ChatGPT plan usage; the plan pays only for POST /v1/responses.',
  },
  {
    code: 'subscription_sharing_invalid_user',
    retry: false,
    kind: 'auth',
    hint: 'The ChatGPT sign-in could not be validated, so sign in again.',
  },
  {
    code: 'chatpass_v2_scope_not_authorized',
    retry: false,
    kind: 'auth',
    hint: 'The sign-in grant does not authorize this request; check the scopes OpenAI granted.',
  },
  {
    code: 'chatpass_v2_invalid_authorization_context',
    retry: false,
    kind: 'auth',
    hint: 'The signed permission context does not authorize this request; check the client and grant setup.',
  },
]

const find = (text: string) =>
  SUBSCRIPTION_ERRORS.find((error) => text.includes(error.code))

/** The subscription error code in a response body or message, when it carries one */
export function subscriptionErrorCode(text: string): string | undefined {
  return find(text)?.code
}

/** A plan failure that must not be retried, whatever status carried it */
export function isNonRetryableSubscriptionError(text: string): boolean {
  return find(text)?.retry === false
}

/** A plan failure that is worth retrying with backoff */
export function isRetryableSubscriptionError(text: string): boolean {
  return find(text)?.retry === true
}

/** How a terminal plan failure reads to the host, when the text carries a documented code */
export function subscriptionErrorKind(
  text: string,
): SubscriptionErrorKind | undefined {
  return find(text)?.kind
}

/** What the user can do about `code`; `usageUrl` overrides the ChatGPT usage link */
export function subscriptionHint(
  code: string,
  usageUrl?: string,
): string | undefined {
  const hint = SUBSCRIPTION_ERRORS.find((error) => error.code === code)?.hint
  return hint?.replace(USAGE_PLACEHOLDER, usageUrl ?? CHATGPT_USAGE_URL)
}
