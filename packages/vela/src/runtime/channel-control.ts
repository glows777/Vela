import type { VelaDatabase } from '../db/index.ts'
import { errorMessage, type VelaLogger } from '../shared/logger.ts'
import {
  getOrCreateHubSession,
  ingestChannelMessageInRuntime,
} from './channel-ingress.ts'
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelBinding,
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

const CHANNEL_ENABLED_PREFIX = 'channel_enabled:'

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

export function isChannelEnabledInDb(db: VelaDatabase, name: string): boolean {
  const row = db.get<{ value_json: string }>(
    'SELECT value_json FROM kv_meta WHERE key = ?',
    `${CHANNEL_ENABLED_PREFIX}${name}`,
  )
  if (!row) return true
  try {
    return JSON.parse(row.value_json) !== false
  } catch {
    return true
  }
}

export function setChannelEnabledInDb(
  db: VelaDatabase,
  name: string,
  enabled: boolean,
): void {
  db.run(
    `INSERT INTO kv_meta (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    `${CHANNEL_ENABLED_PREFIX}${name}`,
    JSON.stringify(enabled),
    new Date().toISOString(),
  )
}

function resolveSessionChannelBinding(
  db: VelaDatabase,
  bindings: ChannelBindingStore,
  session: SessionRecord,
): ChannelBinding | undefined {
  const directRow = db.get<{ id: string }>(
    `SELECT id FROM channel_bindings
     WHERE session_id = ? AND enabled = 1
     ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    session.id,
  )
  if (directRow) {
    const binding = bindings.get(directRow.id)
    if (binding) return binding
  }
  if (session.projectId && session.kind === 'hub') {
    const rootRow = db.get<{ id: string }>(
      `SELECT id FROM channel_bindings
       WHERE project_id = ? AND thread_id IS NULL AND enabled = 1
       ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      session.projectId,
    )
    if (rootRow) {
      const binding = bindings.get(rootRow.id)
      if (binding) return binding
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
      return adapter.listMessages({
        sessionId: session.id,
        externalChatId: binding.externalId,
        threadId: binding.threadId,
        kind: binding.kind,
        cursor: input.cursor,
        limit: input.limit,
      })
    }
  }
  return listRuntimeSessionMessages(db, input)
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
      connected: Boolean(adapter && (state ? state.connected : true)),
      ...(error ? { error } : {}),
    })
  }
  return rows
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
  if (runId) {
    const stored = db.get<{ value_json: string }>(
      'SELECT value_json FROM kv_meta WHERE key = ?',
      `run_target:${runId}`,
    )
    if (stored) {
      try {
        const parsed = JSON.parse(stored.value_json) as Partial<OutboxTarget>
        if (parsed.channel && parsed.externalChatId) {
          binding =
            bindings.findByExternal(
              parsed.channel,
              parsed.externalChatId,
              parsed.threadId,
            ) ?? bindings.findByExternal(parsed.channel, parsed.externalChatId)
          if (binding && !binding.enabled) binding = undefined
        }
      } catch {
        /* ignore malformed run_target */
      }
    }
  }
  binding ??= resolveSessionChannelBinding(db, bindings, session)
  if (!binding) return undefined
  const adapter = channels.get(binding.channel)
  if (!adapter?.getTools) return undefined
  const tools = adapter.getTools(binding)
  return tools.length > 0 ? { binding, tools } : undefined
}

export function ingestWebhookEventInRuntime(params: {
  db: VelaDatabase
  projects: ProjectStore
  sessions: SessionStoreControl
  bindings: ChannelBindingStore
  subscriptions: SubscriptionManager
  scheduleSession: (sessionId: string) => void
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
    scheduleSession,
    event,
    defaultTarget,
  } = params
  const dispatched = subscriptions.dispatchEvent({
    source: event.source,
    eventKey: event.key,
    dedupeKey: event.deliveryId,
    summary: event.summary,
    details: event.details,
    final: event.final,
  })
  if (dispatched.matchedSessionIds.length > 0 || !defaultTarget) {
    return dispatched
  }
  const channel = defaultTarget.channel.trim()
  const chatId = defaultTarget.chatId.trim()
  if (!channel || !chatId) return dispatched

  const binding = bindings.findByExternal(channel, chatId)
  if (!binding?.enabled) return dispatched
  const targetSession = binding.sessionId
    ? sessions.get(binding.sessionId)
    : binding.projectId
      ? getOrCreateHubSession(db, projects, sessions, binding.projectId)
      : undefined
  if (!targetSession) return dispatched

  const enqueued = enqueueInboxEvent(db, {
    sessionId: targetSession.id,
    projectId: binding.projectId ?? targetSession.projectId,
    source: 'webhook',
    dedupeKey: `${event.source}:${event.deliveryId}:default:${targetSession.id}`,
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
  if (enqueued.inserted) {
    scheduleSession(targetSession.id)
  }
  return {
    matchedSessionIds: dispatched.matchedSessionIds,
    defaultTargetSessionId: targetSession.id,
    enqueuedCount: dispatched.enqueuedCount + (enqueued.inserted ? 1 : 0),
  }
}

function buildAnnouncementText(
  trigger: string,
  item: DriverInboxItem,
): string | undefined {
  const p = item.payload
  if (trigger === 'timer' && item.source === 'timer' && p.kind === 'routine') {
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
  if (
    trigger === 'webhook' &&
    item.source === 'webhook' &&
    p.isDefaultTarget === true
  ) {
    const header = `[Event ${String(p.eventSource ?? 'webhook')}:${String(p.eventKey ?? '')}] ${String(p.summary ?? '')}`
    return header.replace(/\s+/g, ' ').trim().slice(0, 500)
  }
  return undefined
}

/**
 * Posts a required top-level group announcement (routine `⏰` header or unmatched
 * `eventDefaultTarget` external event) before invoking the agent driver.
 * If announcement fails, skips the turn cleanly without falling back to a prior human message.
 */
export async function prepareTurnAnnouncement(params: {
  db: VelaDatabase
  runId: string
  trigger: string
  inputs: DriverInboxItem[]
  outboxTarget: OutboxTarget | undefined
  getChannelAdapter: (name: string) => ChannelAdapter | undefined
  logger: VelaLogger
}): Promise<{
  skipTurn: boolean
  outboxTarget: OutboxTarget | undefined
  inputs: DriverInboxItem[]
}> {
  const {
    db,
    runId,
    trigger,
    inputs,
    outboxTarget,
    getChannelAdapter,
    logger,
  } = params
  if (!outboxTarget || outboxTarget.threadId || outboxTarget.replyToMessageId) {
    return { skipTurn: false, outboxTarget, inputs }
  }
  const adapter = getChannelAdapter(outboxTarget.channel)
  if (!adapter?.announce) {
    return { skipTurn: false, outboxTarget, inputs }
  }
  let triggerItem: DriverInboxItem | undefined
  let text: string | undefined
  for (let i = inputs.length - 1; i >= 0; i--) {
    const candidate = inputs[i]!
    const built = buildAnnouncementText(trigger, candidate)
    if (built !== undefined) {
      triggerItem = candidate
      text = built
      break
    }
  }
  if (!triggerItem || !text) {
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
      const result = await adapter.announce({
        externalChatId: outboxTarget.externalChatId,
        text,
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
