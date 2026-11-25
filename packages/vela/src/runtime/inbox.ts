import { randomUUID } from 'node:crypto'
import type { VelaDatabase } from '../db/index.ts'

type InboxStatus = 'pending' | 'processing' | 'done' | 'dropped'

export interface InboxEventRecord {
  id: string
  sessionId: string | null
  projectId: string | null
  source: string
  dedupeKey: string | null
  wake: boolean
  passive: boolean
  status: InboxStatus
  payload: Record<string, unknown>
  runId: string | null
  createdAt: string
  processedAt: string | null
}

export interface EnqueueInboxInput {
  id?: string
  sessionId: string
  projectId?: string | null
  source: string
  dedupeKey?: string | null
  wake?: boolean
  passive?: boolean
  payload: Record<string, unknown>
}

type InboxRow = {
  id: string
  session_id: string | null
  project_id: string | null
  source: string
  dedupe_key: string | null
  wake: number
  passive: number
  status: string
  payload_json: string
  run_id: string | null
  created_at: string
  processed_at: string | null
}

function rowToInbox(row: InboxRow): InboxEventRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    source: row.source,
    dedupeKey: row.dedupe_key,
    wake: row.wake === 1,
    passive: row.passive === 1,
    status: row.status as InboxStatus,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    runId: row.run_id,
    createdAt: row.created_at,
    processedAt: row.processed_at,
  }
}

function isHumanWakeInput(input: EnqueueInboxInput): boolean {
  const wake = input.wake !== false
  const passive = input.passive === true
  return (
    wake && !passive && (input.source === 'user' || input.source === 'channel')
  )
}

/**
 * Durable ingress into `inbox_events`.
 * Enforces `(source, dedupe_key)` idempotency and resets `sessions.followup_streak`
 * whenever fresh non-passive human input arrives.
 */
export function enqueueInboxEvent(
  db: VelaDatabase,
  input: EnqueueInboxInput,
): { event: InboxEventRecord; inserted: boolean } {
  const id = input.id ?? randomUUID()
  const now = new Date().toISOString()
  const wake = input.wake !== false ? 1 : 0
  const passive = input.passive === true ? 1 : 0
  const dedupeKey = input.dedupeKey ?? null

  return db.transaction(() => {
    const res = db.run(
      `INSERT OR IGNORE INTO inbox_events (
         id, session_id, project_id, source, dedupe_key, wake, passive,
         status, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      input.sessionId,
      input.projectId ?? null,
      input.source,
      dedupeKey,
      wake,
      passive,
      JSON.stringify(input.payload),
      now,
    )
    if (res.changes === 0 && dedupeKey !== null) {
      const existing = db.get<InboxRow>(
        'SELECT * FROM inbox_events WHERE source = ? AND dedupe_key = ?',
        input.source,
        dedupeKey,
      )
      if (existing) {
        return { event: rowToInbox(existing), inserted: false }
      }
    }
    if (isHumanWakeInput(input)) {
      db.run(
        'UPDATE sessions SET followup_streak = 0, updated_at = ? WHERE id = ?',
        now,
        input.sessionId,
      )
    }
    const created = db.get<InboxRow>(
      'SELECT * FROM inbox_events WHERE id = ?',
      id,
    )!
    return { event: rowToInbox(created), inserted: true }
  })
}

/**
 * Claims all `pending` events for `sessionId` into `runId` iff at least one pending event
 * has `wake = 1`. Accumulates `passive = 1` and `wake = 0` events into the same batch.
 */
export function claimInboxBatchInTx(
  db: VelaDatabase,
  sessionId: string,
  runId: string,
): InboxEventRecord[] {
  const hasWake = db.get<{ id: string }>(
    `SELECT id FROM inbox_events
     WHERE session_id = ? AND status = 'pending' AND wake = 1
     LIMIT 1`,
    sessionId,
  )
  if (!hasWake) return []
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM inbox_events
     WHERE session_id = ? AND status = 'pending'
     ORDER BY created_at ASC, rowid ASC`,
    sessionId,
  ) as unknown as InboxRow[]
  if (!rows.length) return []
  db.run(
    `UPDATE inbox_events
     SET status = 'processing', run_id = ?
     WHERE session_id = ? AND status = 'pending'`,
    runId,
    sessionId,
  )
  return rows.map((row) =>
    rowToInbox({ ...row, status: 'processing', run_id: runId }),
  )
}

export function listProcessingInboxForRun(
  db: VelaDatabase,
  runId: string,
): InboxEventRecord[] {
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM inbox_events
     WHERE run_id = ? AND status = 'processing'
     ORDER BY created_at ASC, rowid ASC`,
    runId,
  ) as unknown as InboxRow[]
  return rows.map(rowToInbox)
}

export function completeInboxBatchInTx(
  db: VelaDatabase,
  runId: string,
  now = new Date().toISOString(),
): void {
  db.run(
    `UPDATE inbox_events
     SET status = 'done', processed_at = COALESCE(processed_at, ?)
     WHERE run_id = ? AND status = 'processing'`,
    now,
    runId,
  )
}

export function requeueProcessingForRunInTx(
  db: VelaDatabase,
  runId: string,
): number {
  const res = db.run(
    `UPDATE inbox_events
     SET status = 'pending', run_id = NULL
     WHERE run_id = ? AND status = 'processing'`,
    runId,
  )
  return res.changes
}

export function listSessionsWithPendingWake(db: VelaDatabase): string[] {
  const rows = db.all<{ session_id: string }>(
    `SELECT DISTINCT session_id FROM inbox_events
     WHERE session_id IS NOT NULL AND status = 'pending' AND wake = 1`,
  )
  return rows.map((row) => row.session_id)
}
