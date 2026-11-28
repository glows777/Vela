import { Buffer } from 'node:buffer'
import type { VelaDatabase } from '../db/index.ts'
import type { BlobStore } from './blobs.ts'
import {
  getHostPostAuthorInDb,
  ingestChannelMessageInRuntime,
  isChannelEnabledInDb,
  persistHostPostAuthorInTx,
  setChannelEnabledInDb,
} from './channel-ingress.ts'
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelBinding,
  ChannelConnectionState,
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
import type { AgentDriver } from './driver.ts'
import {
  cancelPendingInboxEventInDb,
  listSessionsWithPendingWake,
} from './inbox.ts'
import {
  listRuntimeSessionMessages,
  type RuntimeMessagePage,
} from './messages.ts'
import type { OutboxTarget } from './worker.ts'

function inferInlineImageMime(
  bytes: Uint8Array,
  name: string,
  declared?: string | null,
): string | undefined {
  if (declared?.startsWith('image/')) return declared
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png'
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  const ext = name.toLowerCase().split('.').pop()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  return undefined
}

async function steerInboxEventInRuntime(params: {
  db: VelaDatabase
  blobs: import('./blobs.ts').BlobStore
  trySteerSession?: (
    sessionId: string,
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ) => Promise<boolean>
  trySteerInboxEvent?: (
    sessionId: string,
    inboxEventId: string,
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ) => Promise<boolean> | boolean
  steerSession: (sessionId: string, text: string) => Promise<void>
  sessionId: string
  inboxEventId: string
  text: string
}): Promise<boolean> {
  const { db, blobs, sessionId, inboxEventId, text } = params
  const pendingRow = db.get<{ status: string; payload_json: string }>(
    `SELECT status, payload_json FROM inbox_events WHERE id = ? AND session_id = ?`,
    inboxEventId,
    sessionId,
  )
  if (pendingRow?.status !== 'pending') return false

  let steerText = text
  const images: Array<{ data: string; mimeType: string }> = []
  let payload: {
    text?: unknown
    attachments?: Array<{
      blobId?: unknown
      name?: unknown
      mimeType?: unknown
      inlineOnly?: unknown
    }>
  }
  try {
    payload = JSON.parse(pendingRow.payload_json) as typeof payload
  } catch {
    return false
  }
  if (typeof payload.text === 'string' && payload.text.trim()) {
    steerText = payload.text
  }
  if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
    for (const att of payload.attachments) {
      if (att?.inlineOnly !== true) {
        // Non-inline attachments (files or trigger images requiring workspace staging) must stay queued for full turn preparation.
        return false
      }
      if (typeof att.blobId !== 'string' || typeof att.name !== 'string') {
        return false
      }
      const metaMime =
        typeof att.mimeType === 'string'
          ? att.mimeType
          : blobs.get(att.blobId)?.mimeType
      const bytes = await blobs
        .readOwnedBytes(att.blobId, sessionId)
        .catch(() => undefined)
      const mime = bytes
        ? inferInlineImageMime(bytes, att.name, metaMime)
        : undefined
      if (!bytes || !mime) {
        return false
      }
      images.push({
        data: Buffer.from(bytes).toString('base64'),
        mimeType: mime,
      })
    }
  }

  const stillPending = db.get<{ status: string }>(
    `SELECT status FROM inbox_events WHERE id = ? AND session_id = ?`,
    inboxEventId,
    sessionId,
  )
  if (stillPending?.status !== 'pending') return false

  const inlineImages = images.length > 0 ? images : undefined
  if (params.trySteerInboxEvent) {
    return Boolean(
      await params.trySteerInboxEvent(
        sessionId,
        inboxEventId,
        steerText,
        inlineImages,
      ),
    )
  }
  if (params.trySteerSession) {
    const accepted = await params.trySteerSession(
      sessionId,
      steerText,
      inlineImages,
    )
    if (!accepted) return false
  } else {
    await params.steerSession(sessionId, steerText)
  }
  cancelPendingInboxEventInDb(db, inboxEventId)
  return true
}

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
  trySteerSession?: (
    sessionId: string,
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ) => Promise<boolean>
  trySteerInboxEvent?: (
    sessionId: string,
    inboxEventId: string,
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ) => Promise<boolean> | boolean
  reportStatus?: (status: ChannelConnectionState) => void
}): ChannelAdapterContext {
  const ingestWithReceipt = async (
    message: Parameters<typeof ingestChannelMessageInRuntime>[0]['msg'],
  ) => {
    const receipt = await ingestChannelMessageInRuntime({
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
    })
    if (receipt.admitted) {
      params.eventBus.emitChannelEvent({
        type: 'channel_history_changed',
        channel: message.channel,
        chatId: message.externalChatId,
        ...(message.threadId && receipt.sessionId
          ? { sessionId: receipt.sessionId }
          : {}),
      })
    }
    return receipt
  }
  return {
    ingest: async (message) => {
      await ingestWithReceipt(message)
    },
    ingestWithReceipt,
    subscribeEvents: (listener) => params.eventBus.subscribeEvents(listener),
    subscribeDeltas: (listener) => params.eventBus.subscribeDeltas(listener),
    stopSession: params.stopSession,
    steerSession: params.steerSession,
    discardInboxEvent: (inboxEventId) =>
      cancelPendingInboxEventInDb(params.db, inboxEventId),
    steerInboxEvent: (sessionId, inboxEventId, text) =>
      steerInboxEventInRuntime({
        db: params.db,
        blobs: params.blobs,
        trySteerSession: params.trySteerSession,
        trySteerInboxEvent: params.trySteerInboxEvent,
        steerSession: params.steerSession,
        sessionId,
        inboxEventId,
        text,
      }),
    listBindings: (filter) => params.bindings.list(filter),
    getSession: (id) => params.sessions.get(id),
    getProject: (id) => params.projects.get(id),
    recordHostPostAuthor: (externalMessageId, authorName) =>
      persistHostPostAuthorInTx(
        params.db,
        params.adapter.name,
        externalMessageId,
        authorName,
      ),
    getHostPostAuthor: (externalMessageId) =>
      getHostPostAuthorInDb(params.db, params.adapter.name, externalMessageId),
    ...(params.reportStatus ? { reportStatus: params.reportStatus } : {}),
  }
}

export async function steerSessionInRuntime(params: {
  disposed: boolean
  db: VelaDatabase
  sessions: SessionStoreControl
  blobs?: BlobStore
  drivers: ReadonlyMap<string, AgentDriver>
  activeWorkers: ReadonlyMap<string, unknown>
  submitPrompt: (input: {
    sessionId: string
    text: string
    attachments?: Array<{
      kind: 'image'
      blobId: string
      name: string
      mimeType: string
      inlineOnly?: boolean
    }>
    source: 'user'
    wake: boolean
  }) => unknown
  sessionId: string
  text: string
  images?: Array<{ data: string; mimeType: string }>
  noQueueFallback?: boolean
}): Promise<boolean> {
  const {
    disposed,
    db,
    sessions,
    blobs,
    drivers,
    activeWorkers,
    submitPrompt,
    sessionId,
    text,
    images,
    noQueueFallback = false,
  } = params
  const session = disposed ? undefined : sessions.get(sessionId)
  if (!session) {
    if (noQueueFallback) return false
    throw new Error(
      disposed ? 'Runtime has been disposed' : `Session ${sessionId} not found`,
    )
  }
  const resetStreak = () =>
    db.run(
      'UPDATE sessions SET followup_streak = 0, updated_at = ? WHERE id = ?',
      new Date().toISOString(),
      sessionId,
    )
  const driver = drivers.get(session.driver)
  if (
    activeWorkers.has(sessionId) &&
    driver?.capabilities.steer &&
    driver.steer
  ) {
    resetStreak()
    if ((await driver.steer(sessionId, text, images)) !== false) return true
  }
  if (noQueueFallback) return false
  resetStreak()
  const attachments =
    blobs && images?.length
      ? await Promise.all(
          images.map(async (img, i) => {
            const ext = img.mimeType.split('/')[1] || 'png'
            const blob = await blobs.storeInbound({
              sessionId,
              ...(session.projectId ? { projectId: session.projectId } : {}),
              filename: `image-${i + 1}.${ext}`,
              mimeType: img.mimeType,
              bytes: Buffer.from(img.data, 'base64'),
            })
            return {
              kind: 'image' as const,
              blobId: blob.id,
              name: blob.filename,
              mimeType: img.mimeType,
              inlineOnly: true,
            }
          }),
        )
      : undefined
  submitPrompt({ sessionId, text, attachments, source: 'user', wake: true })
  return true
}

export interface ChannelStatusTracker {
  begin(channel: string): (status: ChannelConnectionState) => void
  markInitialIfUnset(channel: string, status: ChannelConnectionState): void
  markStopped(channel: string): void
}

export function createChannelStatusTracker(
  eventBus: import('./event-bus.ts').RuntimeEventBus,
): ChannelStatusTracker {
  const states = new Map<
    string,
    {
      currentlyConnected: boolean
      everConnected: boolean
      sawFailureOrDisconnect: boolean
      emittedInitialStatus: boolean
    }
  >()
  const entryOf = (channel: string) => {
    let entry = states.get(channel)
    if (!entry) {
      entry = {
        currentlyConnected: false,
        everConnected: false,
        sawFailureOrDisconnect: false,
        emittedInitialStatus: false,
      }
      states.set(channel, entry)
    }
    return entry
  }
  const report = (channel: string, state: ChannelConnectionState) => {
    const entry = entryOf(channel)
    entry.emittedInitialStatus = true
    const shouldReset =
      state.connected &&
      !entry.currentlyConnected &&
      (entry.everConnected || entry.sawFailureOrDisconnect)
    if (state.connected) {
      entry.everConnected = true
    } else if (entry.everConnected || state.error) {
      entry.sawFailureOrDisconnect = true
    }
    entry.currentlyConnected = state.connected
    eventBus.emitChannelEvent({
      type: 'channel_status',
      channel,
      connected: state.connected,
      ...(state.error ? { error: state.error } : {}),
      ...(shouldReset ? { reset: true } : {}),
    })
  }
  return {
    begin: (channel) => {
      entryOf(channel).emittedInitialStatus = false
      return (state) => report(channel, state)
    },
    markInitialIfUnset: (channel, status) => {
      if (!entryOf(channel).emittedInitialStatus) {
        report(channel, status)
      }
    },
    markStopped: (channel) => {
      const entry = entryOf(channel)
      if (entry.everConnected) {
        entry.sawFailureOrDisconnect = true
      }
      entry.currentlyConnected = false
      eventBus.emitChannelEvent({
        type: 'channel_status',
        channel,
        connected: false,
      })
    },
  }
}

const startingAdapters = new WeakSet<ChannelAdapter>()

export function isChannelAdapterReady(
  adapter: ChannelAdapter | undefined,
): adapter is ChannelAdapter {
  return Boolean(adapter && !startingAdapters.has(adapter))
}

export async function registerChannelInRuntime(
  channels: Map<string, ChannelAdapter>,
  params: Parameters<typeof createChannelAdapterContext>[0],
  statusTracker?: ChannelStatusTracker,
): Promise<void> {
  const { adapter } = params
  const existing = channels.get(adapter.name)
  if (existing) {
    await existing.stop()
    statusTracker?.markStopped(adapter.name)
  }
  const reportStatus = statusTracker?.begin(adapter.name)
  startingAdapters.add(adapter)
  channels.set(adapter.name, adapter)
  try {
    await adapter.start(
      createChannelAdapterContext({
        ...params,
        ...(reportStatus ? { reportStatus } : {}),
      }),
    )
    startingAdapters.delete(adapter)
    if (statusTracker && channels.get(adapter.name) === adapter) {
      statusTracker.markInitialIfUnset(
        adapter.name,
        adapter.status?.() ?? { connected: false },
      )
    }
  } catch (error) {
    startingAdapters.delete(adapter)
    if (channels.get(adapter.name) === adapter) {
      channels.delete(adapter.name)
    }
    await adapter.stop().catch(() => {})
    statusTracker?.markInitialIfUnset(adapter.name, {
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  for (const sid of listSessionsWithPendingWake(params.db)) {
    params.scheduleSession(sid)
  }
}

export { isChannelEnabledInDb, setChannelEnabledInDb }

const CHANNEL_CURSOR_PREFIX = 'ch:'
const DB_CURSOR_PREFIX = 'db:'

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
     WHERE session_id = ?
     ORDER BY enabled DESC, created_at ASC, rowid ASC`,
    session.id,
  )
  for (const row of directRows) {
    const binding = bindings.get(row.id)
    if (binding) return binding
  }
  if (session.projectId) {
    const project = db.get<{ hub_session_id: string | null }>(
      'SELECT hub_session_id FROM projects WHERE id = ?',
      session.projectId,
    )
    const isProjectHub = project?.hub_session_id
      ? project.hub_session_id === session.id
      : session.kind === 'hub'
    if (isProjectHub) {
      const rootRows = db.all<{ id: string }>(
        `SELECT id FROM channel_bindings
         WHERE project_id = ? AND thread_id IS NULL
         ORDER BY enabled DESC, created_at ASC, rowid ASC`,
        session.projectId,
      )
      for (const row of rootRows) {
        const binding = bindings.get(row.id)
        if (binding) return binding
      }
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
  if (binding && isBindingActive(db, bindings, binding)) {
    const adapter = channels.get(binding.channel)
    if (isChannelAdapterReady(adapter) && adapter.listMessages) {
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
    const ready = isChannelAdapterReady(adapter)
    const enabled = isChannelEnabledInDb(db, name)
    const state = adapter?.status?.()
    const error = state?.error ?? lastErrors?.get(name)
    rows.push({
      name,
      enabled,
      connected: enabled && Boolean(ready && (state ? state.connected : true)),
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
  if (!isChannelAdapterReady(adapter) || !adapter.submitFromHost) {
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
    if (binding && !isBindingActive(db, bindings, binding)) {
      binding = undefined
    }
  }
  if (!binding) return undefined
  const adapter = channels.get(binding.channel)
  if (!isChannelAdapterReady(adapter) || !adapter.getTools) return undefined
  const tools = adapter.getTools(binding)
  return tools.length > 0 ? { binding, tools } : undefined
}

export {
  ingestWebhookEventInRuntime,
  prepareTurnAnnouncement,
} from './channel-webhooks.ts'
