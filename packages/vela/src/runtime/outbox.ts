import { randomUUID } from 'node:crypto'
import type { VelaDatabase } from '../db/index.ts'
import type { ChannelAdapter, ChannelOutboundMessage } from './channels.ts'
import { isOwnerLive, PROCESS_OWNER_PREFIX } from './driver.ts'

type OutboxKind = 'reply' | 'topic_start' | 'forward' | 'file'
type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled'

export const MAX_OUTBOX_ATTEMPTS = 5
const BASE_RETRY_MS = 1_000
const LIVE_OUTBOX_LEASES = new Map<string, string>()

function leaseKey(outboxId: string): string {
  return `outbox_lease:${outboxId}`
}

function syncTopicBindingOnDeliveryInTx(
  db: VelaDatabase,
  row: OutboxRecord,
  threadId: string,
  now: string,
): void {
  const session = db.get<{ project_id: string | null }>(
    'SELECT project_id FROM sessions WHERE id = ?',
    row.sessionId,
  )
  const projectId = session?.project_id ?? null
  const existingByThread = db.get<{ id: string }>(
    `SELECT id FROM channel_bindings WHERE channel = ? AND external_id = ? AND thread_id = ?`,
    row.channel,
    row.externalChatId,
    threadId,
  )
  if (existingByThread) {
    db.run(
      `UPDATE channel_bindings
       SET project_id = COALESCE(?, project_id), session_id = ?, enabled = 1, updated_at = ?
       WHERE id = ?`,
      projectId,
      row.sessionId,
      now,
      existingByThread.id,
    )
    return
  }
  const existingBySession = db.get<{ id: string }>(
    `SELECT id FROM channel_bindings WHERE session_id = ? AND channel = ? AND external_id = ?`,
    row.sessionId,
    row.channel,
    row.externalChatId,
  )
  if (existingBySession) {
    db.run(
      `UPDATE channel_bindings
       SET thread_id = ?, project_id = COALESCE(?, project_id), enabled = 1, updated_at = ?
       WHERE id = ?`,
      threadId,
      projectId,
      now,
      existingBySession.id,
    )
    return
  }
  db.run(
    `INSERT INTO channel_bindings (
       id, channel, external_id, thread_id, kind, project_id, session_id,
       enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'group', ?, ?, 1, ?, ?)`,
    randomUUID(),
    row.channel,
    row.externalChatId,
    threadId,
    projectId,
    row.sessionId,
    now,
    now,
  )
}

export interface OutboxRecord {
  id: string
  sessionId: string
  runId: string | null
  channel: string
  externalChatId: string
  threadId: string | null
  replyToMessageId: string | null
  kind: OutboxKind
  payload: {
    text: string
    title?: string
    forwardMessageId?: string
    files?: { path: string; name?: string; mimeType?: string }[]
  }
  status: OutboxStatus
  attempt: number
  externalMessageId: string | null
  lastError: string | null
  nextRetryAt: string | null
  createdAt: string
  sentAt: string | null
  updatedAt: string
}

export interface EnqueueOutboxInput {
  id?: string
  sessionId: string
  runId?: string | null
  channel: string
  externalChatId: string
  threadId?: string | null
  replyToMessageId?: string | null
  kind?: OutboxKind
  text: string
  title?: string
  forwardMessageId?: string
  files?: { path: string; name?: string; mimeType?: string }[]
}

type OutboxRow = {
  id: string
  session_id: string
  run_id: string | null
  channel: string
  external_chat_id: string
  thread_id: string | null
  reply_to_message_id: string | null
  kind: string
  payload_json: string
  status: string
  attempt: number
  external_message_id: string | null
  last_error: string | null
  next_retry_at: string | null
  created_at: string
  sent_at: string | null
  updated_at: string
}

function rowToOutbox(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    channel: row.channel,
    externalChatId: row.external_chat_id,
    threadId: row.thread_id,
    replyToMessageId: row.reply_to_message_id,
    kind: row.kind as OutboxKind,
    payload: JSON.parse(row.payload_json) as OutboxRecord['payload'],
    status: row.status as OutboxStatus,
    attempt: row.attempt,
    externalMessageId: row.external_message_id,
    lastError: row.last_error,
    nextRetryAt: row.next_retry_at,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    updatedAt: row.updated_at,
  }
}

export function enqueueOutboxInTx(
  db: VelaDatabase,
  input: EnqueueOutboxInput,
): OutboxRecord {
  const id = input.id ?? randomUUID()
  const now = new Date().toISOString()
  const payload = {
    text: input.text,
    ...(input.title ? { title: input.title } : {}),
    ...(input.forwardMessageId
      ? { forwardMessageId: input.forwardMessageId }
      : {}),
    ...(input.files?.length ? { files: input.files } : {}),
  }
  db.run(
    `INSERT INTO outbox (
       id, session_id, run_id, channel, external_chat_id, thread_id,
       reply_to_message_id, kind, payload_json, status, attempt,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    id,
    input.sessionId,
    input.runId ?? null,
    input.channel,
    input.externalChatId,
    input.threadId ?? null,
    input.replyToMessageId ?? null,
    input.kind ?? 'reply',
    JSON.stringify(payload),
    now,
    now,
  )
  const row = db.get<OutboxRow>('SELECT * FROM outbox WHERE id = ?', id)!
  return rowToOutbox(row)
}

/**
 * Idempotent outbound dispatcher over SQLite `outbox`.
 * Uses `outbox.id` as the stable delivery key across retries and crash restarts.
 */
export class OutboxDispatcher {
  private flushing: Promise<{ delivered: number; failed: number }> | undefined

  constructor(
    private readonly db: VelaDatabase,
    private readonly getAdapter: (
      channel: string,
    ) => ChannelAdapter | undefined,
    private readonly onScheduleChanged?: () => void,
    private readonly onTopicBound?: (sessionId: string) => void,
  ) {}

  recoverStaleSending(): number {
    const now = new Date().toISOString()
    return this.db.transaction(() => {
      const sendingRows = this.db.all<{ id: string }>(
        `SELECT id FROM outbox WHERE status = 'sending'`,
      )
      const liveTokens = new Set(LIVE_OUTBOX_LEASES.values())
      let recovered = 0
      for (const row of sendingRows) {
        const leaseRow = this.db.get<{ value_json: string }>(
          'SELECT value_json FROM kv_meta WHERE key = ?',
          leaseKey(row.id),
        )
        let activeLease: string | null = null
        if (leaseRow) {
          try {
            activeLease = JSON.parse(leaseRow.value_json) as string
          } catch {}
        }
        if (
          activeLease &&
          (LIVE_OUTBOX_LEASES.get(row.id) === activeLease ||
            isOwnerLive(activeLease, liveTokens))
        ) {
          continue
        }
        const res = this.db.run(
          `UPDATE outbox SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'sending'`,
          now,
          row.id,
        )
        this.db.run('DELETE FROM kv_meta WHERE key = ?', leaseKey(row.id))
        recovered += res.changes
      }
      return recovered
    })
  }

  listPending(channel?: string): OutboxRecord[] {
    const rows = channel
      ? (this.db.all<Record<string, unknown>>(
          `SELECT * FROM outbox WHERE status = 'pending' AND channel = ? ORDER BY created_at ASC`,
          channel,
        ) as unknown as OutboxRow[])
      : (this.db.all<Record<string, unknown>>(
          `SELECT * FROM outbox WHERE status = 'pending' ORDER BY created_at ASC`,
        ) as unknown as OutboxRow[])
    return rows.map(rowToOutbox)
  }

  listBySession(sessionId: string): OutboxRecord[] {
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT * FROM outbox WHERE session_id = ? ORDER BY created_at ASC`,
      sessionId,
    ) as unknown as OutboxRow[]
    return rows.map(rowToOutbox)
  }

  async flushOnce(
    nowMs = Date.now(),
  ): Promise<{ delivered: number; failed: number }> {
    if (this.flushing) return this.flushing
    this.flushing = this.runFlush(nowMs).finally(() => {
      this.flushing = undefined
    })
    return this.flushing
  }

  private async runFlush(
    nowMs: number,
  ): Promise<{ delivered: number; failed: number }> {
    const nowIso = new Date(nowMs).toISOString()
    let delivered = 0
    let failed = 0

    let retryScheduled = false
    for (;;) {
      const candidate = this.db.transaction(() => {
        const rows = this.db.all<Record<string, unknown>>(
          `SELECT * FROM outbox
           WHERE status = 'pending'
             AND (next_retry_at IS NULL OR next_retry_at <= ?)
           ORDER BY created_at ASC, rowid ASC`,
          nowIso,
        ) as unknown as OutboxRow[]
        for (const row of rows) {
          const adapter = this.getAdapter(row.channel)
          if (!adapter) continue
          const leaseToken = `${PROCESS_OWNER_PREFIX}:${process.pid}:${randomUUID()}`
          const claimed = this.db.run(
            `UPDATE outbox SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'pending'`,
            nowIso,
            row.id,
          )
          if (claimed.changes !== 1) continue
          this.db.run(
            `INSERT INTO kv_meta (key, value_json, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
            leaseKey(row.id),
            JSON.stringify(leaseToken),
            nowIso,
          )
          LIVE_OUTBOX_LEASES.set(row.id, leaseToken)
          return { row: rowToOutbox(row), adapter, leaseToken }
        }
        return undefined
      })

      if (!candidate) break

      const { row, adapter, leaseToken } = candidate
      const message: ChannelOutboundMessage = {
        outboxId: row.id,
        kind: row.kind,
        channel: row.channel,
        externalChatId: row.externalChatId,
        ...(row.threadId ? { threadId: row.threadId } : {}),
        ...(row.replyToMessageId
          ? { replyToMessageId: row.replyToMessageId }
          : {}),
        ...(row.payload.title ? { title: row.payload.title } : {}),
        ...(row.payload.forwardMessageId
          ? { forwardMessageId: row.payload.forwardMessageId }
          : {}),
        text: row.payload.text,
        ...(row.payload.files ? { files: row.payload.files } : {}),
      }

      try {
        const result = await adapter.deliver(message)
        const topicThreadId =
          row.kind === 'topic_start'
            ? (result.threadId ?? result.rootId ?? result.externalMessageId)
            : undefined
        if (row.kind === 'topic_start' && !topicThreadId) {
          throw new Error(
            'Channel adapter returned no threadId, rootId, or externalMessageId for topic_start',
          )
        }
        const sentAt = new Date().toISOString()
        const applied = this.db.transaction(() => {
          const leaseRow = this.db.get<{ value_json: string }>(
            'SELECT value_json FROM kv_meta WHERE key = ?',
            leaseKey(row.id),
          )
          if (!leaseRow) return false
          try {
            if (JSON.parse(leaseRow.value_json) !== leaseToken) return false
          } catch {
            return false
          }
          const updated = this.db.run(
            `UPDATE outbox
             SET status = 'sent',
                 external_message_id = ?,
                 sent_at = ?,
                 last_error = NULL,
                 next_retry_at = NULL,
                 updated_at = ?
             WHERE id = ? AND status = 'sending' AND attempt = ?`,
            result.externalMessageId ?? null,
            sentAt,
            sentAt,
            row.id,
            row.attempt,
          )
          if (
            updated.changes === 1 &&
            row.kind === 'topic_start' &&
            topicThreadId
          ) {
            syncTopicBindingOnDeliveryInTx(this.db, row, topicThreadId, sentAt)
          }
          this.db.run('DELETE FROM kv_meta WHERE key = ?', leaseKey(row.id))
          return updated.changes === 1
        })
        if (applied) {
          delivered++
          if (row.kind === 'topic_start') {
            this.onTopicBound?.(row.sessionId)
          }
        }
      } catch (error) {
        const attempt = row.attempt + 1
        const errorText = error instanceof Error ? error.message : String(error)
        const updatedAt = new Date().toISOString()
        const applied = this.db.transaction(() => {
          const leaseRow = this.db.get<{ value_json: string }>(
            'SELECT value_json FROM kv_meta WHERE key = ?',
            leaseKey(row.id),
          )
          if (!leaseRow) return false
          try {
            if (JSON.parse(leaseRow.value_json) !== leaseToken) return false
          } catch {
            return false
          }
          let ok = false
          if (attempt >= MAX_OUTBOX_ATTEMPTS) {
            ok =
              this.db.run(
                `UPDATE outbox
                 SET status = 'failed', attempt = ?, last_error = ?, next_retry_at = NULL, updated_at = ?
                 WHERE id = ? AND status = 'sending' AND attempt = ?`,
                attempt,
                errorText,
                updatedAt,
                row.id,
                row.attempt,
              ).changes === 1
          } else {
            const delayMs = BASE_RETRY_MS * 2 ** (attempt - 1)
            const nextRetryAt = new Date(nowMs + delayMs).toISOString()
            ok =
              this.db.run(
                `UPDATE outbox
                 SET status = 'pending', attempt = ?, last_error = ?, next_retry_at = ?, updated_at = ?
                 WHERE id = ? AND status = 'sending' AND attempt = ?`,
                attempt,
                errorText,
                nextRetryAt,
                updatedAt,
                row.id,
                row.attempt,
              ).changes === 1
            if (ok) retryScheduled = true
          }
          this.db.run('DELETE FROM kv_meta WHERE key = ?', leaseKey(row.id))
          return ok
        })
        if (applied) failed++
      } finally {
        if (LIVE_OUTBOX_LEASES.get(row.id) === leaseToken) {
          LIVE_OUTBOX_LEASES.delete(row.id)
        }
      }
    }

    if (retryScheduled) {
      this.onScheduleChanged?.()
    }
    return { delivered, failed }
  }
}
