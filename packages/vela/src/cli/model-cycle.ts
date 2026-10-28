import type { ModelInfo } from '@glows777/vela-core'

const toRegExp = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i',
  )

/**
 * The models Ctrl+P cycles through (pi's scoped models): those matching settings `enabledModels`, in pattern order.
 * A pattern with `/` matches `provider/id`, one without matches the id under any provider; `*` matches anything.
 * Without patterns, or when none match, all available models.
 */
export function scopedModels(
  models: readonly ModelInfo[],
  patterns: readonly string[] | undefined,
): ModelInfo[] {
  if (!patterns?.length) return [...models]
  const scoped: ModelInfo[] = []
  for (const pattern of patterns) {
    const regexp = toRegExp(pattern)
    for (const model of models)
      if (
        regexp.test(pattern.includes('/') ? model.ref : model.id) &&
        !scoped.includes(model)
      )
        scoped.push(model)
  }
  return scoped.length ? scoped : [...models]
}

/** The model after (or before) `current` in `models`, wrapping around; undefined with fewer than two models */
export function nextModel(
  models: readonly ModelInfo[],
  current: string | undefined,
  direction: 1 | -1 = 1,
): ModelInfo | undefined {
  if (models.length < 2) return
  const index = models.findIndex((m) => m.ref === current)
  const from = index === -1 ? (direction === 1 ? -1 : 0) : index
  return models[(from + direction + models.length) % models.length]
}
