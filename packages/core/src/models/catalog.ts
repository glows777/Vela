import type { ModelPricing } from '../usage/tracker.ts'

/** Thinking level (like pi). Maps to the AI SDK `reasoning` call option. */
export type ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

/** @experimental Shared thinking-level choices for frontends. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/** Default thinking level (like pi). */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium'

/** Model metadata (a models.json model entry or a catalog entry, same field names as pi). */
export interface ModelSpec {
  id: string
  /** Display name */
  name?: string
  /** Context window in tokens; when set, compaction thresholds and the input cap derive from it */
  contextWindow?: number
  /** Maximum output tokens */
  maxTokens?: number
  /** Whether thinking is supported; false limits the thinking level to `off` */
  reasoning?: boolean
  /**
   * Provider value per thinking level (pi's thinkingLevelMap); `null` marks a level the model doesn't support.
   * `xhigh` and `max` are only offered when listed here.
   */
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>
  /** Input types (`text`, `image`) */
  input?: string[]
  /** Price in $ / 1M tokens; used for usage stats when set */
  cost?: ModelPricing
}

/** One model of the built-in catalog (pi's model metadata, see scripts/update-models.ts). */
export interface CatalogModel extends ModelSpec {
  /** Wire protocol: `anthropic-messages`, `openai-responses` or `openai-completions` */
  api: string
}

/**
 * Thinking levels a model supports (pi's getSupportedThinkingLevels): only `off` for `reasoning: false`;
 * otherwise every level except those its thinkingLevelMap marks `null`, and `xhigh` / `max` only when the map
 * names them. A model without metadata (`reasoning` unset) is not limited.
 */
export function supportedThinkingLevels(
  spec: Pick<ModelSpec, 'reasoning' | 'thinkingLevelMap'>,
  all: readonly ThinkingLevel[],
): ThinkingLevel[] {
  if (spec.reasoning === undefined) return [...all]
  if (!spec.reasoning) return ['off']
  return all.filter((level) => {
    const mapped = spec.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/** The supported level closest to `level` (pi's clampThinkingLevel): the next higher one, else the next lower one. */
export function clampThinkingLevel(
  level: ThinkingLevel,
  spec: Pick<ModelSpec, 'reasoning' | 'thinkingLevelMap'>,
  all: readonly ThinkingLevel[],
): ThinkingLevel {
  const available = supportedThinkingLevels(spec, all)
  if (available.includes(level)) return level
  const index = all.indexOf(level)
  for (let i = index; i < all.length; i++)
    if (available.includes(all[i] as ThinkingLevel))
      return all[i] as ThinkingLevel
  for (let i = index - 1; i >= 0; i--)
    if (available.includes(all[i] as ThinkingLevel))
      return all[i] as ThinkingLevel
  return available[0] ?? 'off'
}
