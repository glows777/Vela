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
  /**
   * Whether microcompaction (folding old tool results) is allowed; false skips it only, while
   * summaries and overflow compaction still follow autoCompaction.
   */
  microcompact: boolean
  /** Try microcompaction (fold old tool results) when the estimated input reaches this */
  microcompactThreshold: number
  /** Summarize history when the estimated input reaches this */
  summaryThreshold: number
  /** Microcompaction is only applied if it saves at least this many tokens */
  minMicroSavings: number
  /** Safe input cap for a single request; the turn stops if exceeded */
  maxInputTokens: number
}

export const DEFAULT_LIMITS: Readonly<VelaLimits> = Object.freeze({
  maxRetries: 3,
  retryBaseMs: 500,
  retryMaxMs: 30_000,
  microcompact: true,
  microcompactThreshold: 120_000,
  summaryThreshold: 150_000,
  minMicroSavings: 20_000,
  maxInputTokens: 183_616,
})

/** Unknown limit names (typos, or the removed maxTurns / tokenBudget) throw instead of being silently ignored. */
export function assertLimitKeys(limits: object, where = 'limits'): void {
  for (const key of Object.keys(limits))
    if (!Object.hasOwn(DEFAULT_LIMITS, key))
      throw new Error(
        `Unknown key ${key} in ${where}; valid keys: ${Object.keys(DEFAULT_LIMITS).join(', ')}`,
      )
}

/** Copies an override onto the limits, keeping the default when the value is undefined. */
function assignLimit<K extends keyof VelaLimits>(
  limits: VelaLimits,
  overrides: Partial<VelaLimits>,
  key: K,
): void {
  const value = overrides[key]
  if (value !== undefined) limits[key] = value
}

/** Applies the defined overrides in place; the names were checked by assertLimitKeys. */
export function applyLimits(
  limits: VelaLimits,
  overrides: Partial<VelaLimits>,
): VelaLimits {
  for (const key of Object.keys(overrides) as (keyof VelaLimits)[])
    assignLimit(limits, overrides, key)
  return limits
}

export function resolveLimits(overrides: Partial<VelaLimits> = {}): VelaLimits {
  assertLimitKeys(overrides)
  return applyLimits({ ...DEFAULT_LIMITS }, overrides)
}
