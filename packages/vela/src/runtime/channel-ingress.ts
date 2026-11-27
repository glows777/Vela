import { randomUUID } from 'node:crypto'
import type { VelaDatabase } from '../db/index.ts'
import { resolveWaitForInputOnUserReplyInTx } from './approvals.ts'
import type { BlobStore } from './blobs.ts'
import type {
  ChannelAdapter,
  ChannelBinding,
  ChannelInboundMessage,
} from './channels.ts'
import type {
  ChannelBindingStore,
  ProjectStore,
  SessionRecord,
  SessionStoreControl,
} from './domain.ts'
import type { RuntimeEventBus } from './event-bus.ts'
import { enqueueInboxEvent } from './inbox.ts'
import { type ControlShortcut, parseControlShortcut } from './shortcuts.ts'

function resolveChannelTargetInDb(params: {
  db: VelaDatabase
  projects: ProjectStore
  sessions: SessionStoreControl
  bindings: ChannelBindingStore
  msg: ChannelInboundMessage
  allowCreateTopic?: boolean
}): { binding: ChannelBinding; session: SessionRecord } | undefined {
  const {
    db,
    projects,
    sessions,
    bindings,
    msg,
    allowCreateTopic = true,
  } = params
  const exact = bindings.findByExternal(
    msg.channel,
    msg.externalChatId,
    msg.threadId,
  )
  if (exact) {
    if (!exact.enabled) return undefined
    if (msg.threadId) {
      const root = bindings.findByExternal(msg.channel, msg.externalChatId)
      if (root && !root.enabled) return undefined
    }
    const session = exact.sessionId
      ? sessions.get(exact.sessionId)
      : exact.projectId
        ? getOrCreateHubSession(db, projects, sessions, exact.projectId)
        : undefined
    return session ? { binding: exact, session } : undefined
  }
  if (msg.kind === 'direct' && !msg.threadId) {
    if (!allowCreateTopic) return undefined
    const dmSession = sessions.create({
      kind: 'chat',
      name: msg.senderName.trim() || msg.externalChatId,
    })
    const dmBinding = bindings.upsert({
      channel: msg.channel,
      externalId: msg.externalChatId,
      threadId: null,
      kind: 'direct',
      projectId: null,
      sessionId: dmSession.id,
      enabled: true,
    })
    return { binding: dmBinding, session: dmSession }
  }
  if (!msg.threadId || !allowCreateTopic) return undefined
  const root = bindings.findByExternal(msg.channel, msg.externalChatId)
  if (!root?.enabled || !root.projectId) return undefined
  const topicSession = sessions.create({
    projectId: root.projectId,
    kind: 'topic',
    name: msg.text.trim().slice(0, 60) || 'Topic',
  })
  const topicBinding = bindings.upsert({
    channel: msg.channel,
    externalId: msg.externalChatId,
    threadId: msg.threadId,
    kind: 'group',
    projectId: root.projectId,
    sessionId: topicSession.id,
    enabled: true,
  })
  return { binding: topicBinding, session: topicSession }
}

export function getOrCreateHubSession(
  db: VelaDatabase,
  projects: ProjectStore,
  sessions: SessionStoreControl,
  projectId: string,
): SessionRecord | undefined {
  return db.transaction(() => {
    const project = projects.get(projectId)
    if (!project) return undefined
    if (project.hubSessionId) {
      const linked = sessions.get(project.hubSessionId)
      if (linked && !linked.archived) return linked
    }
    const existingHub = db.get<{ id: string }>(
      `SELECT id FROM sessions
       WHERE project_id = ? AND kind = 'hub' AND archived = 0
       ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      projectId,
    )
    const hub = existingHub
      ? sessions.get(existingHub.id)!
      : sessions.create({ projectId, kind: 'hub' })
    db.run(
      `UPDATE projects SET hub_session_id = ?, updated_at = ? WHERE id = ?`,
      hub.id,
      new Date().toISOString(),
      projectId,
    )
    return hub
  })
}

function findExistingChannelInboxId(
  db: VelaDatabase,
  channel: string,
  channelDedupeKey: string,
  rawDedupeKey: string | undefined,
): string | undefined {
  const prefixed = db.get<{ id: string }>(
    `SELECT id FROM inbox_events WHERE source = 'channel' AND dedupe_key = ? LIMIT 1`,
    channelDedupeKey,
  )
  if (prefixed) return prefixed.id
  if (!rawDedupeKey || rawDedupeKey === channelDedupeKey) return undefined
  return db.get<{ id: string }>(
    `SELECT id FROM inbox_events
     WHERE source = 'channel'
       AND dedupe_key = ?
       AND json_valid(payload_json)
       AND json_extract(payload_json, '$.channel') = ?
     LIMIT 1`,
    rawDedupeKey,
    channel,
  )?.id
}

export async function ingestChannelMessageInRuntime(params: {
  db: VelaDatabase
  blobs: BlobStore
  projects: ProjectStore
  sessions: SessionStoreControl
  bindings: ChannelBindingStore
  eventBus?: RuntimeEventBus
  inFlightDeliveries?: Set<string>
  adapter: ChannelAdapter
  msg: ChannelInboundMessage
  executeShortcut: (input: {
    command: ControlShortcut
    sessionId: string
    projectId?: string | null
  }) => Promise<{ text: string; stopped?: boolean }>
  scheduleSession: (sessionId: string) => void
}): Promise<void> {
  const {
    db,
    blobs,
    projects,
    sessions,
    bindings,
    eventBus,
    adapter,
    msg,
    executeShortcut,
    scheduleSession,
  } = params

  const inFlight = params.inFlightDeliveries
  const channelDedupeKey = msg.dedupeKey
    ? `${msg.channel}:${msg.dedupeKey}`
    : undefined
  if (channelDedupeKey && inFlight) {
    if (inFlight.has(channelDedupeKey)) return
    inFlight.add(channelDedupeKey)
  }

  try {
    const shortcut =
      msg.passive === true ? undefined : parseControlShortcut(msg.text)
    if (shortcut) {
      const resolved = resolveChannelTargetInDb({
        db,
        projects,
        sessions,
        bindings,
        msg,
        allowCreateTopic: false,
      })
      if (!resolved) return
      const { binding, session } = resolved
      const shortcutKey = channelDedupeKey
        ? `channel_shortcut:${channelDedupeKey}`
        : undefined
      if (shortcutKey) {
        const claimed = db.run(
          `INSERT OR IGNORE INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?)`,
          shortcutKey,
          JSON.stringify({ sessionId: session.id }),
          new Date().toISOString(),
        )
        if (claimed.changes === 0) return
      }
      const outcome = await executeShortcut({
        command: shortcut,
        sessionId: session.id,
        projectId: binding.projectId,
      })
      if (outcome.text) {
        try {
          await adapter.deliver({
            outboxId: `shortcut-${randomUUID()}`,
            kind: 'reply',
            channel: msg.channel,
            externalChatId: msg.externalChatId,
            ...(msg.threadId ? { threadId: msg.threadId } : {}),
            ...(msg.messageId ? { replyToMessageId: msg.messageId } : {}),
            text: outcome.text,
          })
        } catch (error) {
          if (shortcutKey && (shortcut === 'status' || shortcut === 'timers')) {
            db.run('DELETE FROM kv_meta WHERE key = ?', shortcutKey)
          }
          throw error
        }
      }
      return
    }

    if (channelDedupeKey) {
      if (
        findExistingChannelInboxId(
          db,
          msg.channel,
          channelDedupeKey,
          msg.dedupeKey,
        )
      ) {
        return
      }
    }

    const resolved = resolveChannelTargetInDb({
      db,
      projects,
      sessions,
      bindings,
      msg,
      allowCreateTopic: msg.requireExistingSession !== true,
    })
    if (!resolved) return
    const { binding, session } = resolved

    const attachments: Array<{
      blobId: string
      name: string
      mimeType?: string
      inlineOnly?: boolean
    }> = []
    let inserted = false
    try {
      if (msg.attachments?.length && adapter.fetchAttachment) {
        for (const att of msg.attachments) {
          const bytes = await adapter.fetchAttachment(att.ref)
          const blob = await blobs.storeInbound({
            sessionId: session.id,
            projectId: binding.projectId,
            filename: att.name,
            mimeType: att.mimeType,
            bytes,
          })
          attachments.push({
            blobId: blob.id,
            name: att.name,
            ...(att.mimeType ? { mimeType: att.mimeType } : {}),
            ...(att.inlineOnly ? { inlineOnly: true } : {}),
          })
        }
      }

      const passive = msg.passive === true
      const wake = msg.wake ?? !passive
      const result = db.transaction(() => {
        if (
          channelDedupeKey &&
          findExistingChannelInboxId(
            db,
            msg.channel,
            channelDedupeKey,
            msg.dedupeKey,
          )
        ) {
          return undefined
        }
        const enqueued = enqueueInboxEvent(db, {
          sessionId: session.id,
          projectId: binding.projectId,
          source: 'channel',
          dedupeKey: channelDedupeKey,
          wake,
          passive,
          payload: {
            type: 'channel',
            channel: msg.channel,
            externalChatId: msg.externalChatId,
            kind: msg.kind,
            ...(msg.threadId ? { threadId: msg.threadId } : {}),
            ...(msg.messageId ? { messageId: msg.messageId } : {}),
            senderId: msg.senderId,
            senderName: msg.senderName,
            text: msg.text,
            ...(msg.preformatted ? { preformatted: true } : {}),
            ...(msg.rawText !== undefined ? { rawText: msg.rawText } : {}),
            ...(msg.mentioned !== undefined
              ? { mentioned: msg.mentioned }
              : {}),
            timestamp: msg.timestamp,
            ...(attachments.length ? { attachments } : {}),
          },
        })
        if (enqueued.inserted && wake && !passive && eventBus) {
          resolveWaitForInputOnUserReplyInTx(db, eventBus, {
            sessionId: session.id,
            replyText: msg.text,
            decidedBy: msg.senderName,
          })
        }
        return enqueued
      })
      inserted = Boolean(result?.inserted)
      if (result?.inserted && result.event.wake) {
        scheduleSession(session.id)
      }
    } finally {
      if (!inserted && attachments.length > 0) {
        for (const att of attachments) {
          await blobs.deleteBlob(att.blobId).catch(() => {})
        }
      }
    }
  } finally {
    if (channelDedupeKey && inFlight) inFlight.delete(channelDedupeKey)
  }
}
