import { APICallError } from '@ai-sdk/provider'

// --- Error classification ---

export function isRetryable(error: unknown): boolean {
  // Provider HTTP errors: message is the response body text (e.g. "Rate limit reached ...") without
  // the status code, so use statusCode (AI SDK retries 408/409/429/5xx by default)
  if (APICallError.isInstance(error)) return error.isRetryable
  if (!(error instanceof Error)) return false

  const message = error.message || ''

  const statusMatch = message.match(/(\d{3})/)
  if (statusMatch) {
    const status = parseInt(statusMatch[1]!)
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
