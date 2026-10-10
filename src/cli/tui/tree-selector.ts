import type { SelectItem } from '@earendil-works/pi-tui'
import {
  messageText,
  type SessionEntry,
  type SessionTreeNode,
} from '../../session/entries.ts'
import { sanitize } from './components.ts'

/** One line of the entry, or undefined for entries the tree doesn't show (tool results, labels, settings). */
function describe(entry: SessionEntry): string | undefined {
  switch (entry.type) {
    case 'message': {
      const { message } = entry
      if (message.role === 'user')
        return `user: ${messageText(message.content)}`
      if (message.role !== 'assistant') return
      const text = messageText(message.content).trim()
      const calls =
        typeof message.content === 'string'
          ? []
          : message.content
              .filter((part) => part.type === 'tool-call')
              .map((part) => part.toolName)
      const body = text || (calls.length ? `[${calls.join(', ')}]` : '')
      return `assistant: ${body}${entry.stopReason ? ` (${entry.stopReason})` : ''}`
    }
    case 'compaction':
      return '[summary of earlier messages]'
    case 'branch_summary':
      return '[summary of a branch that was left]'
    default:
      return
  }
}

/**
 * The session tree as select items (a compact take on pi's tree selector): shown entries in tree order,
 * indented only where the conversation branches, with labels, the current branch marked `•` and the
 * leaf marked `← current`.
 */
export function treeItems(
  roots: SessionTreeNode[],
  branchIds: ReadonlySet<string>,
  leafId: string | null,
): SelectItem[] {
  const items: SelectItem[] = []
  // Iterative depth-first walk: long sessions are deep chains
  const stack: { node: SessionTreeNode; depth: number }[] = roots
    .map((node) => ({ node, depth: roots.length > 1 ? 1 : 0 }))
    .reverse()
  while (stack.length) {
    const { node, depth } = stack.pop() as (typeof stack)[number]
    const line = describe(node.entry)
    if (line !== undefined) {
      const onBranch = branchIds.has(node.entry.id)
      const text = sanitize(line).replace(/\s+/g, ' ').trim().slice(0, 100)
      items.push({
        value: node.entry.id,
        label: `${'  '.repeat(depth)}${onBranch ? '• ' : '  '}${node.label ? `[${sanitize(node.label)}] ` : ''}${text}`,
        ...(node.entry.id === leafId ? { description: '← current' } : {}),
      })
    }
    const childDepth = node.children.length > 1 ? depth + 1 : depth
    for (let i = node.children.length - 1; i >= 0; i--)
      stack.push({
        node: node.children[i] as SessionTreeNode,
        depth: childDepth,
      })
  }
  return items
}

/** The deepest shown entry at or above `id`, so the selector can start on the current position. */
export function nearestShown(
  branch: SessionEntry[],
  items: SelectItem[],
): string | undefined {
  const shown = new Set(items.map((item) => item.value))
  for (let i = branch.length - 1; i >= 0; i--) {
    const id = (branch[i] as SessionEntry).id
    if (shown.has(id)) return id
  }
}
