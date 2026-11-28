import type { VelaDatabase } from '../db/index.ts'
import { enqueueInboxEvent } from '../runtime/inbox.ts'
import type { BlobStore } from '../runtime/index.ts'
import type { ModelMessage } from './messages.ts'
import { messageText } from './session/message-queue.ts'

export function buildSteeringMessage(
  text: string,
  images?: Array<{ data: string; mimeType: string }>,
): ModelMessage {
  if (images && images.length > 0) {
    const parts: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; data: string; mimeType: string }
    > = []
    if (text) parts.push({ type: 'text', text })
    for (const img of images) {
      parts.push({ type: 'image', data: img.data, mimeType: img.mimeType })
    }
    return { role: 'user', content: parts }
  }
  return { role: 'user', content: text }
}

/**
 * Drains active steering messages for `sessionId`, atomically completing any
 * inbox-backed entries in SQLite so they cannot be double-delivered or lost.
 */
export function takeSessionSteering(params: {
  db: VelaDatabase
  sessionId: string
  runId: string
  activeSteering: Map<string, ModelMessage[]>
  activeSteeringInboxIds: WeakMap<ModelMessage, string>
}): ModelMessage[] {
  const { db, sessionId, runId, activeSteering, activeSteeringInboxIds } =
    params
  const list = activeSteering.get(sessionId) ?? []
  activeSteering.set(sessionId, [])
  if (list.length === 0) return []
  const accepted: ModelMessage[] = []
  const now = new Date().toISOString()
  for (const msg of list) {
    const inboxEventId = activeSteeringInboxIds.get(msg)
    if (!inboxEventId) {
      accepted.push(msg)
      continue
    }
    activeSteeringInboxIds.delete(msg)
    const res = db.run(
      `UPDATE inbox_events
       SET status = 'done', run_id = ?, processed_at = COALESCE(processed_at, ?)
       WHERE id = ? AND status = 'pending'`,
      runId,
      now,
      inboxEventId,
    )
    if (res.changes > 0) {
      accepted.push(msg)
    }
  }
  return accepted
}

/**
 * Preserves unconsumed steering inputs when a turn exits: inbox-backed events
 * remain intact in `inbox_events`, while standalone steer inputs are re-enqueued
 * (including any inline image attachments).
 */
export async function flushSessionSteering(params: {
  db: VelaDatabase
  blobs?: BlobStore
  sessionId: string
  projectId: string | null
  activeSteering: Map<string, ModelMessage[]>
  activeSteeringInboxIds: WeakMap<ModelMessage, string>
  deferredSteering: ModelMessage[]
  wake: boolean
  shouldWakeSession: boolean
  wakeSession?: (sessionId: string) => void
}): Promise<void> {
  const {
    db,
    blobs,
    sessionId,
    projectId,
    activeSteering,
    activeSteeringInboxIds,
    deferredSteering,
    wake,
    shouldWakeSession,
    wakeSession,
  } = params
  const live = activeSteering.get(sessionId)
  activeSteering.delete(sessionId)
  const allUnconsumed = [...deferredSteering.splice(0), ...(live ?? [])]
  const standalone: ModelMessage[] = []
  let hasPreservedInbox = false
  for (const msg of allUnconsumed) {
    const inboxEventId = activeSteeringInboxIds.get(msg)
    if (inboxEventId) {
      activeSteeringInboxIds.delete(msg)
      const pending = db.get<{ wake: number }>(
        `SELECT wake FROM inbox_events WHERE id = ? AND status = 'pending'`,
        inboxEventId,
      )
      if (pending?.wake === 1) {
        hasPreservedInbox = true
      }
      continue
    }
    standalone.push(msg)
  }
  await flushUnconsumedSteering({
    db,
    blobs,
    sessionId,
    projectId,
    unconsumed: standalone,
    wake,
    shouldWakeSession,
    wakeSession,
  })
  if (
    standalone.length === 0 &&
    hasPreservedInbox &&
    wake &&
    shouldWakeSession
  ) {
    wakeSession?.(sessionId)
  }
}

/** Re-enqueues unconsumed in-memory `steer()` inputs into durable `inbox_events` when a turn exits before consuming them. */
async function flushUnconsumedSteering(options: {
  db: VelaDatabase
  blobs?: BlobStore
  sessionId: string
  projectId: string | null
  unconsumed: readonly ModelMessage[]
  wake: boolean
  shouldWakeSession: boolean
  wakeSession?: (sessionId: string) => void
}): Promise<void> {
  if (options.unconsumed.length === 0) return
  let insertedAny = false
  for (const msg of options.unconsumed) {
    const rawText = messageText(msg).trim()
    const imageParts = Array.isArray(msg.content)
      ? msg.content.filter(
          (part): part is { type: 'image'; data: string; mimeType: string } =>
            part.type === 'image' && typeof part.data === 'string',
        )
      : []
    const attachments: Array<{
      kind: 'image'
      blobId: string
      name: string
      mimeType: string
      inlineOnly: boolean
    }> = []
    if (options.blobs && imageParts.length > 0) {
      for (let i = 0; i < imageParts.length; i++) {
        const img = imageParts[i]!
        const mimeType = img.mimeType || 'image/png'
        const ext = mimeType.split('/')[1] || 'png'
        const blob = await options.blobs.storeInbound({
          sessionId: options.sessionId,
          ...(options.projectId ? { projectId: options.projectId } : {}),
          filename: `steer-image-${i + 1}.${ext}`,
          mimeType,
          bytes: Buffer.from(img.data, 'base64'),
        })
        attachments.push({
          kind: 'image',
          blobId: blob.id,
          name: blob.filename,
          mimeType,
          inlineOnly: true,
        })
      }
    }
    const text = rawText || (imageParts.length > 0 ? '[Image attachment]' : '')
    if (!text) continue
    const res = enqueueInboxEvent(options.db, {
      sessionId: options.sessionId,
      projectId: options.projectId,
      source: 'user',
      wake: options.wake,
      passive: false,
      payload: {
        type: 'user',
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    })
    if (res.inserted) insertedAny = true
  }
  if (insertedAny && options.wake && options.shouldWakeSession) {
    options.wakeSession?.(options.sessionId)
  }
}
