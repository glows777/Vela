import { APICallError } from '@ai-sdk/provider'
import type { AgentErrorKind } from './events.ts'
import { isContextOverflow } from './overflow.ts'

// --- Error classification ---

// Like pi's quota exclusions, billing evidence takes precedence over a generic 429.
const BILLING =
  /insufficient[_ ](?:quota|balance|credits?|funds)|credit balance.*(?:too low|exhausted)|billing[_ ](?:error|limit|hard_limit)|out of (?:credits?|budget)|quota exceeded|exceeded (?:your )?current quota|subscription limit/i
const NETWORK =
  /ECONNRESET|EPIPE|ETIMEDOUT|timeout|timed out|fetch failed|network/i

/** Classify only the terminal error. Retry and compaction decisions keep their existing rules. */
export function classifyAgentError(error: unknown): AgentErrorKind {
  // SDK transport errors may put their code in a cause (pi also follows causes up to five levels).
  let current = error
  let text = ''
  let status: number | undefined
  let provider = false
  let contextOverflow = false
  for (let depth = 0; depth < 5 && current != null; depth++) {
    contextOverflow ||= isContextOverflow(current)
    if (APICallError.isInstance(current)) {
      provider = true
      status ??= current.statusCode
      text += `\n${current.responseBody ?? ''}`
    }
    text += `\n${current instanceof Error ? current.message : String(current)}`
    if (current instanceof Error) {
      if ('code' in current) text += `\n${String(current.code)}`
      current = current.cause
    } else break
  }
  // Faux/string provider errors carry their status at the beginning, not in an SDK field.
  if (status === undefined) {
    const message = error instanceof Error ? error.message : String(error)
    const match = /^(?:HTTP[ :]+)?([45]\d{2})\b/i.exec(message)
    if (match) status = Number(match[1])
  }
  if (status === 401 || status === 403) return 'auth'
  if (status === 402 || BILLING.test(text)) return 'billing'
  if (contextOverflow) return 'context_overflow'
  if (status === 429) return 'rate_limit'
  if (status === undefined && NETWORK.test(text)) return 'network'
  if (provider || status !== undefined) return 'provider'
  return 'unknown'
}

const ERROR_HINTS: Record<AgentErrorKind, string> = {
  auth: 'Check your API key: /login or vela setup.',
  billing: 'Check your provider balance and billing limits.',
  rate_limit: 'Wait a moment and retry, or use another model.',
  network: 'Check your connection and provider URL, then retry.',
  context_overflow: 'Shorten the conversation or start a new session.',
  provider: 'Check the provider status and model settings, then retry.',
  unknown: 'Check the error above and retry; if it persists, report it.',
}

/** One shared presentation hint; hosts must also retain the raw error. */
export function agentErrorHint(
  kind: AgentErrorKind | undefined,
): string | undefined {
  return kind === undefined ? undefined : ERROR_HINTS[kind]
}

export function isRetryable(error: unknown): boolean {
  // Provider HTTP errors: message is the response body text (e.g. "Rate limit reached ...") without
  // the status code, so use statusCode (AI SDK retries 408/409/429/5xx by default)
  if (APICallError.isInstance(error)) return error.isRetryable
  if (!(error instanceof Error)) return false

  const message = error.message || ''

  const statusMatch = message.match(/(\d{3})/)
  if (statusMatch) {
    const status = parseInt(statusMatch[1]!, 10)
    // 429 Too Many Requests, 529 Site is overloaded, 408 Request Timeout: transient, retry
    if ([429, 529, 408].includes(status)) return true

    // 5xx: server error, retry
    if (status >= 500 && status < 600) return true

    // 4xx: client error, do not retry
    if (status >= 400 && status < 500) return false
  }

  // Network problems (connection reset, broken pipe, timeout, fetch failed) are retryable
  if (message.includes('ECONNRESET') || message.includes('EPIPE')) return true
  if (message.includes('ETIMEDOUT') || message.includes('timeout')) return true
  if (message.includes('fetch failed') || message.includes('network'))
    return true
  // AI SDK wraps stream errors in NoOutputGeneratedError: the model produced no output,
  // usually a transient model problem, so retry
  if (message.includes('No output generated')) return true

  return false
}

// --- Exponential backoff with jitter ---
export function calculateDelay(
  attempt: number,
  baseMs = 500,
  maxMs = 30000,
): number {
  const exponential = baseMs * 2 ** (attempt - 1)
  const capped = Math.min(exponential, maxMs)
  const jitterRange = capped * 0.25
  const jittered = capped + (Math.random() * 2 - 1) * jitterRange
  return Math.max(0, Math.round(jittered))
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }, ms)
    signal?.addEventListener('abort', stop, { once: true })
  })
}
