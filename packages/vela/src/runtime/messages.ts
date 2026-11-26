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
  if (row.kind === 'message') {
    content = parsed.content
    text = extractText(parsed.content)
  } else if (row.kind === 'custom_message') {
    content = parsed.content
    text = extractText(parsed.content)
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
    ...(row.stop_reason ? { stopReason: row.stop_reason } : {}),
    ...(row.produced_by ? { producedBy: row.produced_by } : {}),
    ...(details !== undefined ? { details } : {}),
    createdAt: row.created_at,
  }
}

/**
 * Reads paginated persisted messages for a session from `vela_messages` in chronological order.
 */
export function listRuntimeSessionMessages(
  db: VelaDatabase,
  input: { sessionId: string; cursor?: string; limit?: number },
): RuntimeMessagePage {
  const session = db.get<{ id: string }>(
    'SELECT id FROM sessions WHERE id = ?',
    input.sessionId,
  )
  if (!session) throw new Error(`Session ${input.sessionId} not found`)

  const rawLimit = input.limit ?? 100
  const limit = Math.max(1, Math.min(500, Math.trunc(rawLimit)))
  let afterSeq = -1
  if (input.cursor !== undefined) {
    const parsed = Number(input.cursor)
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`Invalid messages cursor: "${input.cursor}"`)
    }
    afterSeq = parsed
  }

  const rows = db.all<RawMessageRow>(
    `SELECT id, session_id, run_id, seq, kind, role, content_json, stop_reason,
            produced_by, details_json, created_at
     FROM vela_messages
     WHERE session_id = ?
       AND seq > ?
       AND kind IN ('message', 'custom_message', 'bash_execution', 'compaction', 'branch_summary')
     ORDER BY seq ASC
     LIMIT ?`,
    input.sessionId,
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
