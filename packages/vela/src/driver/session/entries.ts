import type { ModelMessage, UserContent } from '../../shared/messages.ts'
import type { CustomMessageInfo } from '../agent/events.ts'
import type { ExecutionLocation } from '../execution/types.ts'

/**
 * Session export format version (pi-compatible append-only branch log).
 */
export const SESSION_FORMAT_VERSION = 2

/** First line of an exported JSONL branch file. */
export interface SessionHeader {
  type: 'session'
  version: number
  id: string
  timestamp: string
  cwd?: string
  location?: ExecutionLocation
  channel?: string
  parentSession?: string
}

interface SessionEntryBase {
  type: string
  id: string
  parentId: string | null
  timestamp: string
  label?: string
}

/** A message in the conversation. */
export interface SessionMessageEntry extends SessionEntryBase {
  type: 'message'
  message: ModelMessage
  stopReason?: 'aborted' | 'error'
  details?: Record<string, unknown>
  producedBy?: string
}

/**
 * A command the user ran with `!` / `!!` (pi's `bashExecution` message).
 */
export interface BashExecutionEntry extends SessionEntryBase {
  type: 'bash_execution'
  command: string
  output: string
  exitCode?: number
  cancelled: boolean
  truncated: boolean
  fullOutputPath?: string
  excludeFromContext?: boolean
  backgroundTaskId?: string
}

/**
 * Earlier history was summarized (like pi). The model context becomes the summary followed by the
 * entries from `firstKeptEntryId` on; the summarized entries stay in the session.
 */
export interface CompactionEntry extends SessionEntryBase {
  type: 'compaction'
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
}

/**
 * Summary of a branch the session left through `navigateTree(…, { summarize: true })` (like pi).
 */
export interface BranchSummaryEntry extends SessionEntryBase {
  type: 'branch_summary'
  fromId: string
  summary: string
}

/** Extension state saved with `session.appendEntry()` (pi's `custom` entry); never sent to the model. */
export interface CustomEntry extends SessionEntryBase {
  type: 'custom'
  customType: string
  data?: unknown
}

/**
 * A message an extension sent with `session.sendMessage()` (pi's `custom_message` entry).
 */
export interface CustomMessageEntry extends SessionEntryBase {
  type: 'custom_message'
  customType: string
  content: UserContent
  display: boolean
  details?: unknown
}

/** Entries stored in `vela_messages`. */
export type SessionEntry =
  | SessionMessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | BashExecutionEntry

export type NewEntry<T> = T extends SessionEntry
  ? Omit<T, 'id' | 'parentId' | 'timestamp'>
  : never

export type SessionFileEntry = SessionHeader | SessionEntry

/** Text of the user message that stands for a summary in the model context. */
/** @experimental Shared frontend contract. */
export function summaryMessageText(summary: string): string {
  return `[Summary of the earlier conversation]\n${summary}`
}

/** Text of the user message that stands for a branch summary in the model context. */
/** @experimental Shared frontend contract. */
export function branchSummaryMessageText(summary: string): string {
  return `[Summary of the conversation branch you left]\n${summary}`
}

/** What the model sees of a `!` command (pi's `bashExecutionToText`). */
export function bashExecutionToText(
  entry: Pick<
    BashExecutionEntry,
    | 'command'
    | 'output'
    | 'exitCode'
    | 'cancelled'
    | 'truncated'
    | 'fullOutputPath'
    | 'backgroundTaskId'
  >,
): string {
  let text = `Ran \`${entry.command}\`\n`
  text += entry.output ? `\`\`\`\n${entry.output}\n\`\`\`` : '(no output)'
  if (entry.cancelled) text += '\n\n(command cancelled)'
  else if (entry.backgroundTaskId)
    text += `\n\nCommand moved to the background with ID ${entry.backgroundTaskId}; its result will be reported when it exits.`
  else if (entry.exitCode !== undefined && entry.exitCode !== 0)
    text += `\n\nCommand exited with code ${entry.exitCode}`
  if (entry.truncated && entry.fullOutputPath)
    text += `\n\n[Output truncated. Full output: ${entry.fullOutputPath}]`
  return text
}

/** A unique short entry id (like pi's generateId: 8 hex characters, collision-checked). */
export function createEntryId(taken: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const id = crypto.randomUUID().slice(0, 8)
    if (!taken.has(id)) return id
  }
  return crypto.randomUUID()
}

/** What `buildSessionContext()` rebuilds from the entries. */
export interface SessionContext {
  messages: ModelMessage[]
  ids: Map<ModelMessage, string>
  timestamps: Map<ModelMessage, number>
  producers: Map<ModelMessage, string>
  custom: Map<ModelMessage, CustomMessageInfo>
  summary: string
}

function parseTime(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

/**
 * The entries from the root to `leafId` (like pi's `buildSessionPath`).
 */
/** @experimental Shared frontend contract. */
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
 * The entries of a branch (root first) the context is built from.
 */
/** @experimental Shared frontend contract. */
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

/** Convert a slice of session entries (e.g. an abandoned branch) into model messages, respecting internal compactions. */
export function entriesToMessages(
  entries: readonly SessionEntry[],
): ModelMessage[] {
  let effectiveEntries: readonly SessionEntry[] = entries
  let compactionIndex = -1
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]?.type === 'compaction') compactionIndex = i
  }
  if (compactionIndex >= 0) {
    const compaction = entries[compactionIndex] as CompactionEntry
    const firstKept =
      compaction.firstKeptEntryId === compaction.id
        ? compactionIndex
        : entries.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
    if (firstKept >= 0 && firstKept <= compactionIndex) {
      effectiveEntries = [
        compaction,
        ...entries
          .slice(firstKept, compactionIndex)
          .filter((entry) => entry.type !== 'compaction'),
        ...entries
          .slice(compactionIndex + 1)
          .filter((entry) => entry.type !== 'compaction'),
      ]
    }
  }
  const messages: ModelMessage[] = []
  for (const entry of effectiveEntries) {
    if (entry.type === 'branch_summary') {
      if (entry.summary)
        messages.push({
          role: 'user',
          content: branchSummaryMessageText(entry.summary),
        })
      continue
    }
    if (entry.type === 'compaction') {
      if (entry.summary)
        messages.push({
          role: 'user',
          content: summaryMessageText(entry.summary),
        })
      continue
    }
    if (entry.type === 'message') {
      if (entry.stopReason) continue
      messages.push(entry.message)
    } else if (entry.type === 'custom_message') {
      messages.push({ role: 'user', content: entry.content })
    } else if (entry.type === 'bash_execution' && !entry.excludeFromContext) {
      messages.push({ role: 'user', content: bashExecutionToText(entry) })
    }
  }
  return messages
}

/**
 * Rebuilds the model context of the branch ending at `leafId`.
 */
export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  byId?: Map<string, SessionEntry>,
): SessionContext {
  const path = buildSessionPath(entries, leafId, byId)
  const context: SessionContext = {
    messages: [],
    ids: new Map(),
    timestamps: new Map(),
    producers: new Map(),
    custom: new Map(),
    summary: '',
  }
  const push = (message: ModelMessage, entry: SessionEntry) => {
    context.messages.push(message)
    context.ids.set(message, entry.id)
    context.timestamps.set(message, parseTime(entry.timestamp))
    if (entry.type === 'message' && entry.producedBy)
      context.producers.set(message, entry.producedBy)
  }
  const { compaction, entries: selected } = contextEntries(path)
  if (compaction) {
    context.summary = compaction.summary
    push(
      { role: 'user', content: summaryMessageText(compaction.summary) },
      compaction,
    )
  }
  for (const entry of selected) {
    if (entry.type === 'branch_summary') {
      if (entry.summary)
        push(
          { role: 'user', content: branchSummaryMessageText(entry.summary) },
          entry,
        )
      continue
    }
    let message: ModelMessage
    if (entry.type === 'message') {
      if (entry.stopReason) continue
      message = entry.message
    } else if (entry.type === 'custom_message')
      message = { role: 'user', content: entry.content }
    else if (entry.type === 'bash_execution' && !entry.excludeFromContext)
      message = { role: 'user', content: bashExecutionToText(entry) }
    else continue
    if (entry.type === 'custom_message')
      context.custom.set(message, {
        customType: entry.customType,
        display: entry.display,
        ...(entry.details === undefined ? {} : { details: entry.details }),
      })
    push(message, entry)
  }
  return context
}

/** A node of `getTree()` (like pi's `SessionTreeNode`). */
export interface SessionTreeNode {
  entry: SessionEntry
  children: SessionTreeNode[]
  label?: string
}

/**
 * The entries as a tree (like pi's `getTree`).
 */
export function buildSessionTree(entries: SessionEntry[]): SessionTreeNode[] {
  const nodes = new Map<string, SessionTreeNode>()
  for (const entry of entries) {
    nodes.set(entry.id, {
      entry,
      children: [],
      ...(entry.label ? { label: entry.label } : {}),
    })
  }
  const roots: SessionTreeNode[] = []
  for (const entry of entries) {
    const node = nodes.get(entry.id) as SessionTreeNode
    const parent =
      entry.parentId === null || entry.parentId === entry.id
        ? undefined
        : nodes.get(entry.parentId)
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

/**
 * Copies a branch for a new session (re-chaining `parentId`, preserving `label` and `firstKeptEntryId`).
 */
export function copyBranch(path: SessionEntry[]): SessionEntry[] {
  const copied: SessionEntry[] = []
  let parentId: string | null = null
  for (const entry of path) {
    copied.push({ ...entry, parentId })
    parentId = entry.id
  }
  return copied
}

/** Text of a message's content (text parts only). */
/** @experimental Shared frontend contract. */
export function messageText(content: ModelMessage['content']): string {
  return typeof content === 'string'
    ? content
    : content
        .map((part) =>
          part.type === 'text' && 'text' in part ? String(part.text) : '',
        )
        .join('')
}

/** One entry returned by `vela.listSessions()`. */
export interface SessionSummary {
  id: string
  name?: string
  updatedAt: string
  messageCount: number
  firstMessage: string
  cwd?: string
  channel?: string
  archived?: boolean
}

/** A custom message's or entry's type must be a non-empty string. */
export function assertCustomType(customType: unknown): void {
  if (typeof customType !== 'string' || !customType.trim())
    throw new Error('customType must be a non-empty string')
}
