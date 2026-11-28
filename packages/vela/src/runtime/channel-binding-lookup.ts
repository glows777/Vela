import type { VelaDatabase } from '../db/index.ts'
import { SessionStoreControl } from './domain.ts'

export function getActiveChannelForSession(
  db: VelaDatabase,
  sessionId: string,
  callerRunId?: string,
): string | undefined {
  if (callerRunId) {
    const stored = db.get<{ value_json: string }>(
      'SELECT value_json FROM kv_meta WHERE key = ?',
      `run_target:${callerRunId}`,
    )
    if (stored) {
      try {
        const parsed = JSON.parse(stored.value_json) as { channel?: unknown }
        if (typeof parsed.channel === 'string' && parsed.channel) {
          return parsed.channel
        }
      } catch {
        /* fall back to persisted bindings */
      }
    }
  }
  const sessions = new SessionStoreControl(db)
  const session = sessions.get(sessionId)
  if (!session) return undefined
  const direct = db.all<{
    id: string
    channel: string
    external_id: string
    thread_id: string | null
  }>(
    `SELECT id, channel, external_id, thread_id FROM channel_bindings
     WHERE session_id = ? AND enabled = 1
     ORDER BY created_at ASC, rowid ASC`,
    sessionId,
  )
  for (const row of direct) {
    if (row.thread_id) {
      const root = db.get<{ enabled: number }>(
        `SELECT enabled FROM channel_bindings
         WHERE channel = ? AND external_id = ? AND thread_id IS NULL
         ORDER BY created_at ASC, rowid ASC LIMIT 1`,
        row.channel,
        row.external_id,
      )
      if (root && root.enabled === 0) continue
    }
    const enabledRow = db.get<{ value_json: string }>(
      'SELECT value_json FROM kv_meta WHERE key = ?',
      `channel_enabled:${row.channel}`,
    )
    if (enabledRow) {
      try {
        if (JSON.parse(enabledRow.value_json) === false) continue
      } catch {}
    }
    return row.channel
  }
  if (session.projectId && session.kind === 'hub') {
    const roots = db.all<{ channel: string }>(
      `SELECT channel FROM channel_bindings
       WHERE project_id = ? AND thread_id IS NULL AND enabled = 1
       ORDER BY created_at ASC, rowid ASC`,
      session.projectId,
    )
    for (const row of roots) {
      const enabledRow = db.get<{ value_json: string }>(
        'SELECT value_json FROM kv_meta WHERE key = ?',
        `channel_enabled:${row.channel}`,
      )
      if (enabledRow) {
        try {
          if (JSON.parse(enabledRow.value_json) === false) continue
        } catch {}
      }
      return row.channel
    }
  }
  return undefined
}

/**
 * Resolves any channel bound to `sessionId` (directly or via its project root)
 * even if the channel is temporarily toggled off or `session.kind !== 'hub'`.
 * Used for security boundaries like `localOnly` OAuth blocking.
 */
export function getBoundChannelForSession(
  db: VelaDatabase,
  sessionId: string,
  callerRunId?: string,
): string | undefined {
  if (callerRunId) {
    const stored = db.get<{ value_json: string }>(
      'SELECT value_json FROM kv_meta WHERE key = ?',
      `run_target:${callerRunId}`,
    )
    if (stored) {
      try {
        const parsed = JSON.parse(stored.value_json) as { channel?: unknown }
        if (typeof parsed.channel === 'string' && parsed.channel) {
          return parsed.channel
        }
      } catch {}
    }
  }
  const sessions = new SessionStoreControl(db)
  const session = sessions.get(sessionId)
  if (!session) return undefined
  const direct = db.all<{
    channel: string
    external_id: string
    thread_id: string | null
  }>(
    `SELECT channel, external_id, thread_id FROM channel_bindings
     WHERE session_id = ?
     ORDER BY created_at ASC, rowid ASC`,
    sessionId,
  )
  for (const row of direct) {
    return row.channel
  }
  if (session.projectId) {
    const root = db.get<{ channel: string }>(
      `SELECT channel FROM channel_bindings
       WHERE project_id = ? AND thread_id IS NULL
       ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      session.projectId,
    )
    if (root) return root.channel
  }
  return undefined
}
