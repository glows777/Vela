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
  const passive = input.passive === true
  const wake = input.wake ?? !passive
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
  const passive = input.passive === true ? 1 : 0
  const wake = (input.wake ?? input.passive !== true) ? 1 : 0
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

function inboxRouteInfo(row: InboxRow): {
  routeKey?: string
  mentionSig?: string
  needsAnnouncement: boolean
} {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>
  } catch {
    return { needsAnnouncement: false }
  }
  const isRouteSource =
    row.source === 'channel' ||
    row.source === 'timer' ||
    row.source === 'webhook' ||
    row.source === 'handoff' ||
    (row.source === 'approval' && payload.waitForInput === true)
  const routeKey =
    isRouteSource &&
    typeof payload.channel === 'string' &&
    typeof payload.externalChatId === 'string'
      ? JSON.stringify([
          payload.channel,
          payload.externalChatId,
          typeof payload.threadId === 'string' ? payload.threadId : null,
        ])
      : undefined
  const isPassive = row.passive === 1
  const isRoutine = row.source === 'timer' && payload.kind === 'routine'
  const isDefaultWebhook =
    row.source === 'webhook' && payload.isDefaultTarget === true
  const needsAnnouncement =
    row.wake === 1 &&
    !isPassive &&
    (isRoutine || isDefaultWebhook) &&
    Boolean(routeKey) &&
    typeof payload.threadId !== 'string' &&
    typeof payload.replyToMessageId !== 'string'
  const recipientId =
    typeof payload.senderId === 'string' && payload.senderId
      ? payload.senderId
      : typeof payload.creatorId === 'string' && payload.creatorId
        ? payload.creatorId
        : null
  const mentionSig =
    row.wake === 1 && !isPassive && routeKey
      ? JSON.stringify([payload.mentionRecipient === true, recipientId])
      : undefined
  return { routeKey, mentionSig, needsAnnouncement }
}

const PASSIVE_BATCH_MAX_BYTES = 400 * 1024

export function cancelPendingInboxEventInDb(
  db: VelaDatabase,
  inboxEventId: string,
  now = new Date().toISOString(),
): boolean {
  const res = db.run(
    `UPDATE inbox_events
     SET status = 'done', processed_at = COALESCE(processed_at, ?)
     WHERE id = ? AND status = 'pending'`,
    now,
    inboxEventId,
  )
  return res.changes > 0
}

/**
 * Claims pending events for `sessionId` into `runId` iff at least one pending event
 * has `wake = 1`. Anchors on the oldest runnable wake event so non-waking inputs for
 * another route cannot stall the worker, isolates announcement wakes individually,
 * partitions waking passive batches from explicit requests (capped at 400 KB),
 * prevents passive inputs from crossing routes, and keeps recipient attribution uniform.
 */
export function claimInboxBatchInTx(
  db: VelaDatabase,
  sessionId: string,
  runId: string,
): InboxEventRecord[] {
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM inbox_events
     WHERE session_id = ? AND status = 'pending'
     ORDER BY created_at ASC, rowid ASC`,
    sessionId,
  ) as unknown as InboxRow[]
  if (!rows.length) return []

  const firstWakeIdx = rows.findIndex((row) => row.wake === 1)
  if (firstWakeIdx === -1) return []

  const anchor = rows[firstWakeIdx]!
  const anchorInfo = inboxRouteInfo(anchor)
  const anchorPassive = anchor.passive === 1

  let selected: InboxRow[]
  if (anchorInfo.needsAnnouncement) {
    selected = [anchor]
  } else if (anchorPassive) {
    selected = []
    let batchBytes = 0
    for (const row of rows) {
      if (row.passive !== 1) continue
      const info = inboxRouteInfo(row)
      if (
        anchorInfo.routeKey &&
        info.routeKey &&
        info.routeKey !== anchorInfo.routeKey
      ) {
        continue
      }
      const bytes = Buffer.byteLength(row.payload_json, 'utf8')
      if (selected.length > 0 && batchBytes + bytes > PASSIVE_BATCH_MAX_BYTES) {
        break
      }
      selected.push(row)
      batchBytes += bytes
    }
  } else {
    selected = []
    let activeRouteKey = anchorInfo.routeKey
    let activeMentionSig = anchorInfo.mentionSig
    for (const row of rows) {
      if (row.passive === 1 && row.wake === 1) continue
      const info = inboxRouteInfo(row)
      if (info.needsAnnouncement) continue
      if (info.routeKey) {
        if (activeRouteKey && info.routeKey !== activeRouteKey) continue
        activeRouteKey ??= info.routeKey
      }
      if (info.mentionSig !== undefined) {
        if (
          activeMentionSig !== undefined &&
          info.mentionSig !== activeMentionSig
        ) {
          continue
        }
        activeMentionSig ??= info.mentionSig
      }
      selected.push(row)
    }
  }
  if (!selected.some((row) => row.wake === 1)) {
    return []
  }

  if (selected.length === rows.length) {
    db.run(
      `UPDATE inbox_events
       SET status = 'processing', run_id = ?
       WHERE session_id = ? AND status = 'pending'`,
      runId,
      sessionId,
    )
  } else {
    const placeholders = selected.map(() => '?').join(', ')
    db.run(
      `UPDATE inbox_events
       SET status = 'processing', run_id = ?
       WHERE id IN (${placeholders})`,
      runId,
      ...selected.map((row) => row.id),
    )
  }
  return selected.map((row) =>
    rowToInbox({ ...row, status: 'processing', run_id: runId }),
  )
}

/**
 * Claims only pending `'approval'` wake events when resuming a `waiting_human` run,
 * leaving ordinary queued prompts/notes in `'pending'` for the next fresh run.
 */
export function claimApprovalInboxBatchInTx(
  db: VelaDatabase,
  sessionId: string,
  runId: string,
): InboxEventRecord[] {
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM inbox_events
     WHERE session_id = ? AND status = 'pending' AND source = 'approval'
     ORDER BY created_at ASC, rowid ASC`,
    sessionId,
  ) as unknown as InboxRow[]
  if (!rows.length) return []
  db.run(
    `UPDATE inbox_events
     SET status = 'processing', run_id = ?
     WHERE session_id = ? AND status = 'pending' AND source = 'approval'`,
    runId,
    sessionId,
  )
  return rows.map((row) =>
    rowToInbox({ ...row, status: 'processing', run_id: runId }),
  )
}

export function hasSessionPendingWake(
  db: VelaDatabase,
  sessionId: string,
  excludeIds?: ReadonlySet<string>,
): boolean {
  if (!excludeIds || excludeIds.size === 0) {
    return Boolean(
      db.get<{ id: string }>(
        `SELECT id FROM inbox_events WHERE session_id = ? AND status = 'pending' AND wake = 1 LIMIT 1`,
        sessionId,
      ),
    )
  }
  const rows = db.all<{ id: string }>(
    `SELECT id FROM inbox_events WHERE session_id = ? AND status = 'pending' AND wake = 1`,
    sessionId,
  )
  return rows.some((row) => !excludeIds.has(row.id))
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

export function isTopicAwaitingBindingInDb(
  db: VelaDatabase,
  sessionId: string,
): boolean {
  return Boolean(
    db.get<{ ok: number }>(
      `SELECT 1 AS ok FROM sessions s
       WHERE s.id = ?
         AND s.kind = 'topic'
         AND NOT EXISTS (
           SELECT 1 FROM channel_bindings cb
           WHERE cb.session_id = s.id AND cb.enabled = 1
         )
         AND EXISTS (
           SELECT 1 FROM outbox ob
           WHERE ob.session_id = s.id
             AND ob.kind = 'topic_start'
             AND ob.status IN ('pending', 'sending', 'failed')
         )
       LIMIT 1`,
      sessionId,
    ),
  )
}

export function listSessionsWithPendingWake(db: VelaDatabase): string[] {
  const rows = db.all<{ session_id: string }>(
    `SELECT DISTINCT e.session_id FROM inbox_events e
     JOIN sessions s ON s.id = e.session_id
     WHERE e.session_id IS NOT NULL
       AND e.status = 'pending'
       AND e.wake = 1
       AND NOT (
         s.kind = 'topic'
         AND NOT EXISTS (
           SELECT 1 FROM channel_bindings cb
           WHERE cb.session_id = s.id AND cb.enabled = 1
         )
         AND EXISTS (
           SELECT 1 FROM outbox ob
           WHERE ob.session_id = s.id
             AND ob.kind = 'topic_start'
             AND ob.status IN ('pending', 'sending', 'failed')
         )
       )`,
  )
  return rows.map((row) => row.session_id)
}
