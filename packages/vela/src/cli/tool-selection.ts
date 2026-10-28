import { isToolModifier } from '@glows777/vela-core/diagnostics'
export interface ToolLoadout {
  selection?: string[]
  modifiers?: string[]
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
