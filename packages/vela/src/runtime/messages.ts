import type { VelaDatabase } from '../db/index.ts'

export interface RuntimeMessageRecord {
  id: string
  sessionId: string
  runId: string | null
  seq: number
  kind: string
  role: 'user' | 'assistant' | 'tool' | 'system' | null
  text: string
  content: unknown
  senderName?: string
  senderId?: string
  customType?: string
  display?: boolean
  stopReason?: string
  producedBy?: string
  details?: unknown
  createdAt: string
}

export interface RuntimeMessagePage {
  messages: RuntimeMessageRecord[]
  nextCursor?: string
}

type RawMessageRow = {
  id: string
  session_id: string
  run_id: string | null
  seq: number
  kind: string
  role: string | null
  content_json: string
  stop_reason: string | null
  produced_by: string | null
  details_json: string | null
  created_at: string
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('\n')
}

function rowToRuntimeMessage(row: RawMessageRow): RuntimeMessageRecord {
  const parsed = JSON.parse(row.content_json) as Record<string, unknown>
  let text = ''
  let content: unknown = parsed
  let customType: string | undefined
  let display: boolean | undefined
  if (row.kind === 'message') {
    content = parsed.content
    text = extractText(parsed.content)
  } else if (row.kind === 'custom_message') {
    content = parsed.content
    text = extractText(parsed.content)
    if (typeof parsed.customType === 'string') customType = parsed.customType
    if (typeof parsed.display === 'boolean') display = parsed.display
  } else if (row.kind === 'bash_execution') {
    text = String(parsed.command ?? '')
  } else if (row.kind === 'compaction' || row.kind === 'branch_summary') {
    text = String(parsed.summary ?? '')
  }
  const details =
    row.details_json !== null
      ? (JSON.parse(row.details_json) as unknown)
      : undefined
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    seq: row.seq,
    kind: row.kind,
    role: row.role as RuntimeMessageRecord['role'],
    text,
    content,
    ...(customType !== undefined ? { customType } : {}),
    ...(display !== undefined ? { display } : {}),
    ...(row.stop_reason ? { stopReason: row.stop_reason } : {}),
    ...(row.produced_by ? { producedBy: row.produced_by } : {}),
    ...(details !== undefined ? { details } : {}),
    createdAt: row.created_at,
  }
}

/**
 * Reads paginated persisted active-branch messages for a session from `vela_messages`
 * in chronological order (returning empty after reset or while `leaf_message_id` is null).
 */
export function listRuntimeSessionMessages(
  db: VelaDatabase,
  input: { sessionId: string; cursor?: string; limit?: number },
): RuntimeMessagePage {
  const session = db.get<{ id: string; leaf_message_id: string | null }>(
    'SELECT id, leaf_message_id FROM sessions WHERE id = ?',
    input.sessionId,
  )
  if (!session) throw new Error(`Session ${input.sessionId} not found`)

  const rawLimit = input.limit ?? 100
  if (!Number.isFinite(rawLimit) || rawLimit < 1) {
    throw new Error(`Invalid messages limit: "${input.limit}"`)
  }
  const limit = Math.max(1, Math.min(500, Math.trunc(rawLimit)))
  let afterSeq = -1
  if (input.cursor !== undefined) {
    if (!/^\d+$/.test(input.cursor)) {
      throw new Error(`Invalid messages cursor: "${input.cursor}"`)
    }
    afterSeq = Number(input.cursor)
  }

  if (session.leaf_message_id === null) {
    return { messages: [] }
  }

  const rows = db.all<RawMessageRow>(
    `WITH RECURSIVE branch(
       session_id, id, parent_id, seq, run_id, kind, role, content_json,
       stop_reason, produced_by, details_json, created_at, path
     ) AS (
       SELECT session_id, id, parent_id, seq, run_id, kind, role, content_json,
              stop_reason, produced_by, details_json, created_at, ',' || id || ','
       FROM vela_messages
       WHERE session_id = ? AND id = ?
       UNION ALL
       SELECT m.session_id, m.id, m.parent_id, m.seq, m.run_id, m.kind, m.role, m.content_json,
              m.stop_reason, m.produced_by, m.details_json, m.created_at, b.path || m.id || ','
       FROM vela_messages m
       JOIN branch b ON m.session_id = b.session_id AND m.id = b.parent_id
       WHERE instr(b.path, ',' || m.id || ',') = 0
     )
     SELECT id, session_id, run_id, seq, kind, role, content_json, stop_reason,
            produced_by, details_json, created_at
     FROM branch
     WHERE seq > ?
       AND kind IN ('message', 'custom_message', 'bash_execution', 'compaction', 'branch_summary')
     ORDER BY seq ASC
     LIMIT ?`,
    input.sessionId,
    session.leaf_message_id,
    afterSeq,
    limit + 1,
  )

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const messages = pageRows.map(rowToRuntimeMessage)
  return {
    messages,
    ...(hasMore && messages.length > 0
      ? { nextCursor: String(messages.at(-1)!.seq) }
      : {}),
  }
}
