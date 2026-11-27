import type { VelaDatabase } from '../db/index.ts'
import { cancelPendingApprovalsForSession } from './approvals.ts'
import type { BackgroundJobManager } from './background-jobs.ts'
import type { SessionRecord, SessionStoreControl } from './domain.ts'
import {
  type AgentDriver,
  abortLiveProcessOwner,
  type DriverInboxItem,
  isOwnerLive,
} from './driver.ts'
import type { RuntimeEventBus } from './event-bus.ts'
import type { RunEndStatus } from './events.ts'
import {
  enqueueInboxEvent,
  hasSessionPendingWake,
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

export function recordChildStatusNoteForHubInTx(
  db: VelaDatabase,
  claimed: {
    session: SessionRecord
    runId: string
    inputs: readonly DriverInboxItem[]
  },
  status: RunEndStatus,
  detail?: string,
): void {
  const { session } = claimed
  if (
    !session.projectId ||
    (session.kind !== 'topic' && session.kind !== 'work')
  ) {
    return
  }
  const allPassive =
    claimed.inputs.length > 0 && claimed.inputs.every((item) => item.passive)
  if (allPassive) return
  const project = db.get<{ hub_session_id: string | null }>(
    'SELECT hub_session_id FROM projects WHERE id = ?',
    session.projectId,
  )
  const hubId = project?.hub_session_id
  if (!hubId || hubId === session.id) return
  const label = session.name
    ? `Session "${session.name}" (${session.id})`
    : `Session ${session.id}`
  const clipped = detail ? detail.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  const line =
    status === 'stopped'
      ? `${label} was stopped`
      : status === 'failed'
        ? `${label} failed: ${clipped || 'error'}`
        : status === 'waiting_human'
          ? `${label} is waiting for input: ${clipped || 'approval'}`
          : `${label} finished: ${clipped || '(no reply)'}`
  enqueueInboxEvent(db, {
    sessionId: hubId,
    projectId: session.projectId,
    source: 'handoff',
    dedupeKey: `child-status:${claimed.runId}:${status}`,
    wake: false,
    payload: {
      type: 'handoff_note',
      childSessionId: session.id,
      runId: claimed.runId,
      status,
      text: line,
    },
  })
}

async function stopExternalSessionRuns(params: {
  db: VelaDatabase
  activeOwners: ReadonlySet<string>
  sessionId: string
  reason: string
  isStopped: () => boolean
}): Promise<{ cancelled: boolean; stillOwnedRemotely: boolean }> {
  const { db, activeOwners, sessionId, reason, isStopped } = params
  const otherLiveRuns = db.all<{
    id: string
    owner_token: string | null
  }>(
    `SELECT id, owner_token FROM runs
     WHERE session_id = ? AND status IN ('queued', 'running')`,
    sessionId,
  )
  let cancelled = false
  const externalRunIds: string[] = []
  for (const run of otherLiveRuns) {
    if (!run.owner_token || !isOwnerLive(run.owner_token, activeOwners)) {
      continue
    }
    const abortedLocal = await abortLiveProcessOwner(run.owner_token, reason)
    if (abortedLocal) {
      cancelled = true
    } else {
      externalRunIds.push(run.id)
      db.run(
        `INSERT INTO kv_meta (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        `stop_requested:${run.id}`,
        JSON.stringify({ reason }),
        new Date().toISOString(),
      )
    }
  }
  if (externalRunIds.length > 0) {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && db.open && !isStopped()) {
      const placeholders = externalRunIds.map(() => '?').join(', ')
      const stillLive = db.get<{ id: string }>(
        `SELECT id FROM runs WHERE id IN (${placeholders}) AND status IN ('queued', 'running') LIMIT 1`,
        ...externalRunIds,
      )
      if (!stillLive) break
      await new Promise((r) => setTimeout(r, 25))
    }
    const placeholders = externalRunIds.map(() => '?').join(', ')
    const remaining = db.all<{
      id: string
      owner_token: string | null
    }>(
      `SELECT id, owner_token FROM runs WHERE id IN (${placeholders}) AND status IN ('queued', 'running')`,
      ...externalRunIds,
    )
    if (remaining.some((r) => isOwnerLive(r.owner_token, activeOwners))) {
      return { cancelled, stillOwnedRemotely: true }
    }
    cancelled = true
  }
  return { cancelled, stillOwnedRemotely: false }
}

export function stopSessionRunsInDb(
  db: VelaDatabase,
  session: SessionRecord | undefined,
  sessionId: string,
  reason: string,
  activeOwners: ReadonlySet<string> = new Set(),
): { cancelled: boolean; liveOtherRuns: boolean } {
  const now = new Date().toISOString()
  return db.transaction(() => {
    const rows = db.all<{
      id: string
      status: string
      owner_token: string | null
    }>(
      `SELECT id, status, owner_token FROM runs
       WHERE session_id = ? AND status IN ('queued', 'running', 'waiting_human')`,
      sessionId,
    )
    if (
      rows.some(
        (r) =>
          r.status === 'running' && isOwnerLive(r.owner_token, activeOwners),
      )
    ) {
      return { cancelled: false, liveOtherRuns: true }
    }
    if (rows.length === 0) {
      db.run(
        `UPDATE sessions SET state = 'idle', waiting_reason = NULL, updated_at = ?
         WHERE id = ? AND state IN ('running', 'waiting_human')`,
        now,
        sessionId,
      )
      return { cancelled: false, liveOtherRuns: false }
    }
    const placeholders = rows.map(() => '?').join(', ')
    const runIds = rows.map((r) => r.id)
    const updated = db.run(
      `UPDATE runs
       SET status = 'stopped', owner_token = NULL, finished_at = COALESCE(finished_at, ?), updated_at = ?
       WHERE id IN (${placeholders}) AND status IN ('queued', 'running', 'waiting_human')`,
      now,
      now,
      ...runIds,
    )
    for (const r of rows) {
      db.run(
        `UPDATE vela_tool_calls SET status = 'interrupted', updated_at = ?
         WHERE run_id = ? AND status IN ('pending', 'running', 'awaiting_approval')`,
        now,
        r.id,
      )
      db.run(
        'DELETE FROM kv_meta WHERE key IN (?, ?, ?, ?, ?)',
        `run_target:${r.id}`,
        `stop_requested:${r.id}`,
        `run_silent:${r.id}`,
        `run_handoff_depth:${r.id}`,
        `run_input_meta:${r.id}`,
      )
    }
    db.run(
      `UPDATE sessions SET state = 'idle', waiting_reason = NULL, updated_at = ?
       WHERE id = ? AND state IN ('running', 'waiting_human')`,
      now,
      sessionId,
    )
    const latestStoppedRun = rows.at(-1)
    if (session && latestStoppedRun) {
      recordChildStatusNoteForHubInTx(
        db,
        { session, runId: latestStoppedRun.id, inputs: [] },
        'stopped',
        reason,
      )
    }
    return { cancelled: updated.changes > 0, liveOtherRuns: false }
  })
}

export function canWakeSessionInDb(
  db: VelaDatabase,
  sessions: SessionStoreControl,
  sessionId: string,
  excludeInboxIds?: ReadonlySet<string>,
): boolean {
  if (!db.open) return false
  const session = sessions.get(sessionId)
  if (!session) return false
  if (session.kind === 'topic' && isTopicAwaitingBindingInDb(db, sessionId)) {
    return false
  }
  if (session.state === 'waiting_human') {
    const pendingApproval = db.get<{ id: string }>(
      `SELECT id FROM approvals WHERE session_id = ? AND status = 'pending' LIMIT 1`,
      sessionId,
    )
    if (pendingApproval) return false
    return Boolean(
      db.get<{ id: string }>(
        `SELECT id FROM inbox_events WHERE session_id = ? AND status = 'pending' AND source = 'approval' LIMIT 1`,
        sessionId,
      ),
    )
  }
  if (session.state !== 'idle') return false
  return hasSessionPendingWake(db, sessionId, excludeInboxIds)
}

export async function stopSessionInRuntime(params: {
  db: VelaDatabase
  sessions: SessionStoreControl
  drivers: ReadonlyMap<string, AgentDriver>
  eventBus: RuntimeEventBus
  backgroundJobs: BackgroundJobManager
  activeWorkers: ReadonlyMap<
    string,
    { controller: AbortController; promise: Promise<void> }
  >
  activeOwners: ReadonlySet<string>
  isDisposed: () => boolean
  sessionId: string
  reason: string
}): Promise<boolean> {
  const {
    db,
    sessions,
    drivers,
    eventBus,
    backgroundJobs,
    activeWorkers,
    activeOwners,
    isDisposed,
    sessionId,
    reason,
  } = params
  let cancelledRun = false
  let cancelledApprovals = 0
  let stoppedJobs = 0
  for (let pass = 0; pass < 2; pass++) {
    const active = activeWorkers.get(sessionId)
    if (active) {
      cancelledRun = true
      active.controller.abort(new DOMException(reason, 'AbortError'))
      const session = sessions.get(sessionId)
      const driver = session ? drivers.get(session.driver) : undefined
      await driver?.abort?.(sessionId)
      await active.promise.catch(() => {})
    }
    const external = await stopExternalSessionRuns({
      db,
      activeOwners,
      sessionId,
      reason,
      isStopped: isDisposed,
    })
    if (external.stillOwnedRemotely) return false
    if (external.cancelled) cancelledRun = true
    cancelledApprovals += cancelPendingApprovalsForSession(
      db,
      eventBus,
      sessionId,
      reason,
    )
    stoppedJobs += backgroundJobs.stopSessionJobs(sessionId)
    const dbStopped = stopSessionRunsInDb(
      db,
      sessions.get(sessionId),
      sessionId,
      reason,
      activeOwners,
    )
    if (dbStopped.cancelled) cancelledRun = true
    if (!dbStopped.liveOtherRuns) {
      return cancelledRun || cancelledApprovals > 0 || stoppedJobs > 0
    }
  }
  return false
}
