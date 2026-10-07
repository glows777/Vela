import type { LanguageModel } from 'ai'
import { DEFAULT_LIMITS, type VelaLimits } from '../limits'
import type { ModelPricing } from '../usage/tracker'

/** thinking 级别（同 pi）。映射到 AI SDK 的 `reasoning` 调用参数，`max` 按 `xhigh` 发。 */
export type ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/** 一个模型的元数据（models.json 的模型条目，同 pi 的字段名）。 */
export interface ModelSpec {
  id: string
  /** 显示名 */
  name?: string
  /** 上下文窗口（token）；写了时压缩阈值和输入上限按它算 */
  contextWindow?: number
  /** 是否支持 thinking；false 时不发 reasoning 参数 */
  reasoning?: boolean
  /** 价格，$ / 1M tokens；写了时用量统计用它 */
  cost?: ModelPricing
}

/** `vela.models()` 里的一项：`ref` 是 `provider/id`。 */
export interface ModelInfo extends ModelSpec {
  provider: string
  ref: string
}

/**
 * 一个模型 provider：列出已知模型，并按 id 创建 AI SDK 的 LanguageModel。
 * 没列出的 id 也可以创建（Vela 没有内置模型目录，和 pi 不同），只是没有元数据。
 */
export interface ProviderDefinition {
  models?: ModelSpec[]
  createModel(id: string): LanguageModel
}

export interface ResolvedModel {
  model: LanguageModel
  info: ModelInfo
}

const PROVIDER_NAME = /^[A-Za-z0-9][\w.-]*$/

/** provider 注册表：createVela 的 `providers`、models.json、扩展的 registerProvider 都进这里。 */
export class ModelRegistry {
  private readonly providers = new Map<string, ProviderDefinition>()

  constructor(providers: Record<string, ProviderDefinition> = {}) {
    for (const [name, provider] of Object.entries(providers))
      this.register(name, provider)
  }

  register(name: string, provider: ProviderDefinition): void {
    if (!PROVIDER_NAME.test(name))
      throw new Error(`无效的 provider 名 "${name}"`)
    if (this.providers.has(name))
      throw new Error(`provider ${name} 已经注册过`)
    this.providers.set(name, provider)
  }

  /** 所有 provider 列出的模型 */
  list(): ModelInfo[] {
    return [...this.providers].flatMap(([provider, def]) =>
      (def.models ?? []).map((spec) => ({
        ...spec,
        provider,
        ref: `${provider}/${spec.id}`,
      })),
    )
  }

  /** `provider/id` → 模型；id 里可以再有 `/`（例如 `openrouter/anthropic/claude`）。 */
  resolve(ref: string): ResolvedModel {
    const slash = ref.indexOf('/')
    if (slash <= 0 || slash === ref.length - 1)
      throw new Error(`模型要写成 provider/id，收到 "${ref}"`)
    const provider = ref.slice(0, slash)
    const id = ref.slice(slash + 1)
    const def = this.providers.get(provider)
    if (!def)
      throw new Error(
        `没有名为 ${provider} 的 provider（已有: ${[...this.providers.keys()].join(', ') || '无'}）`,
      )
    const spec = def.models?.find((m) => m.id === id) ?? { id }
    return {
      model: def.createModel(id),
      info: { ...spec, provider, ref: `${provider}/${id}` },
    }
  }
}

/** 直接传入的 LanguageModel（测试的 faux 等）的元数据：没有 ref。 */
export function describeModel(model: LanguageModel): ModelInfo {
  if (typeof model === 'string') return { provider: '', id: model, ref: model }
  return {
    provider: model.provider,
    id: model.modelId,
    ref: `${model.provider}/${model.modelId}`,
  }
}

/** thinking 级别 → AI SDK 的 `reasoning`；不支持 thinking 的模型或没设置时不发。 */
export function reasoningOption(
  level: ThinkingLevel | undefined,
  info: ModelSpec,
): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (level === undefined || info.reasoning === false) return
  if (level === 'off') return 'none'
  if (level === 'max') return 'xhigh'
  return level
}

/**
 * 按模型的上下文窗口算压缩阈值和输入上限（默认值就是按 200k 窗口定的比例）；
 * 没写 contextWindow 时用默认值。`overrides`（createVela / settings 里显式写的 limits）优先。
 */
export function limitsForModel(
  info: Pick<ModelSpec, 'contextWindow'>,
  overrides: Partial<VelaLimits> = {},
): VelaLimits {
  const window = info.contextWindow
  const derived: Partial<VelaLimits> = window
    ? {
        tokenBudget: window,
        // 留给输出的余量：200k 窗口是 16384（现在的默认值），小窗口按 15%，保证高于摘要阈值
        maxInputTokens: window - Math.min(16_384, Math.floor(window * 0.15)),
        summaryThreshold: Math.floor(window * 0.75),
        microcompactThreshold: Math.floor(window * 0.6),
        minMicroSavings: Math.floor(window * 0.1),
      }
    : {}
  const limits = { ...DEFAULT_LIMITS, ...derived }
  for (const [key, value] of Object.entries(overrides))
    if (value !== undefined) limits[key as keyof VelaLimits] = value
  return limits
}
