import { randomUUID } from 'node:crypto'
import type { VelaDatabase } from '../db/index.ts'
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
import { enqueueInboxEvent } from './inbox.ts'
import { type ControlShortcut, parseControlShortcut } from './shortcuts.ts'

function resolveChannelTargetInDb(params: {
  projects: ProjectStore
  sessions: SessionStoreControl
  bindings: ChannelBindingStore
  msg: ChannelInboundMessage
}): { binding: ChannelBinding; session: SessionRecord } | undefined {
  const { projects, sessions, bindings, msg } = params
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
        ? getOrCreateHubSession(projects, sessions, exact.projectId)
        : undefined
    return session ? { binding: exact, session } : undefined
  }
  if (!msg.threadId) return undefined
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

function getOrCreateHubSession(
  projects: ProjectStore,
  sessions: SessionStoreControl,
  projectId: string,
): SessionRecord | undefined {
  const project = projects.get(projectId)
  if (!project) return undefined
  if (project.hubSessionId) {
    return sessions.get(project.hubSessionId)
  }
  return sessions.create({ projectId, kind: 'work' })
}

const IN_FLIGHT_DELIVERIES = new Set<string>()

export async function ingestChannelMessageInRuntime(params: {
  db: VelaDatabase
  blobs: BlobStore
  projects: ProjectStore
  sessions: SessionStoreControl
  bindings: ChannelBindingStore
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
    adapter,
    msg,
    executeShortcut,
    scheduleSession,
  } = params

  const inFlightKey = msg.dedupeKey
    ? `${msg.channel}:${msg.dedupeKey}`
    : undefined
  if (inFlightKey) {
    if (IN_FLIGHT_DELIVERIES.has(inFlightKey)) return
    IN_FLIGHT_DELIVERIES.add(inFlightKey)
  }

  try {
    const shortcut = parseControlShortcut(msg.text)
    if (shortcut) {
      const resolved = resolveChannelTargetInDb({
        projects,
        sessions,
        bindings,
        msg,
      })
      if (!resolved) return
      const { binding, session } = resolved
      const shortcutKey = msg.dedupeKey
        ? `channel_shortcut:${msg.channel}:${msg.dedupeKey}`
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

    if (msg.dedupeKey) {
      const existingInbox = db.get<{ id: string }>(
        `SELECT id FROM inbox_events WHERE source = 'channel' AND dedupe_key = ? LIMIT 1`,
        msg.dedupeKey,
      )
      if (existingInbox) return
    }

    const resolved = resolveChannelTargetInDb({
      projects,
      sessions,
      bindings,
      msg,
    })
    if (!resolved) return
    const { binding, session } = resolved

    const attachments: Array<{
      blobId: string
      name: string
      mimeType?: string
    }> = []
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
        })
      }
    }

    const passive = msg.passive === true
    const wake = msg.wake ?? !passive
    const { event, inserted } = enqueueInboxEvent(db, {
      sessionId: session.id,
      projectId: binding.projectId,
      source: 'channel',
      dedupeKey: msg.dedupeKey,
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
        ...(msg.mentioned !== undefined ? { mentioned: msg.mentioned } : {}),
        timestamp: msg.timestamp,
        ...(attachments.length ? { attachments } : {}),
      },
    })
    if (!inserted && attachments.length > 0) {
      for (const att of attachments) {
        await blobs.deleteBlob(att.blobId)
      }
    }
    if (inserted && event.wake) {
      scheduleSession(session.id)
    }
  } finally {
    if (inFlightKey) IN_FLIGHT_DELIVERIES.delete(inFlightKey)
  }
}
