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

function mergeBindingConfigJson(
  existingJson: string | null | undefined,
  rootId: string | undefined,
): string | null {
  if (!rootId) return existingJson ?? null
  let parsed: Record<string, unknown> = {}
  if (existingJson) {
    try {
      const candidate = JSON.parse(existingJson) as unknown
      if (
        candidate &&
        typeof candidate === 'object' &&
        !Array.isArray(candidate)
      ) {
        parsed = candidate as Record<string, unknown>
      }
    } catch {}
  }
  return JSON.stringify({ ...parsed, rootId })
}

function syncTopicBindingOnDeliveryInTx(
  db: VelaDatabase,
  row: OutboxRecord,
  threadId: string,
  now: string,
  rootId?: string,
): void {
  const session = db.get<{ project_id: string | null }>(
    'SELECT project_id FROM sessions WHERE id = ?',
    row.sessionId,
  )
  const projectId = session?.project_id ?? null
  const existingByThread = db.get<{ id: string; config_json: string | null }>(
    `SELECT id, config_json FROM channel_bindings WHERE channel = ? AND external_id = ? AND thread_id = ?`,
    row.channel,
    row.externalChatId,
    threadId,
  )
  if (existingByThread) {
    db.run(
      `UPDATE channel_bindings
       SET project_id = COALESCE(?, project_id), session_id = ?, enabled = 1, config_json = ?, updated_at = ?
       WHERE id = ?`,
      projectId,
      row.sessionId,
      mergeBindingConfigJson(existingByThread.config_json, rootId),
      now,
      existingByThread.id,
    )
    return
  }
  const existingBySession = db.get<{ id: string; config_json: string | null }>(
    `SELECT id, config_json FROM channel_bindings WHERE session_id = ? AND channel = ? AND external_id = ?`,
    row.sessionId,
    row.channel,
    row.externalChatId,
  )
  if (existingBySession) {
    db.run(
      `UPDATE channel_bindings
       SET thread_id = ?, project_id = COALESCE(?, project_id), enabled = 1, config_json = ?, updated_at = ?
       WHERE id = ?`,
      threadId,
      projectId,
      mergeBindingConfigJson(existingBySession.config_json, rootId),
      now,
      existingBySession.id,
    )
    return
  }
  db.run(
    `INSERT INTO channel_bindings (
       id, channel, external_id, thread_id, kind, project_id, session_id,
       enabled, config_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'group', ?, ?, 1, ?, ?, ?)`,
    randomUUID(),
    row.channel,
    row.externalChatId,
    threadId,
    projectId,
    row.sessionId,
    mergeBindingConfigJson(null, rootId),
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
    recipientId?: string
    mentionRecipient?: boolean
    isRoutine?: boolean
    isHandoff?: boolean
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
  recipientId?: string
  mentionRecipient?: boolean
  isRoutine?: boolean
  isHandoff?: boolean
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

function isOutboxBindingDisabledInDb(
  db: VelaDatabase,
  row: OutboxRow,
): boolean {
  const exactDisabled = db.get<{ id: string }>(
    `SELECT id FROM channel_bindings
     WHERE channel = ? AND external_id = ? AND thread_id IS ? AND enabled = 0
     LIMIT 1`,
    row.channel,
    row.external_chat_id,
    row.thread_id,
  )
  if (exactDisabled) return true
  if (row.thread_id) {
    const rootDisabled = db.get<{ id: string }>(
      `SELECT id FROM channel_bindings
       WHERE channel = ? AND external_id = ? AND thread_id IS NULL AND enabled = 0
       LIMIT 1`,
      row.channel,
      row.external_chat_id,
    )
    if (rootDisabled) return true
  }
  return false
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
    ...(input.recipientId ? { recipientId: input.recipientId } : {}),
    ...(input.mentionRecipient ? { mentionRecipient: true } : {}),
    ...(input.isRoutine ? { isRoutine: true } : {}),
    ...(input.isHandoff ? { isHandoff: true } : {}),
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
  private flushAgain = false
  private readonly inFlightByChannel = new Map<string, Set<Promise<void>>>()

  constructor(
    private readonly db: VelaDatabase,
    private readonly getAdapter: (
      channel: string,
    ) => ChannelAdapter | undefined,
    private readonly onScheduleChanged?: () => void,
    private readonly onTopicBound?: (sessionId: string) => void,
    private readonly onDelivered?: (info: {
      channel: string
      externalChatId: string
      sessionId: string
      threadId?: string | null
    }) => void,
  ) {}

  recoverStaleSending(excludeChannels?: ReadonlySet<string>): number {
    const now = new Date().toISOString()
    return this.db.transaction(() => {
      const sendingRows = this.db.all<{ id: string; channel: string }>(
        `SELECT id, channel FROM outbox WHERE status = 'sending'`,
      )
      const liveTokens = new Set(LIVE_OUTBOX_LEASES.values())
      let recovered = 0
      for (const row of sendingRows) {
        if (excludeChannels?.has(row.channel)) continue
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

  /**
   * Returns the earliest pending wake timestamp among deliverable `(session_id, channel)` FIFO queue heads,
   * skipping followers blocked behind an in-flight or backing-off queue head.
   */
  nextPendingWakeAt(channels: readonly string[]): string | null {
    if (channels.length === 0) return null
    const allowed = new Set(channels)
    const rows = this.db.all<{
      session_id: string | null
      channel: string
      status: string
      next_retry_at: string | null
      created_at: string
    }>(
      `SELECT session_id, channel, status, next_retry_at, created_at
       FROM outbox
       WHERE status IN ('pending', 'sending')
       ORDER BY created_at ASC, rowid ASC`,
    )
    const seenHeads = new Set<string>()
    let earliest: string | null = null
    let earliestMs = Number.POSITIVE_INFINITY
    for (const row of rows) {
      const fifoKey = `${row.session_id}:${row.channel}`
      if (seenHeads.has(fifoKey)) continue
      seenHeads.add(fifoKey)
      if (row.status !== 'pending' || !allowed.has(row.channel)) continue
      const candidate = row.next_retry_at ?? row.created_at
      const ms = Date.parse(candidate)
      if (Number.isFinite(ms) && ms < earliestMs) {
        earliestMs = ms
        earliest = candidate
      }
    }
    return earliest
  }

  listBySession(sessionId: string): OutboxRecord[] {
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT * FROM outbox WHERE session_id = ? ORDER BY created_at ASC`,
      sessionId,
    ) as unknown as OutboxRow[]
    return rows.map(rowToOutbox)
  }

  async flushOnce(
    nowMs?: number,
  ): Promise<{ delivered: number; failed: number }> {
    if (this.flushing) {
      this.flushAgain = true
      return this.flushing
    }
    this.flushAgain = false
    this.flushing = (async () => {
      let delivered = 0
      let failed = 0
      do {
        this.flushAgain = false
        const pass = await this.runFlush(nowMs)
        delivered += pass.delivered
        failed += pass.failed
      } while (this.flushAgain)
      return { delivered, failed }
    })().finally(() => {
      this.flushing = undefined
    })
    return this.flushing
  }

  async drain(): Promise<void> {
    while (this.flushing) {
      await this.flushing.catch(() => {})
    }
  }

  async drainChannel(channel: string): Promise<void> {
    for (;;) {
      const active = this.inFlightByChannel.get(channel)
      if (!active || active.size === 0) return
      await Promise.allSettled([...active])
    }
  }

  private async runFlush(
    fixedNowMs?: number,
  ): Promise<{ delivered: number; failed: number }> {
    const clock = () => fixedNowMs ?? Date.now()
    let delivered = 0
    let failed = 0

    let retryScheduled = false
    for (;;) {
      const stepNowMs = clock()
      const stepNowIso = new Date(stepNowMs).toISOString()
      const candidate = this.db.transaction(() => {
        const rows = this.db.all<Record<string, unknown>>(
          `SELECT * FROM outbox
           WHERE status IN ('pending', 'sending')
           ORDER BY created_at ASC, rowid ASC`,
        ) as unknown as OutboxRow[]
        const blockedSessionChannels = new Set<string>()
        for (const row of rows) {
          const fifoKey = `${row.session_id}:${row.channel}`
          if (row.status === 'sending') {
            blockedSessionChannels.add(fifoKey)
            continue
          }
          if (blockedSessionChannels.has(fifoKey)) continue
          if (row.next_retry_at !== null && row.next_retry_at > stepNowIso) {
            blockedSessionChannels.add(fifoKey)
            continue
          }
          if (isOutboxBindingDisabledInDb(this.db, row)) {
            this.db.run(
              `UPDATE outbox
               SET status = 'failed', last_error = ?, next_retry_at = NULL, updated_at = ?
               WHERE id = ? AND status = 'pending'`,
              'Channel binding is disabled',
              stepNowIso,
              row.id,
            )
            this.getAdapter(row.channel)?.onDeliverySettled?.({
              outboxId: row.id,
              ...(row.run_id ? { runId: row.run_id } : {}),
              kind: row.kind,
              status: 'failed',
            })
            continue
          }
          const adapter = this.getAdapter(row.channel)
          if (!adapter) continue
          const leaseToken = `${PROCESS_OWNER_PREFIX}:${process.pid}:${randomUUID()}`
          const claimed = this.db.run(
            `UPDATE outbox SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'pending'`,
            stepNowIso,
            row.id,
          )
          if (claimed.changes !== 1) continue
          this.db.run(
            `INSERT INTO kv_meta (key, value_json, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
            leaseKey(row.id),
            JSON.stringify(leaseToken),
            stepNowIso,
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
        ...(row.runId ? { runId: row.runId } : {}),
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
        ...(row.payload.recipientId
          ? { recipientId: row.payload.recipientId }
          : {}),
        ...(row.payload.mentionRecipient ? { mentionRecipient: true } : {}),
        ...(row.payload.isRoutine ? { isRoutine: true } : {}),
        ...(row.payload.isHandoff ? { isHandoff: true } : {}),
        text: row.payload.text,
        ...(row.payload.files ? { files: row.payload.files } : {}),
      }

      const channel = row.channel
      let activeSet = this.inFlightByChannel.get(channel)
      if (!activeSet) {
        activeSet = new Set<Promise<void>>()
        this.inFlightByChannel.set(channel, activeSet)
      }
      const delivery = (async () => {
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
              syncTopicBindingOnDeliveryInTx(
                this.db,
                row,
                topicThreadId,
                sentAt,
                result.rootId,
              )
            }
            this.db.run('DELETE FROM kv_meta WHERE key = ?', leaseKey(row.id))
            return updated.changes === 1
          })
          if (applied) {
            delivered++
            adapter.onDeliverySettled?.({
              outboxId: row.id,
              ...(row.runId ? { runId: row.runId } : {}),
              kind: row.kind,
              status: 'sent',
            })
            if (row.kind === 'topic_start') {
              this.onTopicBound?.(row.sessionId)
            }
            this.onDelivered?.({
              channel: row.channel,
              externalChatId: row.externalChatId,
              sessionId: row.sessionId,
              threadId: topicThreadId ?? row.threadId,
            })
          }
        } catch (error) {
          const attempt = row.attempt + 1
          const errorText =
            error instanceof Error ? error.message : String(error)
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
              if (ok && row.kind === 'topic_start' && row.sessionId) {
                this.db.run(
                  `UPDATE inbox_events
                 SET status = 'dropped', processed_at = COALESCE(processed_at, ?)
                 WHERE session_id = ? AND status = 'pending'`,
                  updatedAt,
                  row.sessionId,
                )
                const child = this.db.get<{
                  name: string | null
                  project_id: string | null
                  parent_session_id: string | null
                }>(
                  'SELECT name, project_id, parent_session_id FROM sessions WHERE id = ?',
                  row.sessionId,
                )
                const parentId =
                  child?.parent_session_id ??
                  (child?.project_id
                    ? this.db.get<{ hub_session_id: string | null }>(
                        'SELECT hub_session_id FROM projects WHERE id = ?',
                        child.project_id,
                      )?.hub_session_id
                    : undefined)
                if (parentId) {
                  const label = child?.name
                    ? `"${child.name}" (${row.sessionId})`
                    : row.sessionId
                  this.db.run(
                    `INSERT OR IGNORE INTO inbox_events (
                     id, session_id, project_id, source, dedupe_key, wake, passive, payload_json, status, created_at
                   ) VALUES (?, ?, ?, 'handoff', ?, 0, 0, ?, 'pending', ?)`,
                    randomUUID(),
                    parentId,
                    child?.project_id ?? null,
                    `topic-failed:${row.id}`,
                    JSON.stringify({
                      type: 'handoff_note',
                      childSessionId: row.sessionId,
                      status: 'failed',
                      text: `${label} failed to open its topic thread: ${errorText}`,
                    }),
                    updatedAt,
                  )
                }
              }
            } else {
              const delayMs = BASE_RETRY_MS * 2 ** (attempt - 1)
              const nextRetryAt = new Date(clock() + delayMs).toISOString()
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
          if (applied) {
            failed++
            if (attempt >= MAX_OUTBOX_ATTEMPTS) {
              adapter.onDeliverySettled?.({
                outboxId: row.id,
                ...(row.runId ? { runId: row.runId } : {}),
                kind: row.kind,
                status: 'failed',
              })
            }
          }
        } finally {
          if (LIVE_OUTBOX_LEASES.get(row.id) === leaseToken) {
            LIVE_OUTBOX_LEASES.delete(row.id)
          }
        }
      })().finally(() => {
        activeSet.delete(delivery)
        if (activeSet.size === 0) {
          this.inFlightByChannel.delete(channel)
        }
      })
      activeSet.add(delivery)
      await delivery
    }

    if (retryScheduled) {
      this.onScheduleChanged?.()
    }
    return { delivered, failed }
  }
}
