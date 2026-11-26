import type { VelaDatabase } from '../db/index.ts'

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
