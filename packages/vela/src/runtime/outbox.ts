import { randomUUID } from 'node:crypto'
import type { VelaDatabase } from '../db/index.ts'
import type { ChannelAdapter, ChannelOutboundMessage } from './channels.ts'

type OutboxKind = 'reply' | 'topic_start' | 'forward' | 'file'
type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled'

export const MAX_OUTBOX_ATTEMPTS = 5
const BASE_RETRY_MS = 1_000

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
  ) {}

  recoverStaleSending(): number {
    const res = this.db.run(
      `UPDATE outbox
       SET status = 'pending', updated_at = ?
       WHERE status = 'sending'`,
      new Date().toISOString(),
    )
    return res.changes
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
          this.db.run(
            `UPDATE outbox SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'pending'`,
            nowIso,
            row.id,
          )
          return { row: rowToOutbox(row), adapter }
        }
        return undefined
      })

      if (!candidate) break

      const { row, adapter } = candidate
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
        const sentAt = new Date().toISOString()
        this.db.run(
          `UPDATE outbox
           SET status = 'sent',
               external_message_id = ?,
               sent_at = ?,
               last_error = NULL,
               next_retry_at = NULL,
               updated_at = ?
           WHERE id = ?`,
          result.externalMessageId ?? null,
          sentAt,
          sentAt,
          row.id,
        )
        delivered++
      } catch (error) {
        const attempt = row.attempt + 1
        const errorText = error instanceof Error ? error.message : String(error)
        const updatedAt = new Date().toISOString()
        if (attempt >= MAX_OUTBOX_ATTEMPTS) {
          this.db.run(
            `UPDATE outbox
             SET status = 'failed', attempt = ?, last_error = ?, next_retry_at = NULL, updated_at = ?
             WHERE id = ?`,
            attempt,
            errorText,
            updatedAt,
            row.id,
          )
        } else {
          const delayMs = BASE_RETRY_MS * 2 ** (attempt - 1)
          const nextRetryAt = new Date(nowMs + delayMs).toISOString()
          this.db.run(
            `UPDATE outbox
             SET status = 'pending', attempt = ?, last_error = ?, next_retry_at = ?, updated_at = ?
             WHERE id = ?`,
            attempt,
            errorText,
            nextRetryAt,
            updatedAt,
            row.id,
          )
        }
        failed++
      }
    }

    return { delivered, failed }
  }
}
