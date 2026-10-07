/**
 * 运行时上限与阈值。默认值就是 CLI 一直使用的值；createVela({ limits }) 可以部分覆盖，
 * 测试用它把重试退避降到 0、把压缩阈值调小，而不必构造十几万 token 的输入。
 */
export interface VelaLimits {
  /** 每次 agent loop 最多请求模型的轮数 */
  maxTurns: number
  /** 可重试错误的最大重试次数 */
  maxRetries: number
  /** 重试退避基数（指数退避 + 抖动）；0 表示不等待 */
  retryBaseMs: number
  /** 重试退避上限 */
  retryMaxMs: number
  /** 单次 agent loop 的 token 预算（超过 90% 告警，超过即停止） */
  tokenBudget: number
  /** 估算输入达到该值时尝试微压缩（折叠旧工具结果） */
  microcompactThreshold: number
  /** 估算输入达到该值时生成历史摘要 */
  summaryThreshold: number
  /** 微压缩至少要省下这么多 token 才采用 */
  minMicroSavings: number
  /** 单次请求的安全输入上限，超过直接停止本轮 */
  maxInputTokens: number
  /** bash 工具的执行超时 */
  bashTimeoutMs: number
}

export const DEFAULT_LIMITS: Readonly<VelaLimits> = Object.freeze({
  maxTurns: 15,
  maxRetries: 3,
  retryBaseMs: 500,
  retryMaxMs: 30_000,
  tokenBudget: 200_000,
  microcompactThreshold: 120_000,
  summaryThreshold: 150_000,
  minMicroSavings: 20_000,
  maxInputTokens: 183_616,
  bashTimeoutMs: 10_000,
})

export function resolveLimits(overrides: Partial<VelaLimits> = {}): VelaLimits {
  const limits = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(overrides))
    if (value !== undefined) limits[key as keyof VelaLimits] = value
  return limits
}
