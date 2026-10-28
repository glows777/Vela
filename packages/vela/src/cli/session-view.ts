import type {
  CompactionEntry,
  ModelMessage,
  SessionEntry,
} from '@glows777/vela-core'

export function summaryMessageText(summary: string): string {
  return `[Summary of the earlier conversation]\n${summary}`
}

/** Text of the user message that stands for a branch summary in the model context. */
export function branchSummaryMessageText(summary: string): string {
  return `[Summary of the conversation branch you left]\n${summary}`
}

export function buildSessionPath(
  entries: SessionEntry[],
  leafId?: string | null,
  byId?: Map<string, SessionEntry>,
): SessionEntry[] {
  if (leafId === null) return []
  const index = byId ?? new Map(entries.map((entry) => [entry.id, entry]))
  let current = leafId === undefined ? entries.at(-1) : index.get(leafId)
  if (leafId !== undefined && !current)
    throw new Error(`Entry ${leafId} is not in the session`)
  const path: SessionEntry[] = []
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.push(current)
    current =
      current.parentId === null ? undefined : index.get(current.parentId)
  }
  return path.reverse()
}

/**
 * The entries of a branch (root first) the context is built from (like the path pi's `buildSessionContext`
 * walks): with a compaction, the branch's latest one and the entries it keeps plus everything after it;
 * otherwise the whole branch. The TUI renders a resumed session from these.
 */
export function contextEntries(path: SessionEntry[]): {
  compaction?: CompactionEntry
  entries: SessionEntry[]
} {
  let compactionIndex = -1
  path.forEach((entry, index) => {
    if (entry.type === 'compaction') compactionIndex = index
  })
  if (compactionIndex < 0) return { entries: path }
  const compaction = path[compactionIndex] as CompactionEntry
  const firstKept =
    compaction.firstKeptEntryId === compaction.id
      ? compactionIndex
      : path.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
  if (firstKept < 0 || firstKept > compactionIndex)
    throw new Error(
      `Compaction entry ${compaction.id} keeps entry ${compaction.firstKeptEntryId}, which is not before it in the session`,
    )
  return {
    compaction,
    entries: [
      ...path.slice(firstKept, compactionIndex),
      ...path.slice(compactionIndex + 1),
    ],
  }
}

export function messageText(content: ModelMessage['content']): string {
  return typeof content === 'string'
    ? content
    : content.map((part) => ('text' in part ? String(part.text) : '')).join('')
}

export function isSessionV1(lines: unknown[]): boolean {
  const first = lines[0] as { type?: unknown; id?: unknown } | undefined
  return (
    first?.type === 'checkpoint' ||
    (first?.type === 'message' && first.id === undefined)
  )
}

export type {
  SessionEntry,
  SessionHeader,
  SessionTreeNode,
} from '@glows777/vela-core'
export { migrateSessionV1 } from '@glows777/vela-core'
