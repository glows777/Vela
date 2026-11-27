import type { VelaDatabase } from '../db/index.ts'
import { errorMessage, type VelaLogger } from '../shared/logger.ts'
import {
  getActiveHubSession,
  isChannelBindingActive,
  isChannelEnabledInDb,
} from './channel-ingress.ts'
import type { ChannelAdapter } from './channels.ts'
import type {
  ChannelBindingStore,
  ProjectStore,
  SessionStoreControl,
} from './domain.ts'
import type { DriverInboxItem } from './driver.ts'
import { enqueueInboxEvent } from './inbox.ts'
import type { SubscriptionManager } from './subscriptions.ts'
import type { RuntimeWebhookEvent } from './webhooks/github-events.ts'
import type { OutboxTarget } from './worker.ts'

const WEBHOOK_DELIVERY_PREFIX = 'webhook_delivery:'
const MAX_WEBHOOK_DELIVERIES = 2000

function recordWebhookDeliveryInTx(db: VelaDatabase, key: string): void {
  db.run(
    `INSERT OR IGNORE INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?)`,
    key,
    '1',
    new Date().toISOString(),
  )
  const countRow = db.get<{ cnt: number }>(
    `SELECT count(*) AS cnt FROM kv_meta WHERE key LIKE ?`,
    `${WEBHOOK_DELIVERY_PREFIX}%`,
  )
  const cnt = countRow?.cnt ?? 0
  if (cnt > MAX_WEBHOOK_DELIVERIES) {
    const excess = cnt - MAX_WEBHOOK_DELIVERIES
    db.run(
      `DELETE FROM kv_meta WHERE key IN (
         SELECT key FROM kv_meta WHERE key LIKE ? ORDER BY updated_at ASC, rowid ASC LIMIT ?
       )`,
      `${WEBHOOK_DELIVERY_PREFIX}%`,
      excess,
    )
  }
}

function isSessionDeliverableForWebhook(
  db: VelaDatabase,
  bindings: ChannelBindingStore,
  sessions: SessionStoreControl,
  sessionId: string,
): boolean {
  const directRows = db.all<{ id: string }>(
    `SELECT id FROM channel_bindings WHERE session_id = ?`,
    sessionId,
  )
  if (directRows.length > 0) {
    return directRows.some((row) => {
      const binding = bindings.get(row.id)
      return Boolean(binding && isChannelBindingActive(db, bindings, binding))
    })
  }
  const session = sessions.get(sessionId)
  if (session?.projectId && session.kind === 'hub') {
    const rootRows = db.all<{ id: string }>(
      `SELECT id FROM channel_bindings WHERE project_id = ? AND thread_id IS NULL`,
      session.projectId,
    )
    if (rootRows.length > 0) {
      return rootRows.some((row) => {
        const binding = bindings.get(row.id)
        return Boolean(binding && isChannelBindingActive(db, bindings, binding))
      })
    }
  }
  return true
}

export function ingestWebhookEventInRuntime(params: {
  db: VelaDatabase
  projects: ProjectStore
  sessions: SessionStoreControl
  bindings: ChannelBindingStore
  subscriptions: SubscriptionManager
  channels?: ReadonlyMap<string, ChannelAdapter>
  scheduleSession: (sessionId: string) => void
  logger?: VelaLogger
  event: RuntimeWebhookEvent
  defaultTarget?: { channel: string; chatId: string }
}): {
  matchedSessionIds: string[]
  defaultTargetSessionId?: string
  enqueuedCount: number
} {
  const {
    db,
    projects,
    sessions,
    bindings,
    subscriptions,
    channels,
    scheduleSession,
    logger,
    event,
    defaultTarget,
  } = params
  const canonicalKey =
    event.source === 'github' ? event.key.toLowerCase() : event.key
  const deliveryRecordKey = `${WEBHOOK_DELIVERY_PREFIX}${event.source}:${event.deliveryId}:${canonicalKey}`
  const toSchedule = new Set<string>()
  const result = db.transaction(() => {
    const prior = db.get<{ key: string }>(
      'SELECT key FROM kv_meta WHERE key = ?',
      deliveryRecordKey,
    )
    if (prior) {
      return {
        matchedSessionIds: [] as string[],
        enqueuedCount: 0,
      }
    }
    const dispatched = subscriptions.dispatchEvent({
      source: event.source,
      eventKey: event.key,
      dedupeKey: event.deliveryId,
      summary: event.summary,
      details: event.details,
      final: event.final,
      shouldDeliverSession: (sid) =>
        isSessionDeliverableForWebhook(db, bindings, sessions, sid),
    })
    for (const sid of dispatched.matchedSessionIds) toSchedule.add(sid)

    if (dispatched.matchedCount > 0) {
      recordWebhookDeliveryInTx(db, deliveryRecordKey)
      return {
        matchedSessionIds: dispatched.matchedSessionIds,
        enqueuedCount: dispatched.enqueuedCount,
      }
    }
    if (!defaultTarget) {
      return {
        matchedSessionIds: dispatched.matchedSessionIds,
        enqueuedCount: dispatched.enqueuedCount,
      }
    }
    const channel = defaultTarget.channel.trim()
    const chatId = defaultTarget.chatId.trim()
    if (!channel || !chatId || !isChannelEnabledInDb(db, channel)) {
      return {
        matchedSessionIds: dispatched.matchedSessionIds,
        enqueuedCount: dispatched.enqueuedCount,
      }
    }

    const binding = bindings.findByExternal(channel, chatId)
    if (!binding || !isChannelBindingActive(db, bindings, binding)) {
      return {
        matchedSessionIds: dispatched.matchedSessionIds,
        enqueuedCount: dispatched.enqueuedCount,
      }
    }
    if (channels && binding.kind === 'group' && !binding.threadId) {
      const adapter = channels.get(channel)
      if (adapter && !adapter.announce) {
        logger?.warn(
          `[${channel}] Skipping unmatched webhook ${event.key}: default group target requires a connected channel with announce()`,
        )
        return {
          matchedSessionIds: dispatched.matchedSessionIds,
          enqueuedCount: dispatched.enqueuedCount,
        }
      }
    }
    const targetSession = binding.sessionId
      ? sessions.get(binding.sessionId)
      : binding.projectId
        ? getActiveHubSession(db, projects, sessions, binding.projectId)
        : undefined
    if (!targetSession) {
      return {
        matchedSessionIds: dispatched.matchedSessionIds,
        enqueuedCount: dispatched.enqueuedCount,
      }
    }

    const enqueued = enqueueInboxEvent(db, {
      sessionId: targetSession.id,
      projectId: binding.projectId ?? targetSession.projectId,
      source: 'webhook',
      dedupeKey: `${event.source}:${event.deliveryId}:${event.key}:default:${targetSession.id}`,
      wake: true,
      payload: {
        type: 'webhook',
        eventSource: event.source,
        eventKey: event.key,
        deliveryId: event.deliveryId,
        summary: event.summary,
        ...(event.details !== undefined ? { details: event.details } : {}),
        ...(event.final !== undefined ? { final: event.final } : {}),
        isDefaultTarget: true,
        channel,
        externalChatId: chatId,
      },
    })
    recordWebhookDeliveryInTx(db, deliveryRecordKey)
    if (enqueued.inserted) {
      toSchedule.add(targetSession.id)
    }
    return {
      matchedSessionIds: dispatched.matchedSessionIds,
      defaultTargetSessionId: targetSession.id,
      enqueuedCount: dispatched.enqueuedCount + (enqueued.inserted ? 1 : 0),
    }
  })

  for (const sid of toSchedule) {
    scheduleSession(sid)
  }
  return result
}

function buildAnnouncementText(item: DriverInboxItem): string | undefined {
  const p = item.payload
  if (item.source === 'timer' && p.kind === 'routine') {
    const firedMs = Date.parse(String(p.firedAt ?? ''))
    const scheduledMs = Date.parse(String(p.scheduledAt ?? ''))
    const lateByMs =
      Number.isFinite(firedMs) && Number.isFinite(scheduledMs)
        ? Math.max(0, firedMs - scheduledMs)
        : 0
    const late =
      lateByMs > 0 ? `; late by ${Math.ceil(lateByMs / 1000)} seconds` : ''
    const creator =
      typeof p.creatorName === 'string' && p.creatorName.trim()
        ? p.creatorName.trim()
        : 'Vela'
    return `⏰ ${String(p.message ?? '')} (set by ${creator}${late})`
  }
  if (item.source === 'webhook' && p.isDefaultTarget === true) {
    const header = `[Event ${String(p.eventSource ?? 'webhook')}:${String(p.eventKey ?? '')}] ${String(p.summary ?? '')}`
    return header.replace(/\s+/g, ' ').trim().slice(0, 500)
  }
  return undefined
}

/**
 * Posts a required top-level group announcement (routine `⏰` header or unmatched
 * `eventDefaultTarget` external event) before invoking the agent driver.
 * If announcement fails (or is unavailable for default-target webhooks / disabled channels), skips the turn cleanly.
 */
export async function prepareTurnAnnouncement(params: {
  db: VelaDatabase
  runId: string
  trigger: string
  inputs: DriverInboxItem[]
  outboxTarget: OutboxTarget | undefined
  getChannelAdapter: (name: string) => ChannelAdapter | undefined
  isChannelEnabled?: (name: string) => boolean
  abortSignal?: AbortSignal
  logger: VelaLogger
}): Promise<{
  skipTurn: boolean
  deferTurn?: boolean
  outboxTarget: OutboxTarget | undefined
  inputs: DriverInboxItem[]
}> {
  const {
    db,
    runId,
    inputs,
    outboxTarget,
    getChannelAdapter,
    isChannelEnabled,
    abortSignal,
    logger,
  } = params
  if (!outboxTarget || outboxTarget.threadId || outboxTarget.replyToMessageId) {
    return { skipTurn: false, outboxTarget, inputs }
  }
  let triggerItem: DriverInboxItem | undefined
  let text: string | undefined
  for (let i = inputs.length - 1; i >= 0; i--) {
    const candidate = inputs[i]!
    const p = candidate.payload
    if (
      p.channel !== outboxTarget.channel ||
      p.externalChatId !== outboxTarget.externalChatId ||
      (typeof p.threadId === 'string' ? p.threadId : undefined) !==
        outboxTarget.threadId
    ) {
      continue
    }
    const built = buildAnnouncementText(candidate)
    if (built !== undefined) {
      triggerItem = candidate
      text = built
      break
    }
  }
  if (!triggerItem || !text) {
    return { skipTurn: false, outboxTarget, inputs }
  }
  if (isChannelEnabled && !isChannelEnabled(outboxTarget.channel)) {
    logger.warn(
      `[${outboxTarget.channel}] Announcement skipped: channel is disabled`,
    )
    return { skipTurn: true, outboxTarget: undefined, inputs }
  }
  const rootBinding = db.get<{ kind: string; enabled: number }>(
    `SELECT kind, enabled FROM channel_bindings
     WHERE channel = ? AND external_id = ? AND thread_id IS NULL
     ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    outboxTarget.channel,
    outboxTarget.externalChatId,
  )
  if (rootBinding?.kind === 'direct') {
    return { skipTurn: false, outboxTarget, inputs }
  }
  if (rootBinding && rootBinding.enabled === 0) {
    logger.warn(
      `[${outboxTarget.channel}] Announcement skipped: binding is disabled`,
    )
    return { skipTurn: true, outboxTarget: undefined, inputs }
  }
  const adapter = getChannelAdapter(outboxTarget.channel)
  if (!adapter) {
    if (
      triggerItem.source === 'webhook' &&
      triggerItem.payload.isDefaultTarget === true
    ) {
      logger.warn(
        `[${outboxTarget.channel}] Announcement deferred: channel adapter is not yet registered`,
      )
      return {
        skipTurn: false,
        deferTurn: true,
        outboxTarget: undefined,
        inputs,
      }
    }
    return { skipTurn: false, outboxTarget, inputs }
  }
  if (!adapter.announce) {
    if (
      triggerItem.source === 'webhook' &&
      triggerItem.payload.isDefaultTarget === true
    ) {
      logger.warn(
        `[${outboxTarget.channel}] Announcement skipped: default webhook target requires connected channel announce()`,
      )
      return { skipTurn: true, outboxTarget: undefined, inputs }
    }
    return { skipTurn: false, outboxTarget, inputs }
  }

  const receiptKey = `announce_receipt:${triggerItem.id}`
  const existing = db.get<{ value_json: string }>(
    'SELECT value_json FROM kv_meta WHERE key = ?',
    receiptKey,
  )
  let replyToMessageId: string | undefined
  if (existing) {
    try {
      const parsed = JSON.parse(existing.value_json) as {
        externalMessageId?: unknown
      }
      if (
        typeof parsed.externalMessageId === 'string' &&
        parsed.externalMessageId
      ) {
        replyToMessageId = parsed.externalMessageId
      }
    } catch {}
  }

  if (!replyToMessageId) {
    try {
      const timeoutSignal = AbortSignal.timeout(30_000)
      const signal = abortSignal
        ? AbortSignal.any([abortSignal, timeoutSignal])
        : timeoutSignal
      const result = await adapter.announce({
        externalChatId: outboxTarget.externalChatId,
        text,
        idempotencyKey: triggerItem.id,
        signal,
      })
      replyToMessageId = result?.externalMessageId
      if (!replyToMessageId) {
        logger.warn(
          `[${outboxTarget.channel}] Announcement skipped: top-level delivery requires a message receipt`,
        )
        return { skipTurn: true, outboxTarget: undefined, inputs }
      }
      db.run(
        `INSERT INTO kv_meta (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        receiptKey,
        JSON.stringify({ externalMessageId: replyToMessageId }),
        new Date().toISOString(),
      )
    } catch (error) {
      logger.warn(
        `[${outboxTarget.channel}] Announcement failed: ${errorMessage(error)}`,
      )
      return { skipTurn: true, outboxTarget: undefined, inputs }
    }
  }

  const nextTarget: OutboxTarget = { ...outboxTarget, replyToMessageId }
  db.run(
    `INSERT INTO kv_meta (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    `run_target:${runId}`,
    JSON.stringify(nextTarget),
    new Date().toISOString(),
  )
  const nextInputs = inputs.map((item) =>
    item.id === triggerItem!.id
      ? {
          ...item,
          payload: { ...item.payload, replyToMessageId },
        }
      : item,
  )
  return { skipTurn: false, outboxTarget: nextTarget, inputs: nextInputs }
}
