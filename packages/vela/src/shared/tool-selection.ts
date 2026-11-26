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

const RETIRED_CORE_TOOLS = new Map<string, string>([
  ['read_file', 'read'],
  ['write_file', 'write'],
  ['edit_file', 'edit'],
  ['list_directory', 'ls'],
])

/**
 * Error message if an explicit tool list or selection contains a retired v0.8 core tool name,
 * or undefined when clean.
 */
export function getRetiredToolError(
  entries: readonly string[],
): string | undefined {
  for (const entry of entries) {
    const bare = isToolModifier(entry) ? entry.slice(1) : entry
    const replacement = RETIRED_CORE_TOOLS.get(bare)
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

export interface ToolLoadout {
  selection?: string[]
  modifiers?: string[]
}

export interface SelectToolsArgs {
  tools?: readonly string[]
  noTools?: boolean
  excludeTools?: readonly string[]
}

function toolMatcher(entry: string): (name: string) => boolean {
  if (!entry.includes('*')) return (name) => name === entry
  const pattern = new RegExp(
    `^${entry
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  )
  return (name) => pattern.test(name)
}

/**
 * The tools a session starts with, from `--tools / --no-tools / --exclude-tools` and the
 * `defaultTools` setting (like pi), or undefined for the default set. Plain entries are names or
 * `*` patterns and replace the setting; `+name` / `-name` entries adjust the default set instead.
 * One entry that matches no registered tool is an error.
 */
export function selectTools(
  available: readonly string[],
  args: SelectToolsArgs,
  defaultTools?: readonly string[],
): ToolLoadout | undefined {
  const entries = [...(args.tools ?? [])]
  const excludedEntries = [...(args.excludeTools ?? [])]
  const listError = getToolListError(entries)
  if (listError) throw new Error(`Invalid --tools list: ${listError}`)
  const plain = entries.filter((entry) => !isToolModifier(entry))
  const modifiers = entries.filter(isToolModifier)
  const requested =
    plain.length > 0
      ? [...plain, ...excludedEntries]
      : [...[...(defaultTools ?? []), ...entries], ...excludedEntries].map(
          (entry) => (isToolModifier(entry) ? entry.slice(1) : entry),
        )
  const unknown = requested.filter(
    (entry) => !available.some(toolMatcher(entry)),
  )
  if (unknown.length)
    throw new Error(
      `Unknown tool${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Available: ${available.join(', ')}`,
    )
  const matches = (names: readonly string[]) => (name: string) =>
    names.some((entry) => toolMatcher(entry)(name))
  const settingsPlain = defaultTools?.filter((entry) => !isToolModifier(entry))
  const settingsSelection =
    settingsPlain && (settingsPlain.length > 0 || defaultTools?.length === 0)
      ? applyToolModifiers(
          available.filter(matches(settingsPlain)),
          (defaultTools ?? []).filter(isToolModifier),
        )
      : undefined
  let selection: string[] | undefined
  let adjusted = modifiers
  if (modifiers.length > 0) {
    if (args.noTools) selection = applyToolModifiers([], modifiers)
    else if (settingsSelection)
      selection = applyToolModifiers(settingsSelection, modifiers)
    else adjusted = [...(defaultTools ?? []), ...modifiers]
  } else if (plain.length > 0) {
    selection = available.filter(matches(plain))
  } else if (args.noTools) {
    selection = []
  } else if (settingsSelection) {
    selection = settingsSelection
  } else if (defaultTools?.length) {
    adjusted = defaultTools.filter(isToolModifier)
  }
  const excluded = available.filter(matches(excludedEntries))
  if (selection)
    selection = selection.filter((name) => !excluded.includes(name))
  else adjusted = [...adjusted, ...excluded.map((name) => `-${name}`)]
  if (selection) return { selection }
  return adjusted.length > 0 ? { modifiers: adjusted } : undefined
}

function applyToolModifiers(
  base: readonly string[],
  modifiers: readonly string[],
): string[] {
  const result = new Set(base)
  for (const entry of modifiers) {
    const name = entry.slice(1)
    if (entry.startsWith('+')) result.add(name)
    else if (entry.startsWith('-')) result.delete(name)
  }
  return [...result]
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
