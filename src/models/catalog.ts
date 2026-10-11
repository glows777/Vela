import { MODEL_CATALOG } from './catalog.generated.ts'
import type { ModelSpec, ThinkingLevel } from './index.ts'

/** One model of the built-in catalog (pi's model metadata, see scripts/update-models.ts). */
export interface CatalogModel extends ModelSpec {
  /** Wire protocol: `anthropic-messages`, `openai-responses` or `openai-completions` */
  api: string
}

export { MODEL_CATALOG }

/** Catalog models of one provider (empty for providers the catalog doesn't know). */
export function catalogModels(provider: string): CatalogModel[] {
  return MODEL_CATALOG[provider] ?? []
}

/**
 * Catalog metadata for a model: the same provider and id first, then the same id under any catalog provider
 * (so a models.json provider serving a well-known model still gets its context window and price).
 */
export function catalogLookup(
  provider: string,
  id: string,
): CatalogModel | undefined {
  const own = MODEL_CATALOG[provider]?.find((m) => m.id === id)
  if (own) return own
  for (const models of Object.values(MODEL_CATALOG)) {
    const found = models.find((m) => m.id === id)
    if (found) return found
  }
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
