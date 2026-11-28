import type { VelaDatabase } from '../db/index.ts'
import { resolveWaitForInputOnUserReplyInTx } from './approvals.ts'
import type { SessionStoreControl } from './domain.ts'
import type { RuntimeEventBus } from './event-bus.ts'
import { enqueueInboxEvent, type InboxEventRecord } from './inbox.ts'

function extractInboxText(payloadJson: string): string | undefined {
  try {
    const parsed = JSON.parse(payloadJson) as { text?: unknown }
    if (typeof parsed.text === 'string' && parsed.text.trim().length > 0) {
      return parsed.text
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Lists non-empty pending user inbox message texts (queued steering / follow-up)
 * for a session in FIFO order.
 */
export function listPendingUserInboxTexts(
  db: VelaDatabase,
  sessionId: string,
): string[] {
  const rows = db.all<{ payload_json: string }>(
    `SELECT payload_json
     FROM inbox_events
     WHERE session_id = ? AND source = 'user' AND status = 'pending'
     ORDER BY created_at ASC`,
    sessionId,
  )
  const texts: string[] = []
  for (const row of rows) {
    const text = extractInboxText(row.payload_json)
    if (text !== undefined) texts.push(text)
  }
  return texts
}

/**
 * Deletes and returns all pending user inbox message texts for a session.
 */
export function clearPendingUserInbox(
  db: VelaDatabase,
  sessionId: string,
): string[] {
  return db.transaction(() => {
    const texts = listPendingUserInboxTexts(db, sessionId)
    db.run(
      `DELETE FROM inbox_events
       WHERE session_id = ? AND source = 'user' AND status = 'pending'`,
      sessionId,
    )
    return texts
  })
}

export interface SubmitRuntimePromptInput {
  sessionId: string
  text: string
  dedupeKey?: string
  source?: 'user' | 'handoff' | 'session'
  wake?: boolean
  passive?: boolean
  attachments?: Array<{
    blobId: string
    name: string
    mimeType?: string
    inlineOnly?: boolean
  }>
  metadata?: Record<string, unknown>
}

export function submitPromptInRuntime(params: {
  disposed: boolean
  db: VelaDatabase
  sessions: SessionStoreControl
  eventBus: RuntimeEventBus
  scheduleSession: (sessionId: string) => void
  input: SubmitRuntimePromptInput
}): { event: InboxEventRecord; inserted: boolean } {
  const { disposed, db, sessions, eventBus, scheduleSession, input } = params
  if (disposed) throw new Error('Runtime has been disposed')
  const session = sessions.get(input.sessionId)
  if (!session) throw new Error(`Session ${input.sessionId} not found`)
  const passive = input.passive === true
  const wake = input.wake ?? !passive
  const source = input.source ?? 'user'
  const result = db.transaction(() => {
    const enqueued = enqueueInboxEvent(db, {
      sessionId: input.sessionId,
      projectId: session.projectId,
      source,
      dedupeKey: input.dedupeKey ?? null,
      wake,
      passive,
      payload: {
        type: source,
        text: input.text,
        ...(input.attachments?.length
          ? { attachments: input.attachments }
          : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
    })
    if (enqueued.inserted && wake && !passive && source === 'user') {
      resolveWaitForInputOnUserReplyInTx(db, eventBus, {
        sessionId: input.sessionId,
        replyText: input.text,
      })
    }
    return enqueued
  })
  if (result.inserted && result.event.wake) {
    scheduleSession(input.sessionId)
  }
  return result
}
