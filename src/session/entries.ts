import type { ModelMessage, UserContent } from 'ai'
import type { CustomMessageInfo } from '../agent/events.ts'
import type { ThinkingLevel } from '../models/index.ts'

/**
 * Session file format version written now (like pi's CURRENT_SESSION_VERSION). Version 1 was one
 * checkpoint per file; version 2 is pi's append-only entry log. Older versions are migrated on load.
 */
export const SESSION_FORMAT_VERSION = 2

/** First line of a session file (like pi's `SessionHeader`). */
export interface SessionHeader {
  type: 'session'
  version: number
  /** Session id (also the file name) */
  id: string
  /** When the session was created (ISO) */
  timestamp: string
  /** Working directory the session started in */
  cwd?: string
  /** @internal Tool call history the session's tool results belong to */
  toolHistoryId?: string
}

/** Fields every entry has (like pi): entries form a tree through `parentId`; Vela writes a single branch for now. */
export interface SessionEntryBase {
  type: string
  /** 8 hex characters, unique within the session */
  id: string
  /** The entry this one follows; null for the first entry */
  parentId: string | null
  /** When the entry was appended (ISO) */
  timestamp: string
}

/** A tool call another tool made through `ctx.executeTool()` (pi's `NestedToolCallRecord`). */
export interface NestedToolCallRecord {
  id: string
  name: string
  /** Omitted when over the size limits; `argumentsBytes` then gives their size */
  arguments?: unknown
  /** UTF-8 size of the arguments as JSON, set when `arguments` is omitted */
  argumentsBytes?: number
  /** `unfinished`: the call was still running when the calling tool finished */
  status: 'ok' | 'error' | 'unfinished'
  durationMs?: number
  /** Error text, truncated */
  error?: string
}

/** Bounded record of the nested calls one tool call made (pi's `NestedToolCalls`). Results are not recorded. */
export interface NestedToolCalls {
  calls: NestedToolCallRecord[]
  /** False when calls were dropped, arguments omitted, or calls had not finished */
  complete: boolean
}

/** A message in the conversation. */
export interface SessionMessageEntry extends SessionEntryBase {
  type: 'message'
  message: ModelMessage
  /**
   * Set on an assistant message that was aborted or failed while it streamed (pi keeps this on the message).
   * Such a message is kept for the record but never sent to the model again.
   */
  stopReason?: 'aborted' | 'error'
  /** On a tool message: calls each of its tools made through `ctx.executeTool()`, by tool call id. Not sent to the model. */
  nestedCalls?: Record<string, NestedToolCalls>
}

/** The session's model changed (`session.setModel()` with a name). */
export interface ModelChangeEntry extends SessionEntryBase {
  type: 'model_change'
  /** `provider/id` */
  model: string
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: 'thinking_level_change'
  thinkingLevel: ThinkingLevel
}

/** Session metadata (`session.setName()`); an empty name clears it. */
export interface SessionInfoEntry extends SessionEntryBase {
  type: 'session_info'
  name?: string
}

/**
 * Earlier history was summarized (like pi). The model context becomes the summary followed by the
 * entries from `firstKeptEntryId` on; the summarized entries stay in the file.
 */
export interface CompactionEntry extends SessionEntryBase {
  type: 'compaction'
  summary: string
  firstKeptEntryId: string
  /** Estimated context tokens before the summary */
  tokensBefore: number
  /** @internal Tool call history snapshot the summary's reading guide points at */
  toolHistoryViewSeq?: number
}

/**
 * Append-only change to an earlier message's contribution to the model context (pi's `context_edit`).
 * Vela writes it when old tool output is folded into file references; the original stays in its entry.
 */
export interface ContextEditEntry extends SessionEntryBase {
  type: 'context_edit'
  targetId: string
  /** Null leaves the target out of the context; otherwise its content is replaced */
  replacement: { content: ModelMessage['content'] } | null
}

/** Extension state saved with `session.appendEntry()` (pi's `custom` entry); never sent to the model. */
export interface CustomEntry extends SessionEntryBase {
  type: 'custom'
  customType: string
  data?: unknown
}

/**
 * A message an extension sent with `session.sendMessage()` (pi's `custom_message` entry). The model context
 * gets it as a user message with `content`; `display` and `details` are for UIs and the extension.
 */
export interface CustomMessageEntry extends SessionEntryBase {
  type: 'custom_message'
  customType: string
  content: UserContent
  display: boolean
  details?: unknown
}

/** Entries Vela writes. Readers keep entries of other types (written by newer versions or extensions) and ignore them. */
export type SessionEntry =
  | SessionMessageEntry
  | ModelChangeEntry
  | ThinkingLevelChangeEntry
  | SessionInfoEntry
  | CompactionEntry
  | ContextEditEntry
  | CustomEntry
  | CustomMessageEntry

/** An entry before it gets its place in the log (`id`, `parentId`, `timestamp`); keeps each type's own fields. */
export type NewEntry<T> = T extends SessionEntry
  ? Omit<T, 'id' | 'parentId' | 'timestamp'>
  : never

/** One line of a session file. */
export type SessionFileEntry = SessionHeader | SessionEntry

/** Text of the user message that stands for a summary in the model context. */
export function summaryMessageText(summary: string): string {
  return `[Summary of the earlier conversation]\n${summary}`
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
  /** The model context */
  messages: ModelMessage[]
  /** Entry id of each context message (the summary message maps to its compaction entry) */
  ids: Map<ModelMessage, string>
  /** When each context message entered the history */
  timestamps: Map<ModelMessage, number>
  /** Context messages that are extensions' custom messages (from `custom_message` entries) */
  custom: Map<ModelMessage, CustomMessageInfo>
  /** Latest `model_change` */
  model?: string
  /** Latest `thinking_level_change` */
  thinkingLevel?: ThinkingLevel
  /** Latest `session_info` name */
  name?: string
  /** Latest compaction summary ('' if never compacted) */
  summary: string
  toolHistoryViewSeq?: number
}

function parseTime(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

/**
 * Rebuilds the model context and settings from a session's entries (like pi's `buildSessionContext`):
 * the latest compaction's summary, then the kept and later messages, with context edits applied.
 * Aborted / failed assistant messages are left out (like pi's transform-messages).
 */
export function buildSessionContext(entries: SessionEntry[]): SessionContext {
  const context: SessionContext = {
    messages: [],
    ids: new Map(),
    timestamps: new Map(),
    custom: new Map(),
    summary: '',
  }
  let compactionIndex = -1
  entries.forEach((entry, index) => {
    if (entry.type === 'model_change') context.model = entry.model
    else if (entry.type === 'thinking_level_change')
      context.thinkingLevel = entry.thinkingLevel
    else if (entry.type === 'session_info')
      context.name = entry.name?.trim() || undefined
    else if (entry.type === 'compaction') compactionIndex = index
  })
  let selected: SessionEntry[] = entries
  if (compactionIndex >= 0) {
    const compaction = entries[compactionIndex] as CompactionEntry
    context.summary = compaction.summary
    context.toolHistoryViewSeq = compaction.toolHistoryViewSeq
    const firstKept = entries.findIndex(
      (entry) => entry.id === compaction.firstKeptEntryId,
    )
    if (firstKept < 0 || firstKept > compactionIndex)
      throw new Error(
        `Compaction entry ${compaction.id} keeps entry ${compaction.firstKeptEntryId}, which is not before it in the session`,
      )
    const summary: ModelMessage = {
      role: 'user',
      content: summaryMessageText(compaction.summary),
    }
    context.messages.push(summary)
    context.ids.set(summary, compaction.id)
    context.timestamps.set(summary, parseTime(compaction.timestamp))
    selected = [
      ...entries.slice(firstKept, compactionIndex),
      ...entries.slice(compactionIndex + 1),
    ]
  }
  const edits = new Map<string, ContextEditEntry>()
  for (const entry of selected)
    if (entry.type === 'context_edit') edits.set(entry.targetId, entry)
  for (const entry of selected) {
    let original: ModelMessage
    if (entry.type === 'message') {
      if (entry.stopReason) continue
      original = entry.message
    } else if (entry.type === 'custom_message')
      // Like pi's convertToLlm: the model sees a custom message as a user message
      original = { role: 'user', content: entry.content }
    else continue
    const edit = edits.get(entry.id)
    if (edit?.replacement === null) continue
    const message = edit
      ? ({
          ...original,
          content: edit.replacement.content,
        } as ModelMessage)
      : original
    if (entry.type === 'custom_message')
      context.custom.set(message, {
        customType: entry.customType,
        display: entry.display,
        ...(entry.details === undefined ? {} : { details: entry.details }),
      })
    context.messages.push(message)
    context.ids.set(message, entry.id)
    context.timestamps.set(message, parseTime(entry.timestamp))
  }
  return context
}

/** One `SessionStorage.list()` entry, used by the session picker and `vela.listSessions()`. */
export interface SessionSummary {
  id: string
  name?: string
  /** Time of the last entry (ISO) */
  updatedAt: string
  /** Messages in the session file (including summarized ones) */
  messageCount: number
  /** Start of the first user message (empty string if none) */
  firstMessage: string
}

/** Builds a list entry from a session's entries (for custom storages implementing `list`). */
export function summarizeSession(
  id: string,
  entries: SessionFileEntry[],
): SessionSummary {
  let name: string | undefined
  let updatedAt = ''
  let messageCount = 0
  let firstMessage = ''
  for (const entry of entries) {
    if (entry.timestamp > updatedAt) updatedAt = entry.timestamp
    if (entry.type === 'session_info') name = entry.name?.trim() || undefined
    if (entry.type !== 'message') continue
    messageCount++
    if (firstMessage || entry.message.role !== 'user') continue
    const content = entry.message.content
    firstMessage = (
      typeof content === 'string'
        ? content
        : content
            .map((part) => ('text' in part ? String(part.text) : ''))
            .join('')
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
  }
  return {
    id,
    ...(name ? { name } : {}),
    updatedAt,
    messageCount,
    firstMessage,
  }
}

/** Version-1 checkpoint line (`{ type: 'checkpoint', messages, … }`). */
interface CheckpointV1 {
  type: 'checkpoint'
  timestamp?: string
  messages: { timestamp: string; message: ModelMessage }[]
  model?: string
  thinkingLevel?: ThinkingLevel
  name?: string
  summary?: string
  toolHistoryId?: string
  toolHistoryViewSeq?: number
}

/**
 * Whether parsed lines are a version-1 file: a checkpoint, or the older one-message-per-line form
 * (message lines without entry ids). Anything else without a header (say a version-2 file whose header
 * line is damaged) is not converted, so it is never rewritten with less than it holds.
 */
export function isSessionV1(lines: unknown[]): boolean {
  const first = lines[0] as { type?: unknown; id?: unknown } | undefined
  return (
    first?.type === 'checkpoint' ||
    (first?.type === 'message' && first.id === undefined)
  )
}

/**
 * Converts the parsed lines of a version-1 session file to version 2 (for custom storages holding old data):
 * the latest checkpoint's messages plus message lines after it become `message` entries, and the
 * checkpoint's model, thinking level and name become entries. A compacted checkpoint (its first
 * message is the summary) becomes the kept messages followed by a `compaction` entry, which rebuilds
 * the same context.
 */
export function migrateSessionV1(
  id: string,
  lines: unknown[],
): SessionFileEntry[] {
  let checkpoint: CheckpointV1 = { type: 'checkpoint', messages: [] }
  for (const line of lines) {
    const entry = line as {
      type?: string
      timestamp?: string
      message?: ModelMessage
      messages?: unknown
    }
    if (entry.type === 'checkpoint' && Array.isArray(entry.messages))
      checkpoint = {
        ...(entry as CheckpointV1),
        messages: [...(entry as CheckpointV1).messages],
      }
    else if (entry.type === 'message' && entry.message)
      checkpoint.messages.push({
        timestamp: entry.timestamp ?? new Date().toISOString(),
        message: entry.message,
      })
  }
  const time =
    checkpoint.timestamp ??
    checkpoint.messages[0]?.timestamp ??
    new Date().toISOString()
  const header: SessionHeader = {
    type: 'session',
    version: SESSION_FORMAT_VERSION,
    id,
    timestamp: checkpoint.messages[0]?.timestamp ?? time,
    ...(checkpoint.toolHistoryId
      ? { toolHistoryId: checkpoint.toolHistoryId }
      : {}),
  }
  const entries: SessionEntry[] = []
  const ids = new Set<string>()
  const push = (entry: NewEntry<SessionEntry> & { timestamp: string }) => {
    const id = createEntryId(ids)
    ids.add(id)
    entries.push({
      ...entry,
      id,
      parentId: entries.at(-1)?.id ?? null,
    } as SessionEntry)
  }
  const first = checkpoint.messages[0]?.timestamp ?? time
  if (checkpoint.model)
    push({ type: 'model_change', timestamp: first, model: checkpoint.model })
  if (checkpoint.thinkingLevel)
    push({
      type: 'thinking_level_change',
      timestamp: first,
      thinkingLevel: checkpoint.thinkingLevel,
    })
  const summary = checkpoint.summary
  const compacted =
    !!summary &&
    checkpoint.messages[0]?.message.content === summaryMessageText(summary)
  for (const stored of checkpoint.messages.slice(compacted ? 1 : 0))
    push({
      type: 'message',
      timestamp: stored.timestamp,
      message: stored.message,
    })
  if (compacted) {
    const firstKept = entries.find((entry) => entry.type === 'message')
    push({
      type: 'compaction',
      timestamp: checkpoint.messages[0]?.timestamp ?? time,
      summary,
      firstKeptEntryId: firstKept?.id ?? '',
      tokensBefore: 0,
      ...(checkpoint.toolHistoryViewSeq === undefined
        ? {}
        : { toolHistoryViewSeq: checkpoint.toolHistoryViewSeq }),
    })
    // Kept nothing: the compaction keeps itself (like pi's `firstKeptEntryId ?? id`)
    const compaction = entries.at(-1) as CompactionEntry
    if (!compaction.firstKeptEntryId)
      compaction.firstKeptEntryId = compaction.id
  }
  if (checkpoint.name)
    push({ type: 'session_info', timestamp: time, name: checkpoint.name })
  return [header, ...entries]
}
