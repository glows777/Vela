/**
 * Runtime limits and thresholds. The defaults are what the CLI has always used; createVela({ limits })
 * can override some of them. Tests use this to drop retry backoff to 0 and shrink compaction
 * thresholds instead of building inputs of over 100k tokens.
 */
export interface VelaLimits {
  /** Max retries for retryable errors */
  maxRetries: number
  /** Retry backoff base (exponential backoff + jitter); 0 means no wait */
  retryBaseMs: number
  /** Retry backoff cap */
  retryMaxMs: number
  /** Try microcompaction (fold old tool results) when the estimated input reaches this */
  microcompactThreshold: number
  /** Summarize history when the estimated input reaches this */
  summaryThreshold: number
  /** Microcompaction is only applied if it saves at least this many tokens */
  minMicroSavings: number
  /** Safe input cap for a single request; the turn stops if exceeded */
  maxInputTokens: number
  /** Timeout for the bash tool */
  bashTimeoutMs: number
}

export const DEFAULT_LIMITS: Readonly<VelaLimits> = Object.freeze({
  maxRetries: 3,
  retryBaseMs: 500,
  retryMaxMs: 30_000,
  microcompactThreshold: 120_000,
  summaryThreshold: 150_000,
  minMicroSavings: 20_000,
  maxInputTokens: 183_616,
  bashTimeoutMs: 10_000,
})

/** Unknown limit names (typos, or the removed maxTurns / tokenBudget) throw instead of being silently ignored. */
export function assertLimitKeys(limits: object, where = 'limits'): void {
  for (const key of Object.keys(limits))
    if (!Object.hasOwn(DEFAULT_LIMITS, key))
      throw new Error(
        `Unknown key ${key} in ${where}; valid keys: ${Object.keys(DEFAULT_LIMITS).join(', ')}`,
      )
}

export function resolveLimits(overrides: Partial<VelaLimits> = {}): VelaLimits {
  assertLimitKeys(overrides)
  const limits = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(overrides))
    if (value !== undefined) limits[key as keyof VelaLimits] = value
  return limits
}
