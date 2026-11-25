import type { VelaDatabase } from '../../db/index.ts'
import type { ThinkingLevel } from '../../providers/models/index.ts'
import type { ExecutionLocation } from '../execution/types.ts'
import type { ModelMessage } from '../messages.ts'
import type { StepRecord } from '../usage/tracker.ts'
import {
  type BashExecutionEntry,
  type BranchSummaryEntry,
  type CompactionEntry,
  type CustomEntry,
  type CustomMessageEntry,
  messageText,
  type SessionEntry,
  type SessionMessageEntry,
  type SessionSummary,
} from './entries.ts'
import type { LoadedSessionContext } from './options.ts'
import { type SessionSearchHit, searchSessionText } from './search.ts'

export type SessionRow = {
  id: string
  project_id: string | null
  kind: string
  driver: string
  name: string | null
  archived: number
  model: string | null
  thinking_level: string | null
  location_json: string | null
  leaf_message_id: string | null
  discovered_tools_json: string | null
  parent_session_id: string | null
  state: string
  waiting_reason: string | null
  created_at: string
  updated_at: string
}

export type MessageRow = {
  session_id: string
  id: string
  parent_id: string | null
  seq: number
  run_id: string | null
  kind: string
  role: string | null
  content_json: string
  include_in_context: number
  stop_reason: string | null
  produced_by: string | null
  first_kept_id: string | null
  tokens_before: number | null
  label: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  cost_usd: number | null
  duration_ms: number | null
  details_json: string | null
  choice_json: string | null
  location_json: string | null
  created_at: string
}

const CHANNEL_META_PREFIX = 'legacy_session_channel:'

function getKvMeta(db: VelaDatabase, key: string): string | undefined {
  const row = db.get<{ value_json: string }>(
    'SELECT value_json FROM kv_meta WHERE key = ?',
    key,
  )
  if (!row) return undefined
  return JSON.parse(row.value_json) as string
}

function setKvMeta(
  db: VelaDatabase,
  key: string,
  value: unknown,
  now = new Date().toISOString(),
): void {
  db.run(
    'INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
    key,
    JSON.stringify(value),
    now,
  )
}

export function getSessionChannel(
  db: VelaDatabase,
  sessionId: string,
): string | undefined {
  return getKvMeta(db, `${CHANNEL_META_PREFIX}${sessionId}`)
}

export function setSessionChannel(
  db: VelaDatabase,
  sessionId: string,
  channel: string,
): void {
  setKvMeta(db, `${CHANNEL_META_PREFIX}${sessionId}`, channel)
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const INSERT_MESSAGE_SQL = `INSERT INTO vela_messages (
  session_id, id, parent_id, seq, run_id, kind, role, content_json,
  include_in_context, stop_reason, produced_by, first_kept_id,
  tokens_before, label, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, cost_usd, duration_ms, details_json, choice_json,
  location_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

export function insertMessageRow(
  db: VelaDatabase,
  sessionId: string,
  entry: SessionEntry,
  seq: number,
  extra: Parameters<typeof entryToRowParams>[3] = {},
): void {
  db.run(INSERT_MESSAGE_SQL, ...entryToRowParams(sessionId, entry, seq, extra))
}

export function entryToRowParams(
  sessionId: string,
  entry: SessionEntry,
  seq: number,
  extra: {
    runId?: string
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    costUsd?: number
    durationMs?: number
    choice?: { model?: string; thinkingLevel?: ThinkingLevel }
    location?: ExecutionLocation
  } = {},
) {
  let role: string | null = null
  let contentJson: string
  let includeInContext = 1
  let stopReason: string | null = null
  let producedBy: string | null = null
  let firstKeptId: string | null = null
  let tokensBefore: number | null = null
  let detailsJson: string | null = null

  switch (entry.type) {
    case 'message':
      role = entry.message.role
      contentJson = JSON.stringify(entry.message)
      includeInContext = entry.stopReason ? 0 : 1
      stopReason = entry.stopReason ?? null
      producedBy = entry.producedBy ?? null
      detailsJson =
        entry.details !== undefined ? JSON.stringify(entry.details) : null
      break
    case 'compaction':
      role = 'user'
      contentJson = JSON.stringify({ summary: entry.summary })
      firstKeptId = entry.firstKeptEntryId
      tokensBefore = entry.tokensBefore
      break
    case 'branch_summary':
      role = 'user'
      contentJson = JSON.stringify({
        fromId: entry.fromId,
        summary: entry.summary,
      })
      break
    case 'bash_execution':
      role = 'user'
      includeInContext = entry.excludeFromContext ? 0 : 1
      contentJson = JSON.stringify({
        command: entry.command,
        output: entry.output,
        ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
        cancelled: entry.cancelled,
        truncated: entry.truncated,
        ...(entry.fullOutputPath
          ? { fullOutputPath: entry.fullOutputPath }
          : {}),
        ...(entry.excludeFromContext ? { excludeFromContext: true } : {}),
        ...(entry.backgroundTaskId
          ? { backgroundTaskId: entry.backgroundTaskId }
          : {}),
      })
      break
    case 'custom_message':
      role = 'user'
      contentJson = JSON.stringify({
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
      })
      detailsJson =
        entry.details !== undefined ? JSON.stringify(entry.details) : null
      break
    case 'custom':
      includeInContext = 0
      contentJson = JSON.stringify({
        customType: entry.customType,
        ...(entry.data === undefined ? {} : { data: entry.data }),
      })
      break
  }

  const hasChoice =
    extra.choice &&
    (extra.choice.model !== undefined ||
      extra.choice.thinkingLevel !== undefined)
  const choiceJson = hasChoice
    ? JSON.stringify({
        ...(extra.choice!.model === undefined
          ? {}
          : { model: extra.choice!.model }),
        ...(extra.choice!.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: extra.choice!.thinkingLevel }),
      })
    : null
  const locationJson = extra.location ? JSON.stringify(extra.location) : null

  return [
    sessionId,
    entry.id,
    entry.parentId,
    seq,
    extra.runId ?? null,
    entry.type,
    role,
    contentJson,
    includeInContext,
    stopReason,
    producedBy,
    firstKeptId,
    tokensBefore,
    entry.label ?? null,
    extra.inputTokens ?? null,
    extra.outputTokens ?? null,
    extra.cacheReadTokens ?? null,
    extra.cacheWriteTokens ?? null,
    extra.costUsd ?? null,
    extra.durationMs ?? null,
    detailsJson,
    choiceJson,
    locationJson,
    entry.timestamp,
  ] as const
}

function parseRowChoice(
  choiceJson: string | null,
): { model?: string; thinkingLevel?: ThinkingLevel } | undefined {
  if (!choiceJson) return undefined
  const parsed = JSON.parse(choiceJson) as unknown
  if (!isPlainObject(parsed)) return undefined
  const choice: { model?: string; thinkingLevel?: ThinkingLevel } = {}
  if (typeof parsed.model === 'string') choice.model = parsed.model
  if (typeof parsed.thinkingLevel === 'string') {
    choice.thinkingLevel = parsed.thinkingLevel as ThinkingLevel
  }
  return choice.model !== undefined || choice.thinkingLevel !== undefined
    ? choice
    : undefined
}

export function parseRowLocation(
  locationJson: string | null,
): ExecutionLocation | undefined {
  if (!locationJson) return undefined
  const parsed = JSON.parse(locationJson) as unknown
  if (!isPlainObject(parsed)) return undefined
  return parsed as unknown as ExecutionLocation
}

export function rowToEntry(row: MessageRow): SessionEntry {
  const parsed = JSON.parse(row.content_json) as Record<string, unknown>
  const details =
    row.details_json !== null
      ? (JSON.parse(row.details_json) as unknown)
      : undefined
  const base = {
    id: row.id,
    parentId: row.parent_id,
    timestamp: row.created_at,
    ...(row.label ? { label: row.label } : {}),
  }
  switch (row.kind) {
    case 'message': {
      const entry: SessionMessageEntry = {
        ...base,
        type: 'message',
        message: parsed as unknown as ModelMessage,
        ...(row.stop_reason
          ? { stopReason: row.stop_reason as 'aborted' | 'error' }
          : {}),
        ...(row.produced_by ? { producedBy: row.produced_by } : {}),
        ...(details && isPlainObject(details) ? { details } : {}),
      }
      return entry
    }
    case 'compaction': {
      const entry: CompactionEntry = {
        ...base,
        type: 'compaction',
        summary: String(parsed.summary ?? ''),
        firstKeptEntryId: row.first_kept_id ?? '',
        tokensBefore: row.tokens_before ?? 0,
      }
      return entry
    }
    case 'branch_summary': {
      const entry: BranchSummaryEntry = {
        ...base,
        type: 'branch_summary',
        fromId: String(parsed.fromId ?? 'root'),
        summary: String(parsed.summary ?? ''),
      }
      return entry
    }
    case 'bash_execution': {
      const entry: BashExecutionEntry = {
        ...base,
        type: 'bash_execution',
        command: String(parsed.command ?? ''),
        output: String(parsed.output ?? ''),
        cancelled: Boolean(parsed.cancelled),
        truncated: Boolean(parsed.truncated),
        ...(parsed.exitCode === undefined
          ? {}
          : { exitCode: Number(parsed.exitCode) }),
        ...(parsed.fullOutputPath
          ? { fullOutputPath: String(parsed.fullOutputPath) }
          : {}),
        ...(parsed.excludeFromContext ? { excludeFromContext: true } : {}),
        ...(parsed.backgroundTaskId
          ? { backgroundTaskId: String(parsed.backgroundTaskId) }
          : {}),
      }
      return entry
    }
    case 'custom_message': {
      const entry: CustomMessageEntry = {
        ...base,
        type: 'custom_message',
        customType: String(parsed.customType ?? ''),
        content: parsed.content as CustomMessageEntry['content'],
        display: Boolean(parsed.display),
        ...(details === undefined ? {} : { details }),
      }
      return entry
    }
    case 'custom': {
      const entry: CustomEntry = {
        ...base,
        type: 'custom',
        customType: String(parsed.customType ?? ''),
        ...('data' in parsed ? { data: parsed.data } : {}),
      }
      return entry
    }
    default:
      throw new Error(`Unsupported vela_messages kind "${row.kind}"`)
  }
}

export function queryBranchRows(
  db: VelaDatabase,
  sessionId: string,
  fromId: string | null,
): MessageRow[] {
  if (fromId === null) return []
  return db.all<MessageRow>(
    `WITH RECURSIVE branch(
       session_id, id, parent_id, seq, run_id, kind, role, content_json,
       include_in_context, stop_reason, produced_by, first_kept_id,
       tokens_before, label, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, cost_usd, duration_ms, details_json, choice_json,
       location_json, created_at, path
     ) AS (
       SELECT session_id, id, parent_id, seq, run_id, kind, role, content_json,
              include_in_context, stop_reason, produced_by, first_kept_id,
              tokens_before, label, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, cost_usd, duration_ms, details_json, choice_json,
              location_json, created_at, ',' || id || ','
       FROM vela_messages
       WHERE session_id = ? AND id = ?
       UNION ALL
       SELECT m.session_id, m.id, m.parent_id, m.seq, m.run_id, m.kind, m.role, m.content_json,
              m.include_in_context, m.stop_reason, m.produced_by, m.first_kept_id,
              m.tokens_before, m.label, m.input_tokens, m.output_tokens, m.cache_read_tokens,
              m.cache_write_tokens, m.cost_usd, m.duration_ms, m.details_json, m.choice_json,
              m.location_json, m.created_at, b.path || m.id || ','
       FROM vela_messages m
       JOIN branch b ON m.session_id = b.session_id AND m.id = b.parent_id
       WHERE instr(b.path, ',' || m.id || ',') = 0
     )
     SELECT session_id, id, parent_id, seq, run_id, kind, role, content_json,
            include_in_context, stop_reason, produced_by, first_kept_id,
            tokens_before, label, input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, cost_usd, duration_ms, details_json, choice_json,
            location_json, created_at
     FROM branch ORDER BY seq ASC`,
    sessionId,
    fromId,
  )
}

export function listSessionSummariesFromDb(
  db: VelaDatabase,
  includeArchived = false,
): SessionSummary[] {
  const sessions = db.all<SessionRow>(
    `SELECT * FROM sessions
     ${includeArchived ? '' : 'WHERE archived = 0'}
     ORDER BY updated_at DESC`,
  )
  const summaries: SessionSummary[] = []
  for (const session of sessions) {
    const countRow = db.get<{ n: number }>(
      "SELECT count(*) AS n FROM vela_messages WHERE session_id = ? AND kind IN ('message', 'bash_execution')",
      session.id,
    )
    const messageCount = countRow?.n ?? 0
    if (messageCount === 0) continue

    const firstRow = db.get<MessageRow>(
      `SELECT * FROM vela_messages
       WHERE session_id = ?
         AND ((kind = 'message' AND role = 'user') OR kind = 'bash_execution')
       ORDER BY seq ASC
       LIMIT 1`,
      session.id,
    )
    let firstMessage = ''
    if (firstRow) {
      const entry = rowToEntry(firstRow)
      if (entry.type === 'bash_execution') {
        firstMessage =
          `${entry.excludeFromContext ? '!!' : '!'}${entry.command}`
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120)
      } else if (entry.type === 'message') {
        firstMessage = messageText(entry.message.content)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120)
      }
    }

    const location = session.location_json
      ? (JSON.parse(session.location_json) as { cwd?: string })
      : undefined
    const channel = getSessionChannel(db, session.id)
    summaries.push({
      id: session.id,
      ...(session.name ? { name: session.name } : {}),
      updatedAt: session.updated_at,
      messageCount,
      firstMessage,
      ...(location?.cwd ? { cwd: location.cwd } : {}),
      ...(channel ? { channel } : {}),
      ...(session.archived ? { archived: true } : {}),
    })
  }
  return summaries
}

export function setSavedSessionArchivedInDb(
  db: VelaDatabase,
  sessionId: string,
  archived: boolean,
): boolean {
  const existing = db.get<{ archived: number }>(
    'SELECT archived FROM sessions WHERE id = ?',
    sessionId,
  )
  const hasMessages = db.get<{ n: number }>(
    'SELECT count(*) AS n FROM vela_messages WHERE session_id = ?',
    sessionId,
  )?.n
  if (!existing || !hasMessages) {
    throw new Error(`Session ${sessionId} has nothing saved to archive`)
  }
  const flag = archived ? 1 : 0
  if (existing.archived === flag) return false
  db.run(
    'UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ?',
    flag,
    new Date().toISOString(),
    sessionId,
  )
  return true
}

export function loadAllSessionRows(
  db: VelaDatabase,
  sessionId: string,
): MessageRow[] {
  return db.all<MessageRow>(
    'SELECT * FROM vela_messages WHERE session_id = ? ORDER BY seq ASC',
    sessionId,
  )
}

export function loadSessionMeta(
  db: VelaDatabase,
  sessionId: string,
): {
  row: SessionRow | undefined
  channel: string | undefined
  discoveredTools: string[]
  model: string | undefined
  thinkingLevel: ThinkingLevel | undefined
} {
  const row = db.get<SessionRow>(
    'SELECT * FROM sessions WHERE id = ?',
    sessionId,
  )
  const discoveredTools = row?.discovered_tools_json
    ? (JSON.parse(row.discovered_tools_json) as string[])
    : []
  return {
    row,
    channel: getSessionChannel(db, sessionId),
    discoveredTools,
    model: row?.model ?? undefined,
    thinkingLevel: (row?.thinking_level as ThinkingLevel | null) ?? undefined,
  }
}

export function computeLatestAssistantUsage(
  rows: readonly MessageRow[],
  activeIds: ReadonlySet<string>,
  messages: readonly ModelMessage[],
  ids: ReadonlyMap<ModelMessage, string>,
):
  | {
      inputTokens: number
      outputTokens: number
      trailingMessages: ModelMessage[]
    }
  | undefined {
  let latestRow: MessageRow | undefined
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (!activeIds.has(row.id)) continue
    if (row.kind === 'compaction') break
    if (
      row.kind === 'message' &&
      row.role === 'assistant' &&
      !row.stop_reason &&
      row.input_tokens !== null
    ) {
      latestRow = row
      break
    }
  }
  if (!latestRow) return undefined
  const idx = messages.findIndex((m) => ids.get(m) === latestRow!.id)
  if (idx < 0) return undefined
  const totalInput =
    (latestRow.input_tokens ?? 0) +
    (latestRow.cache_read_tokens ?? 0) +
    (latestRow.cache_write_tokens ?? 0)
  return {
    inputTokens: totalInput,
    outputTokens: latestRow.output_tokens ?? 0,
    trailingMessages: messages.slice(idx + 1),
  }
}

export function computeBranchUsage(
  db: VelaDatabase,
  sessionId: string,
  leafId: string | null,
  messages: readonly ModelMessage[],
  ids: ReadonlyMap<ModelMessage, string>,
): LoadedSessionContext['latestAssistantUsage'] {
  if (!db.open || leafId === null) return undefined
  const rows = queryBranchRows(db, sessionId, leafId)
  const activeIds = new Set(rows.map((r) => r.id))
  return computeLatestAssistantUsage(rows, activeIds, messages, ids)
}

export function searchSessionsInDb(
  db: VelaDatabase,
  query: string,
  includeArchived: boolean,
): SessionSearchHit[] {
  const text = query.trim()
  if (!text) return []
  const hits: SessionSearchHit[] = []
  for (const summary of listSessionSummariesFromDb(db, includeArchived)) {
    const entries = loadAllSessionRows(db, summary.id).map(rowToEntry)
    const match = entries.length ? searchSessionText(entries, text) : undefined
    if (match) hits.push({ id: summary.id, match })
  }
  return hits
}

export function upsertSessionRecord(
  db: VelaDatabase,
  params: {
    sessionId: string
    name?: string
    archived: boolean
    model?: string
    thinkingLevel?: ThinkingLevel
    location?: ExecutionLocation
    leafId: string | null
    discoveredTools: readonly string[]
    parentSessionId?: string
    channel?: string
  },
): void {
  const now = new Date().toISOString()
  db.run(
    `INSERT INTO sessions (
       id, project_id, kind, driver, name, archived, model, thinking_level,
       location_json, leaf_message_id, discovered_tools_json, parent_session_id,
       state, created_at, updated_at
     ) VALUES (?, NULL, 'chat', 'vela', ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = COALESCE(excluded.name, sessions.name),
       model = COALESCE(excluded.model, sessions.model),
       thinking_level = COALESCE(excluded.thinking_level, sessions.thinking_level),
       location_json = COALESCE(excluded.location_json, sessions.location_json),
       leaf_message_id = COALESCE(excluded.leaf_message_id, sessions.leaf_message_id),
       discovered_tools_json = COALESCE(excluded.discovered_tools_json, sessions.discovered_tools_json),
       updated_at = excluded.updated_at`,
    params.sessionId,
    params.name ?? null,
    params.archived ? 1 : 0,
    params.model ?? null,
    params.thinkingLevel ?? null,
    params.location ? JSON.stringify(params.location) : null,
    params.leafId,
    params.discoveredTools.length
      ? JSON.stringify(params.discoveredTools)
      : null,
    params.parentSessionId ?? null,
    now,
    now,
  )
  if (params.channel) setSessionChannel(db, params.sessionId, params.channel)
}

export function updateArchivedInDb(
  db: VelaDatabase,
  sessionId: string,
  archived: boolean,
  requireSaved: boolean,
): boolean {
  const flag = archived ? 1 : 0
  if (requireSaved) {
    const row = db.get<{ archived: number }>(
      'SELECT archived FROM sessions WHERE id = ?',
      sessionId,
    )
    const count = db.get<{ n: number }>(
      'SELECT count(*) AS n FROM vela_messages WHERE session_id = ?',
      sessionId,
    )?.n
    if (!row || !count)
      throw new Error(`Session ${sessionId} has nothing saved to archive`)
    if (row.archived === flag) return false
  }
  db.run(
    'UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ?',
    flag,
    new Date().toISOString(),
    sessionId,
  )
  return true
}

export function insertUsageRecord(
  db: VelaDatabase,
  sessionId: string,
  record: StepRecord,
  options: { runId?: string; messageId?: string },
): void {
  db.run(
    `INSERT INTO usage_records (
       id, session_id, project_id, run_id, message_id, kind, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd, duration_ms, raw_json, created_at
     ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    sessionId,
    options.runId ?? null,
    options.messageId ?? null,
    record.kind ?? 'main',
    record.model,
    record.inputTokens,
    record.outputTokens,
    record.cacheReadTokens,
    record.cacheWriteTokens,
    record.cost ?? null,
    record.durationMs === undefined ? null : Math.round(record.durationMs),
    record.usage ? JSON.stringify(record.usage) : null,
    new Date(record.ts).toISOString(),
  )
}

export function extractToolMessageDetails(
  message: ModelMessage,
  toolDetails: Map<string, unknown>,
): Record<string, unknown> {
  const details: Record<string, unknown> = {}
  if (message.role !== 'tool') return details
  for (const part of message.content) {
    if (part.type === 'tool_result' && toolDetails.has(part.toolCallId)) {
      details[part.toolCallId] = toolDetails.get(part.toolCallId)
    }
  }
  return details
}

export function startsConversationEntry(entry: SessionEntry): boolean {
  return (
    entry.type === 'custom_message' ||
    entry.type === 'bash_execution' ||
    (entry.type === 'message' &&
      (entry.message.role === 'user' || entry.message.role === 'assistant'))
  )
}

export function updateSessionColumn(
  db: VelaDatabase,
  sessionId: string,
  column: 'model' | 'thinking_level' | 'name' | 'discovered_tools_json',
  value: string | null,
): void {
  db.run(
    `UPDATE sessions SET ${column} = ?, updated_at = ? WHERE id = ?`,
    value,
    new Date().toISOString(),
    sessionId,
  )
}

export function updateSessionLeaf(
  db: VelaDatabase,
  sessionId: string,
  leafId: string | null,
  model?: string,
  thinkingLevel?: ThinkingLevel,
): void {
  db.run(
    `UPDATE sessions
     SET leaf_message_id = ?,
         model = COALESCE(?, model),
         thinking_level = COALESCE(?, thinking_level),
         updated_at = ?
     WHERE id = ?`,
    leafId,
    model ?? null,
    thinkingLevel ?? null,
    new Date().toISOString(),
    sessionId,
  )
}

export function collectRowMetadata(
  rows: readonly MessageRow[],
  entryModel: Map<string, string>,
  entryThinking: Map<string, ThinkingLevel>,
  entryLocations: Map<string, ExecutionLocation>,
): void {
  for (const row of rows) {
    const choice = parseRowChoice(row.choice_json)
    if (choice?.model !== undefined) entryModel.set(row.id, choice.model)
    if (choice?.thinkingLevel !== undefined)
      entryThinking.set(row.id, choice.thinkingLevel)
    const rowLoc = parseRowLocation(row.location_json)
    if (rowLoc !== undefined) entryLocations.set(row.id, rowLoc)
  }
}
