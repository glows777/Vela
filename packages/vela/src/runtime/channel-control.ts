import type { VelaDatabase } from '../db/index.ts'
import { errorMessage, type VelaLogger } from '../shared/logger.ts'
import {
  getActiveHubSession,
  ingestChannelMessageInRuntime,
  isChannelEnabledInDb,
  setChannelEnabledInDb,
} from './channel-ingress.ts'
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelBinding,
  ChannelHostSubmitInput,
  ChannelHostSubmitResult,
  ChannelStatusInfo,
  ChannelToolSpec,
} from './channels.ts'
import type {
  ChannelBindingStore,
  ProjectStore,
  SessionRecord,
  SessionStoreControl,
} from './domain.ts'
import type { DriverInboxItem } from './driver.ts'
import { enqueueInboxEvent } from './inbox.ts'
import {
  listRuntimeSessionMessages,
  type RuntimeMessagePage,
} from './messages.ts'
import type { SubscriptionManager } from './subscriptions.ts'
import type { RuntimeWebhookEvent } from './webhooks/github-events.ts'
import type { OutboxTarget } from './worker.ts'

export function createChannelAdapterContext(params: {
  db: VelaDatabase
  blobs: import('./blobs.ts').BlobStore
  projects: ProjectStore
  sessions: SessionStoreControl
  bindings: ChannelBindingStore
  eventBus: import('./event-bus.ts').RuntimeEventBus
  inFlightDeliveries: Set<string>
  adapter: ChannelAdapter
  executeShortcut: (input: {
    command: import('./shortcuts.ts').ControlShortcut
    sessionId: string
    projectId?: string | null
  }) => Promise<{ text: string; stopped?: boolean }>
  scheduleSession: (sessionId: string) => void
  stopSession: (sessionId: string, reason?: string) => Promise<boolean>
  steerSession: (sessionId: string, text: string) => Promise<void>
}): ChannelAdapterContext {
  return {
    ingest: (message) =>
      ingestChannelMessageInRuntime({
        db: params.db,
        blobs: params.blobs,
        projects: params.projects,
        sessions: params.sessions,
        bindings: params.bindings,
        eventBus: params.eventBus,
        inFlightDeliveries: params.inFlightDeliveries,
        adapter: params.adapter,
        msg: message,
        executeShortcut: params.executeShortcut,
        scheduleSession: params.scheduleSession,
      }),
    subscribeEvents: (listener) => params.eventBus.subscribeEvents(listener),
    subscribeDeltas: (listener) => params.eventBus.subscribeDeltas(listener),
    stopSession: params.stopSession,
    steerSession: params.steerSession,
    listBindings: (filter) => params.bindings.list(filter),
    getSession: (id) => params.sessions.get(id),
    getProject: (id) => params.projects.get(id),
  }
}

export { isChannelEnabledInDb, setChannelEnabledInDb }

const CHANNEL_CURSOR_PREFIX = 'ch:'
const DB_CURSOR_PREFIX = 'db:'
const WEBHOOK_DELIVERY_PREFIX = 'webhook_delivery:'
const MAX_WEBHOOK_DELIVERIES = 2000

function isRootGroupDisabled(
  bindings: ChannelBindingStore,
  binding: ChannelBinding,
): boolean {
  if (!binding.threadId) return false
  const root = bindings.findByExternal(binding.channel, binding.externalId)
  return Boolean(root && !root.enabled)
}

function isBindingActive(
  db: VelaDatabase,
  bindings: ChannelBindingStore,
  binding: ChannelBinding,
): boolean {
  return (
    binding.enabled &&
    isChannelEnabledInDb(db, binding.channel) &&
    !isRootGroupDisabled(bindings, binding)
  )
}

function encodeChannelCursor(binding: ChannelBinding, cursor: string): string {
  return `${CHANNEL_CURSOR_PREFIX}${encodeURIComponent(binding.channel)}:${encodeURIComponent(binding.id)}:${cursor}`
}

function decodeChannelCursor(
  binding: ChannelBinding,
  cursor: string | undefined,
): string | undefined {
  if (!cursor?.startsWith(CHANNEL_CURSOR_PREFIX)) return cursor
  const rest = cursor.slice(CHANNEL_CURSOR_PREFIX.length)
  const firstSep = rest.indexOf(':')
  const secondSep = firstSep === -1 ? -1 : rest.indexOf(':', firstSep + 1)
  if (firstSep === -1 || secondSep === -1) {
    throw new Error(
      'Invalid channel pagination cursor; restart pagination from the beginning',
    )
  }
  const cursorChannel = decodeURIComponent(rest.slice(0, firstSep))
  const cursorBindingId = decodeURIComponent(
    rest.slice(firstSep + 1, secondSep),
  )
  if (cursorChannel !== binding.channel || cursorBindingId !== binding.id) {
    throw new Error(
      'Pagination cursor belongs to a different channel binding; restart pagination from the beginning',
    )
  }
  return rest.slice(secondSep + 1)
}

function resolveSessionChannelBinding(
  db: VelaDatabase,
  bindings: ChannelBindingStore,
  session: SessionRecord,
): ChannelBinding | undefined {
  const directRows = db.all<{ id: string }>(
    `SELECT id FROM channel_bindings
     WHERE session_id = ? AND enabled = 1
     ORDER BY created_at ASC, rowid ASC`,
    session.id,
  )
  for (const row of directRows) {
    const binding = bindings.get(row.id)
    if (binding && isBindingActive(db, bindings, binding)) return binding
  }
  if (session.projectId && session.kind === 'hub') {
    const rootRows = db.all<{ id: string }>(
      `SELECT id FROM channel_bindings
       WHERE project_id = ? AND thread_id IS NULL AND enabled = 1
       ORDER BY created_at ASC, rowid ASC`,
      session.projectId,
    )
    for (const row of rootRows) {
      const binding = bindings.get(row.id)
      if (binding && isBindingActive(db, bindings, binding)) return binding
    }
  }
  return undefined
}

export async function listRuntimeOrChannelMessages(
  db: VelaDatabase,
  sessions: SessionStoreControl,
  bindings: ChannelBindingStore,
  channels: ReadonlyMap<string, ChannelAdapter>,
  input: { sessionId: string; cursor?: string; limit?: number },
): Promise<RuntimeMessagePage> {
  const session = sessions.get(input.sessionId)
  if (!session) throw new Error(`Session ${input.sessionId} not found`)
  const binding = resolveSessionChannelBinding(db, bindings, session)
  if (binding) {
    const adapter = channels.get(binding.channel)
    if (adapter?.listMessages) {
      if (
        input.cursor &&
        (input.cursor.startsWith(DB_CURSOR_PREFIX) ||
          /^\d+$/.test(input.cursor))
      ) {
        throw new Error(
          'Pagination cursor is no longer valid because the message source changed to channel; restart pagination from the beginning',
        )
      }
      const rawCursor = decodeChannelCursor(binding, input.cursor)
      const page = await adapter.listMessages({
        sessionId: session.id,
        externalChatId: binding.externalId,
        threadId: binding.threadId,
        kind: binding.kind,
        cursor: rawCursor,
        limit: input.limit,
      })
      return {
        ...page,
        ...(page.nextCursor
          ? { nextCursor: encodeChannelCursor(binding, page.nextCursor) }
          : {}),
      }
    }
  }
  if (input.cursor?.startsWith(CHANNEL_CURSOR_PREFIX)) {
    throw new Error(
      'Pagination cursor is no longer valid because the channel source changed; restart pagination from the beginning',
    )
  }
  const dbCursor = input.cursor?.startsWith(DB_CURSOR_PREFIX)
    ? input.cursor.slice(DB_CURSOR_PREFIX.length)
    : input.cursor
  const dbPage = listRuntimeSessionMessages(db, {
    ...input,
    ...(dbCursor !== undefined ? { cursor: dbCursor } : {}),
  })
  return {
    ...dbPage,
    ...(dbPage.nextCursor
      ? { nextCursor: `${DB_CURSOR_PREFIX}${dbPage.nextCursor}` }
      : {}),
  }
}

export function listChannelStatusesInRuntime(
  db: VelaDatabase,
  channels: ReadonlyMap<string, ChannelAdapter>,
  knownNames: readonly string[] = [],
  lastErrors?: ReadonlyMap<string, string>,
): ChannelStatusInfo[] {
  const names = new Set<string>([...channels.keys(), ...knownNames])
  const rows: ChannelStatusInfo[] = []
  for (const name of [...names].sort()) {
    const adapter = channels.get(name)
    const enabled = isChannelEnabledInDb(db, name)
    const state = adapter?.status?.()
    const error = state?.error ?? lastErrors?.get(name)
    rows.push({
      name,
      enabled,
      connected:
        enabled && Boolean(adapter && (state ? state.connected : true)),
      ...(error ? { error } : {}),
    })
  }
  return rows
}

export function submitChannelHostMessageInRuntime(
  db: VelaDatabase,
  channels: ReadonlyMap<string, ChannelAdapter>,
  channel: string,
  input: ChannelHostSubmitInput,
): Promise<ChannelHostSubmitResult> {
  if (!isChannelEnabledInDb(db, channel)) {
    return Promise.resolve({
      outcome: 'not-sent',
      error: `Channel "${channel}" is disabled`,
    })
  }
  const adapter = channels.get(channel)
  if (!adapter?.submitFromHost) {
    throw new Error(`Channel "${channel}" does not support host submission`)
  }
  return adapter.submitFromHost(input)
}

export function getChannelToolsForSessionInDb(
  db: VelaDatabase,
  sessions: SessionStoreControl,
  bindings: ChannelBindingStore,
  channels: ReadonlyMap<string, ChannelAdapter>,
  sessionId: string,
  runId?: string,
): { binding: ChannelBinding; tools: readonly ChannelToolSpec[] } | undefined {
  const session = sessions.get(sessionId)
  if (!session) return undefined
  let binding: ChannelBinding | undefined
  let hasExplicitTarget = false
  if (runId) {
    const stored = db.get<{ value_json: string }>(
      'SELECT value_json FROM kv_meta WHERE key = ?',
      `run_target:${runId}`,
    )
    if (stored) {
      try {
        const parsed = JSON.parse(stored.value_json) as Partial<OutboxTarget>
        if (parsed.channel && parsed.externalChatId) {
          hasExplicitTarget = true
          binding =
            bindings.findByExternal(
              parsed.channel,
              parsed.externalChatId,
              parsed.threadId,
            ) ?? bindings.findByExternal(parsed.channel, parsed.externalChatId)
          if (binding && !isBindingActive(db, bindings, binding)) {
            binding = undefined
          }
        }
      } catch {
        /* ignore malformed run_target */
      }
    }
  }
  if (!hasExplicitTarget) {
    binding ??= resolveSessionChannelBinding(db, bindings, session)
  }
  if (!binding) return undefined
  const adapter = channels.get(binding.channel)
  if (!adapter?.getTools) return undefined
  const tools = adapter.getTools(binding)
  return tools.length > 0 ? { binding, tools } : undefined
}

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
      return Boolean(binding && isBindingActive(db, bindings, binding))
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
        return Boolean(binding && isBindingActive(db, bindings, binding))
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
    if (!binding || !isBindingActive(db, bindings, binding)) {
      return {
        matchedSessionIds: dispatched.matchedSessionIds,
        enqueuedCount: dispatched.enqueuedCount,
      }
    }
    if (channels && binding.kind === 'group' && !binding.threadId) {
      const adapter = channels.get(channel)
      if (!adapter?.announce) {
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
  if (!adapter?.announce) {
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
