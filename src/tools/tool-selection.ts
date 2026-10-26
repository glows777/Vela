/**
 * Tool list syntax shared by `--tools`, the SDK `tools` option and the `defaultTools` setting
 * (like pi): plain names and `*` patterns name tools, `+name` / `-name` entries adjust the
 * default set instead of replacing it.
 */

/** The tools a session starts with: an exact selection, or `+name` / `-name` changes to the default set. */
export interface ToolLoadout {
  selection?: string[]
  modifiers?: string[]
}

/** Whether an entry adjusts the default tool set (`+name` adds, `-name` removes) instead of naming a tool. */
export function isToolModifier(entry: string): boolean {
  return entry.startsWith('+') || entry.startsWith('-')
}

/**
 * Why a `--tools` / `tools` list is invalid, or undefined when it is. Like pi, a list of
 * `+name` / `-name` entries takes exact names and cannot be mixed with plain names.
 */
export function getToolListError(
  entries: readonly string[],
): string | undefined {
  const modifiers = entries.filter(isToolModifier)
  if (modifiers.length === 0) return undefined
  if (modifiers.length < entries.length)
    return 'tool names cannot be mixed with +name or -name entries'
  const pattern = modifiers.find((entry) => entry.includes('*'))
  return pattern
    ? `+name and -name entries take exact tool names, not patterns: ${pattern}`
    : undefined
}

/** Applies the `+name` / `-name` entries of `entries` to `base`, in order. */
export function applyToolModifiers(
  base: readonly string[],
  entries: readonly string[],
): string[] {
  const tools = [...base]
  for (const entry of entries) {
    if (!isToolModifier(entry)) continue
    const name = entry.slice(1)
    const index = tools.indexOf(name)
    if (entry.startsWith('+') && index === -1 && name) tools.push(name)
    else if (entry.startsWith('-') && index !== -1) tools.splice(index, 1)
  }
  return tools
}

/**
 * Project `defaultTools` on top of the user list: a list with plain names replaces it, while
 * `+name` / `-name` entries append and adjust it. An empty list replaces it too, so a project can
 * turn every default tool off (pi appends an empty list, which leaves the user's tools on).
 */
export function mergeDefaultTools(
  base: string[] | undefined,
  override: string[] | undefined,
): string[] | undefined {
  if (override === undefined) return base
  if (!base || override.length === 0 || !override.every(isToolModifier))
    return override
  return [...base, ...override]
}
