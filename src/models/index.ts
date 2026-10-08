import type { LanguageModel } from 'ai'
import { DEFAULT_LIMITS, type VelaLimits } from '../limits.ts'
import type { ModelPricing } from '../usage/tracker.ts'

/** Default thinking level (like pi). */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium'

/** Thinking level (like pi). Maps to the AI SDK `reasoning` call option; `max` is sent as `xhigh`. */
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

/** Model metadata (a models.json model entry, same field names as pi). */
export interface ModelSpec {
  id: string
  /** Display name */
  name?: string
  /** Context window in tokens; when set, compaction thresholds and the input cap derive from it */
  contextWindow?: number
  /** Whether thinking is supported; when false, no reasoning option is sent */
  reasoning?: boolean
  /** Price in $ / 1M tokens; used for usage stats when set */
  cost?: ModelPricing
}

/** One entry of `vela.models()`; `ref` is `provider/id`. */
export interface ModelInfo extends ModelSpec {
  provider: string
  ref: string
}

/**
 * A model provider: lists known models and creates AI SDK LanguageModels by id.
 * Unlisted ids work too (unlike pi, Vela has no built-in model catalog), just without metadata.
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

/** Provider registry fed by createVela's `providers`, models.json and extensions' registerProvider. */
export class ModelRegistry {
  private readonly providers = new Map<string, ProviderDefinition>()

  constructor(providers: Record<string, ProviderDefinition> = {}) {
    for (const [name, provider] of Object.entries(providers))
      this.register(name, provider)
  }

  register(name: string, provider: ProviderDefinition): void {
    if (!PROVIDER_NAME.test(name))
      throw new Error(`Invalid provider name "${name}"`)
    if (this.providers.has(name))
      throw new Error(`Provider ${name} is already registered`)
    this.providers.set(name, provider)
  }

  /** Models listed by all providers */
  list(): ModelInfo[] {
    return [...this.providers].flatMap(([provider, def]) =>
      (def.models ?? []).map((spec) => ({
        ...spec,
        provider,
        ref: `${provider}/${spec.id}`,
      })),
    )
  }

  /** `provider/id` → model; the id may contain more `/` (e.g. `openrouter/anthropic/claude`). */
  resolve(ref: string): ResolvedModel {
    const slash = ref.indexOf('/')
    if (slash <= 0 || slash === ref.length - 1)
      throw new Error(`Model must be provider/id, got "${ref}"`)
    const provider = ref.slice(0, slash)
    const id = ref.slice(slash + 1)
    const def = this.providers.get(provider)
    if (!def)
      throw new Error(
        `No provider named ${provider} (available: ${[...this.providers.keys()].join(', ') || 'none'})`,
      )
    const spec = def.models?.find((m) => m.id === id) ?? { id }
    return {
      model: def.createModel(id),
      info: { ...spec, provider, ref: `${provider}/${id}` },
    }
  }
}

/** Metadata for a LanguageModel passed in directly (e.g. the test faux); no ref. */
export function describeModel(model: LanguageModel): ModelInfo {
  if (typeof model === 'string') return { provider: '', id: model, ref: model }
  return {
    provider: model.provider,
    id: model.modelId,
    ref: `${model.provider}/${model.modelId}`,
  }
}

/**
 * Thinking level → AI SDK `reasoning`. If the model entry says `reasoning: false`, `off` sends
 * nothing and any other level throws (not silently ignored: the user must know the setting has no
 * effect). Models without the field always get the option; a provider that rejects it throws as is.
 */
export function reasoningOption(
  level: ThinkingLevel,
  info: ModelInfo,
): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (info.reasoning === false) {
    if (level === 'off') return
    throw new Error(
      `Model ${info.ref} does not support thinking (reasoning: false) but the thinking level is ${level}; set the thinking level to off (/thinking off, --thinking off, or setThinkingLevel('off'))`,
    )
  }
  if (level === 'off') return 'none'
  if (level === 'max') return 'xhigh'
  return level
}

/** Tokens reserved for output (pi compaction's default reserveTokens) */
export const RESERVE_TOKENS = 16_384

/**
 * Derives compaction thresholds and the input cap from the model's context window (a 200k
 * window yields the defaults): input cap = window − 16384 (like pi); summary threshold = 75% of
 * the window, but at least 10% of the window below the input cap (the summary request must fit).
 * Defaults apply without contextWindow. `overrides` (explicit limits from createVela / settings) win.
 */
export function limitsForModel(
  info: Pick<ModelSpec, 'contextWindow'>,
  overrides: Partial<VelaLimits> = {},
): VelaLimits {
  const window = info.contextWindow
  let derived: Partial<VelaLimits> = {}
  if (window) {
    // Windows under 2 × 16384 (rare) reserve at most half, so the input cap never hits 0
    const maxInputTokens = Math.max(window - RESERVE_TOKENS, Math.floor(window / 2))
    const summaryThreshold = Math.min(
      Math.floor(window * 0.75),
      maxInputTokens - Math.floor(window * 0.1),
    )
    derived = {
      maxInputTokens,
      summaryThreshold,
      microcompactThreshold: Math.min(
        Math.floor(window * 0.6),
        Math.floor(summaryThreshold * 0.8),
      ),
      minMicroSavings: Math.floor(window * 0.1),
    }
  }
  const limits = { ...DEFAULT_LIMITS, ...derived }
  for (const [key, value] of Object.entries(overrides))
    if (value !== undefined) limits[key as keyof VelaLimits] = value
  return limits
}
