import type { VelaDatabase } from '../db/index.ts'
import type { BackgroundJobManager } from './background-jobs.ts'
import { isOwnerLive } from './driver.ts'
import {
  enqueueInboxEvent,
  isTopicAwaitingBindingInDb,
  listSessionsWithPendingWake,
  requeueProcessingForRunInTx,
} from './inbox.ts'
import type { OutboxDispatcher } from './outbox.ts'
import type { TimerScheduler } from './timers.ts'

/** Single-DB startup crash recovery across `background_jobs`, `outbox`, `runs`, `approvals`, `inbox_events`, and `timers`. */
export function recoverRuntimeState(params: {
  db: VelaDatabase
  backgroundJobs: BackgroundJobManager
  outbox: OutboxDispatcher
  timers: TimerScheduler
  activeOwners: ReadonlySet<string>
  nowMs: number
}): {
  interruptedJobs: string[]
  recoveredRuns: string[]
  requeuedInboxRuns: string[]
  sessionsToWake: Set<string>
} {
  const { db, backgroundJobs, outbox, timers, activeOwners, nowMs } = params
  const nowIso = new Date(nowMs).toISOString()
  const interruptedJobs = backgroundJobs.recoverInterrupted(nowIso)
  outbox.recoverStaleSending()

  const recoveredRuns: string[] = []
  const requeuedInboxRuns: string[] = []
  const sessionsToWake = new Set<string>()

  db.transaction(() => {
    const staleRuns = db.all<{
      id: string
      session_id: string
      owner_token: string | null
    }>(
      `SELECT id, session_id, owner_token FROM runs
       WHERE status IN ('queued', 'running')
       ORDER BY started_at ASC`,
    )
    for (const run of staleRuns) {
      if (isOwnerLive(run.owner_token, activeOwners)) continue
      const hasProgress = Boolean(
        db.get<{ ok: number }>(
          `SELECT 1 AS ok FROM vela_messages WHERE session_id = ? AND run_id = ? LIMIT 1`,
          run.session_id,
          run.id,
        ) ??
          db.get<{ ok: number }>(
            `SELECT 1 AS ok FROM vela_tool_calls WHERE session_id = ? AND run_id = ? LIMIT 1`,
            run.session_id,
            run.id,
          ),
      )
      if (hasProgress) {
        db.run(
          `UPDATE runs SET owner_token = NULL, updated_at = ? WHERE id = ?`,
          nowIso,
          run.id,
        )
        db.run(
          `UPDATE sessions SET state = 'running', updated_at = ? WHERE id = ?`,
          nowIso,
          run.session_id,
        )
        recoveredRuns.push(run.id)
        if (!isTopicAwaitingBindingInDb(db, run.session_id)) {
          sessionsToWake.add(run.session_id)
        }
      } else {
        db.run(
          `UPDATE runs
           SET status = 'interrupted', owner_token = NULL, finished_at = COALESCE(finished_at, ?), updated_at = ?
           WHERE id = ?`,
          nowIso,
          nowIso,
          run.id,
        )
        db.run(
          `UPDATE sessions SET state = 'idle', waiting_reason = NULL, updated_at = ? WHERE id = ? AND state = 'running'`,
          nowIso,
          run.session_id,
        )
        requeueProcessingForRunInTx(db, run.id)
        db.run(
          'DELETE FROM kv_meta WHERE key IN (?, ?, ?, ?, ?)',
          `run_target:${run.id}`,
          `stop_requested:${run.id}`,
          `run_silent:${run.id}`,
          `run_handoff_depth:${run.id}`,
          `run_input_meta:${run.id}`,
        )
        requeuedInboxRuns.push(run.id)
        if (!isTopicAwaitingBindingInDb(db, run.session_id)) {
          sessionsToWake.add(run.session_id)
        }
      }
    }

    const waitingRuns = db.all<{
      id: string
      session_id: string
      project_id: string | null
    }>(
      `SELECT id, session_id, project_id FROM runs WHERE status = 'waiting_human' ORDER BY started_at ASC`,
    )
    for (const run of waitingRuns) {
      const pendingApproval = db.get<{ id: string }>(
        `SELECT id FROM approvals WHERE run_id = ? AND status = 'pending' LIMIT 1`,
        run.id,
      )
      if (pendingApproval) continue
      const existingPendingWake = db.get<{ id: string }>(
        `SELECT id FROM inbox_events WHERE session_id = ? AND source = 'approval' AND status = 'pending' LIMIT 1`,
        run.session_id,
      )
      if (!existingPendingWake) {
        const resolvedStats = db.get<{
          cnt: number
          latest: string | null
        }>(
          `SELECT count(*) AS cnt, max(resolved_at) AS latest
           FROM approvals
           WHERE run_id = ? AND status != 'pending'`,
          run.id,
        )
        const epoch = `${resolvedStats?.cnt ?? 0}:${resolvedStats?.latest ?? ''}`
        enqueueInboxEvent(db, {
          sessionId: run.session_id,
          projectId: run.project_id,
          source: 'approval',
          dedupeKey: `approval-resume:${run.id}:${epoch}`,
          wake: true,
          payload: { type: 'approval_resolved', runId: run.id },
        })
      }
      if (!isTopicAwaitingBindingInDb(db, run.session_id)) {
        sessionsToWake.add(run.session_id)
      }
    }

    const orphanedProcessing = db.all<{
      id: string
      session_id: string | null
      run_id: string | null
    }>(
      `SELECT id, session_id, run_id FROM inbox_events WHERE status = 'processing'`,
    )
    for (const row of orphanedProcessing) {
      const liveRun = row.run_id
        ? db.get<{ status: string; owner_token: string | null }>(
            'SELECT status, owner_token FROM runs WHERE id = ?',
            row.run_id,
          )
        : undefined
      if (
        liveRun &&
        liveRun.status === 'running' &&
        (!liveRun.owner_token || isOwnerLive(liveRun.owner_token, activeOwners))
      ) {
        continue
      }
      if (liveRun && liveRun.status === 'waiting_human' && row.session_id) {
        const hasProgress = Boolean(
          db.get<{ ok: number }>(
            `SELECT 1 AS ok FROM vela_messages WHERE session_id = ? AND run_id = ? LIMIT 1`,
            row.session_id,
            row.run_id,
          ) ??
            db.get<{ ok: number }>(
              `SELECT 1 AS ok FROM vela_tool_calls WHERE session_id = ? AND run_id = ? LIMIT 1`,
              row.session_id,
              row.run_id,
            ),
        )
        if (hasProgress) {
          db.run(
            `UPDATE inbox_events SET status = 'done', processed_at = COALESCE(processed_at, ?) WHERE id = ?`,
            nowIso,
            row.id,
          )
          continue
        }
      }
      db.run(
        `UPDATE inbox_events SET status = 'pending', run_id = NULL WHERE id = ?`,
        row.id,
      )
      if (row.session_id && !isTopicAwaitingBindingInDb(db, row.session_id)) {
        sessionsToWake.add(row.session_id)
      }
    }
  })

  timers.tick(nowMs)
  for (const sessionId of listSessionsWithPendingWake(db)) {
    sessionsToWake.add(sessionId)
  }
  return { interruptedJobs, recoveredRuns, requeuedInboxRuns, sessionsToWake }
}
