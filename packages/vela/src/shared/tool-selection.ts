/**
 * Tool list syntax shared by `--tools`, the SDK `tools` option and the `tools` setting
 * (like pi): plain names and `*` patterns name tools, `+name` / `-name` entries adjust the
 * default set instead of replacing it.
 */

/** Whether an entry adjusts the default tool set (`+name` adds, `-name` removes) instead of naming a tool. */
/** @experimental Shared frontend contract. */
export function isToolModifier(entry: string): boolean {
  return entry.startsWith('+') || entry.startsWith('-')
}

const RETIRED_CORE_TOOLS: Record<string, string> = {
  read_file: 'read',
  write_file: 'write',
  edit_file: 'edit',
  list_directory: 'ls',
}

/**
 * Error message if an explicit tool list or selection contains a retired v0.8 core tool name,
 * or undefined when clean.
 */
export function getRetiredToolError(
  entries: readonly string[],
): string | undefined {
  for (const entry of entries) {
    const bare = isToolModifier(entry) ? entry.slice(1) : entry
    const replacement = RETIRED_CORE_TOOLS[bare]
    if (replacement)
      return `tool "${bare}" was renamed to "${replacement}" (see docs/upgrading.md)`
  }
  return undefined
}

/**
 * Why a `--tools` / `tools` list is invalid, or undefined when it is. Like pi, a list of
 * `+name` / `-name` entries takes exact names and cannot be mixed with plain names.
 */
/** @experimental Shared frontend contract. */
export function getToolListError(
  entries: readonly string[],
): string | undefined {
  const retired = getRetiredToolError(entries)
  if (retired) return retired
  const modifiers = entries.filter(isToolModifier)
  if (modifiers.length === 0) return undefined
  if (modifiers.length < entries.length)
    return 'tool names cannot be mixed with +name or -name entries'
  const pattern = modifiers.find((entry) => entry.includes('*'))
  return pattern
    ? `+name and -name entries take exact tool names, not patterns: ${pattern}`
    : undefined
}

/**
 * Project `tools` on top of the user list: a list with plain names replaces it, while
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
