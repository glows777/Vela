import { rmSync } from 'node:fs'
import type { VelaDatabase } from '../db/index.ts'

function collectSessionBlobPathsInTx(
  db: VelaDatabase,
  sessionId: string,
): string[] {
  return db
    .all<{ storage_path: string }>(
      `SELECT DISTINCT storage_path FROM blobs
       WHERE session_id = ? AND storage_path IS NOT NULL AND storage_path != ''`,
      sessionId,
    )
    .map((r) => r.storage_path)
}

export function cleanupProjectTimerTargetsInTx(
  db: VelaDatabase,
  projectId: string,
): boolean {
  const timerIds = db
    .all<{ id: string }>(
      'SELECT id FROM timers WHERE project_id = ?',
      projectId,
    )
    .map((r) => r.id)
  for (const timerId of timerIds) {
    db.run('DELETE FROM kv_meta WHERE key = ?', `timer_target:${timerId}`)
  }
  return timerIds.length > 0
}

export function cleanupSessionMetadataInTx(
  db: VelaDatabase,
  sessionId: string,
): { blobPaths: string[]; hadTimers: boolean } {
  const blobPaths = collectSessionBlobPathsInTx(db, sessionId)
  const runIds = db
    .all<{ id: string }>('SELECT id FROM runs WHERE session_id = ?', sessionId)
    .map((r) => r.id)
  const timerIds = db
    .all<{ id: string }>(
      'SELECT id FROM timers WHERE session_id = ?',
      sessionId,
    )
    .map((r) => r.id)
  const jobIds = db
    .all<{ id: string }>(
      'SELECT id FROM background_jobs WHERE session_id = ?',
      sessionId,
    )
    .map((r) => r.id)
  const outboxIds = db
    .all<{ id: string }>(
      'SELECT id FROM outbox WHERE session_id = ?',
      sessionId,
    )
    .map((r) => r.id)

  db.run('DELETE FROM blobs WHERE session_id = ?', sessionId)
  db.run('DELETE FROM channel_bindings WHERE session_id = ?', sessionId)

  const uploadPrefix = `channel_upload:${sessionId}:`
  const runTargetPrefix = `run_target:${sessionId}:`
  const shortcutPrefix = 'channel_shortcut:'
  db.run(
    `DELETE FROM kv_meta
      WHERE key = ?
         OR substr(key, 1, length(?)) = ?
         OR substr(key, 1, length(?)) = ?
         OR (
           substr(key, 1, length(?)) = ?
           AND json_valid(value_json)
           AND json_extract(value_json, '$.sessionId') = ?
         )`,
    `legacy_session_channel:${sessionId}`,
    uploadPrefix,
    uploadPrefix,
    runTargetPrefix,
    runTargetPrefix,
    shortcutPrefix,
    shortcutPrefix,
    sessionId,
  )
  for (const runId of runIds) {
    db.run(
      'DELETE FROM kv_meta WHERE key IN (?, ?, ?, ?, ?)',
      `run_target:${runId}`,
      `stop_requested:${runId}`,
      `run_silent:${runId}`,
      `run_handoff_depth:${runId}`,
      `run_input_meta:${runId}`,
    )
  }
  for (const timerId of timerIds) {
    db.run('DELETE FROM kv_meta WHERE key = ?', `timer_target:${timerId}`)
  }
  for (const jobId of jobIds) {
    db.run(
      'DELETE FROM kv_meta WHERE key IN (?, ?)',
      `bg_owner:${jobId}`,
      `bg_stop_requested:${jobId}`,
    )
  }
  for (const outboxId of outboxIds) {
    db.run('DELETE FROM kv_meta WHERE key = ?', `outbox_lease:${outboxId}`)
  }
  return { blobPaths, hadTimers: timerIds.length > 0 }
}

export function unlinkOrphanedBlobPaths(
  db: VelaDatabase,
  paths: readonly string[],
): void {
  if (paths.length === 0) return
  for (const storagePath of new Set(paths)) {
    if (!storagePath) continue
    if (db.open) {
      const stillUsed = db.get<{ ok: number }>(
        'SELECT 1 AS ok FROM blobs WHERE storage_path = ? LIMIT 1',
        storagePath,
      )
      if (stillUsed) continue
    }
    try {
      rmSync(storagePath, { force: true })
    } catch {}
  }
}
