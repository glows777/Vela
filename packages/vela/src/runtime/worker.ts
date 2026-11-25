import { randomUUID } from 'node:crypto'
import type { VelaDatabase } from '../db/index.ts'
import type { BackgroundJobManager } from './background-jobs.ts'
import type { SessionRecord, SessionStoreControl } from './domain.ts'
import {
  type DriverInboxItem,
  type DriverTerminalOutcome,
  type DriverTurnResult,
  isOwnerLive,
  LostRunOwnershipError,
  PROCESS_OWNER_PREFIX,
  type RunTrigger,
} from './driver.ts'
import type { RuntimeEventBus } from './event-bus.ts'
import type { RunEndStatus } from './events.ts'
import {
  claimApprovalInboxBatchInTx,
  claimInboxBatchInTx,
  completeInboxBatchInTx,
  enqueueInboxEvent,
  type InboxEventRecord,
  listProcessingInboxForRun,
  listSessionsWithPendingWake,
  requeueProcessingForRunInTx,
} from './inbox.ts'
import { enqueueOutboxInTx, type OutboxDispatcher } from './outbox.ts'
import type { TimerScheduler } from './timers.ts'

export interface ClaimedTurn {
  runId: string
  ownerToken: string
  session: SessionRecord
  trigger: RunTrigger
  inputs: DriverInboxItem[]
  recoverPending: boolean
  allowWaitingHuman: boolean
}

export interface OutboxTarget {
  channel: string
  externalChatId: string
  threadId?: string
  replyToMessageId?: string
}

function triggerFromInbox(inputs: readonly InboxEventRecord[]): RunTrigger {
  const firstWake = inputs.find((item) => item.wake) ?? inputs[0]
  if (!firstWake) return 'session'
  switch (firstWake.source) {
    case 'channel':
      return 'channel'
    case 'timer':
      return 'timer'
    case 'webhook':
      return 'webhook'
    case 'approval':
      return 'approval'
    case 'job':
      return 'job'
    case 'handoff':
      return 'handoff'
    case 'user':
      return 'user'
    default:
      return 'session'
  }
}

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
        sessionsToWake.add(run.session_id)
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
        requeuedInboxRuns.push(run.id)
        sessionsToWake.add(run.session_id)
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
      enqueueInboxEvent(db, {
        sessionId: run.session_id,
        projectId: run.project_id,
        source: 'approval',
        dedupeKey: `approval-resume:${run.id}`,
        wake: true,
        payload: { type: 'approval_resolved', runId: run.id },
      })
      sessionsToWake.add(run.session_id)
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
      db.run(
        `UPDATE inbox_events SET status = 'pending', run_id = NULL WHERE id = ?`,
        row.id,
      )
      if (row.session_id) sessionsToWake.add(row.session_id)
    }
  })

  timers.tick(nowMs)
  for (const sessionId of listSessionsWithPendingWake(db)) {
    sessionsToWake.add(sessionId)
  }
  return { interruptedJobs, recoveredRuns, requeuedInboxRuns, sessionsToWake }
}

export function claimNextTurnInDb(params: {
  db: VelaDatabase
  sessions: SessionStoreControl
  eventBus: RuntimeEventBus
  activeOwners: ReadonlySet<string>
  sessionId: string
}): ClaimedTurn | undefined {
  const { db, sessions, eventBus, activeOwners, sessionId } = params
  const now = new Date().toISOString()
  const ownerToken = `${PROCESS_OWNER_PREFIX}:${process.pid}:${randomUUID()}`

  return db.transaction(() => {
    const session = sessions.get(sessionId)
    if (!session) return undefined

    if (session.state === 'running') {
      const orphaned = db.get<{
        id: string
        trigger: RunTrigger
        owner_token: string | null
      }>(
        `SELECT id, trigger, owner_token FROM runs
         WHERE session_id = ? AND status = 'running'
         ORDER BY started_at DESC LIMIT 1`,
        sessionId,
      )
      if (!orphaned || isOwnerLive(orphaned.owner_token, activeOwners)) {
        return undefined
      }
      db.run(
        `UPDATE runs SET owner_token = ?, updated_at = ? WHERE id = ?`,
        ownerToken,
        now,
        orphaned.id,
      )
      const existingInputs = listProcessingInboxForRun(db, orphaned.id)
      eventBus.append({
        sessionId,
        projectId: session.projectId,
        runId: orphaned.id,
        payload: {
          type: 'run_started',
          runId: orphaned.id,
          trigger: orphaned.trigger,
        },
      })
      return {
        runId: orphaned.id,
        ownerToken,
        session,
        trigger: orphaned.trigger,
        inputs: existingInputs.map((item) => ({
          id: item.id,
          source: item.source,
          wake: item.wake,
          passive: item.passive,
          payload: item.payload,
          createdAt: item.createdAt,
        })),
        recoverPending: true,
        allowWaitingHuman: true,
      }
    }

    if (session.state === 'waiting_human') {
      const pendingApproval = db.get<{ id: string }>(
        `SELECT id FROM approvals WHERE session_id = ? AND status = 'pending' LIMIT 1`,
        sessionId,
      )
      if (pendingApproval) return undefined
      const waitingRun = db.get<{ id: string }>(
        `SELECT id FROM runs WHERE session_id = ? AND status = 'waiting_human' ORDER BY started_at DESC LIMIT 1`,
        sessionId,
      )
      if (!waitingRun) return undefined
      const batch = claimApprovalInboxBatchInTx(db, sessionId, waitingRun.id)
      if (!batch.length) return undefined

      db.run(
        `UPDATE runs SET status = 'running', owner_token = ?, updated_at = ? WHERE id = ?`,
        ownerToken,
        now,
        waitingRun.id,
      )
      db.run(
        `UPDATE sessions SET state = 'running', waiting_reason = NULL, updated_at = ? WHERE id = ?`,
        now,
        sessionId,
      )
      eventBus.append({
        sessionId,
        projectId: session.projectId,
        runId: waitingRun.id,
        payload: {
          type: 'run_started',
          runId: waitingRun.id,
          trigger: 'approval',
        },
      })
      return {
        runId: waitingRun.id,
        ownerToken,
        session: { ...session, state: 'running', waitingReason: null },
        trigger: 'approval',
        inputs: batch.map((item) => ({
          id: item.id,
          source: item.source,
          wake: item.wake,
          passive: item.passive,
          payload: item.payload,
          createdAt: item.createdAt,
        })),
        recoverPending: true,
        allowWaitingHuman: true,
      }
    }

    if (session.state !== 'idle') return undefined

    const runId = randomUUID()
    const batch = claimInboxBatchInTx(db, sessionId, runId)
    if (!batch.length) return undefined

    const trigger = triggerFromInbox(batch)
    db.run(
      `INSERT INTO runs (
         id, session_id, project_id, driver, trigger, status, model, owner_token, started_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      runId,
      sessionId,
      session.projectId,
      session.driver,
      trigger,
      session.model,
      ownerToken,
      now,
      now,
    )
    const inputs = batch.map((item) => ({
      id: item.id,
      source: item.source,
      wake: item.wake,
      passive: item.passive,
      payload: item.payload,
      createdAt: item.createdAt,
    }))
    const initialTarget = outboxTargetFromInputs(inputs)
    if (initialTarget) {
      db.run(
        `INSERT INTO kv_meta (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        `run_target:${runId}`,
        JSON.stringify(initialTarget),
        now,
      )
    }
    db.run(
      `UPDATE sessions SET state = 'running', waiting_reason = NULL, updated_at = ? WHERE id = ?`,
      now,
      sessionId,
    )
    eventBus.append({
      sessionId,
      projectId: session.projectId,
      runId,
      payload: { type: 'run_started', runId, trigger },
    })
    return {
      runId,
      ownerToken,
      session: { ...session, state: 'running', waitingReason: null },
      trigger,
      inputs,
      recoverPending: false,
      allowWaitingHuman: false,
    }
  })
}

export function commitCompletedTurnInTx(params: {
  db: VelaDatabase
  eventBus: RuntimeEventBus
  claimed: ClaimedTurn
  outcome: DriverTerminalOutcome
  outboxTarget?: OutboxTarget
}): void {
  const { db, eventBus, claimed, outcome, outboxTarget } = params
  const now = new Date().toISOString()
  const updatedRun = db.run(
    `UPDATE runs
     SET status = 'completed', error = NULL, finished_at = ?, updated_at = ?
     WHERE id = ? AND owner_token = ?`,
    now,
    now,
    claimed.runId,
    claimed.ownerToken,
  )
  if (updatedRun.changes !== 1) {
    throw new LostRunOwnershipError(claimed.runId)
  }
  db.run('DELETE FROM kv_meta WHERE key = ?', `run_target:${claimed.runId}`)
  db.run('DELETE FROM kv_meta WHERE key = ?', `stop_requested:${claimed.runId}`)
  db.run(
    `UPDATE sessions
     SET state = 'idle', waiting_reason = NULL, updated_at = ?
     WHERE id = ?`,
    now,
    claimed.session.id,
  )
  completeInboxBatchInTx(db, claimed.runId, now)
  eventBus.append({
    sessionId: claimed.session.id,
    projectId: claimed.session.projectId,
    runId: claimed.runId,
    payload: {
      type: 'run_finished',
      runId: claimed.runId,
      status: 'completed',
    },
  })
  if (!outcome.silent && outcome.replyText && outboxTarget) {
    enqueueOutboxInTx(db, {
      sessionId: claimed.session.id,
      runId: claimed.runId,
      channel: outboxTarget.channel,
      externalChatId: outboxTarget.externalChatId,
      threadId: outboxTarget.threadId,
      replyToMessageId: outboxTarget.replyToMessageId,
      kind: 'reply',
      text: outcome.replyText,
    })
  }
}

export function finalizeTurnInDb(params: {
  db: VelaDatabase
  eventBus: RuntimeEventBus
  claimed: ClaimedTurn
  result: DriverTurnResult
  outboxTarget?: OutboxTarget
}): void {
  const { db, eventBus, claimed, result, outboxTarget } = params
  const now = new Date().toISOString()
  db.transaction(() => {
    const hasPendingApproval = Boolean(
      db.get<{ id: string }>(
        `SELECT id FROM approvals WHERE run_id = ? AND status = 'pending' LIMIT 1`,
        claimed.runId,
      ),
    )
    const status: RunEndStatus =
      result.status === 'waiting_human' || hasPendingApproval
        ? 'waiting_human'
        : result.status
    const nextSessionState =
      status === 'waiting_human' ? 'waiting_human' : 'idle'

    const updatedRun = db.run(
      `UPDATE runs
       SET status = ?, error = ?, finished_at = ?, updated_at = ?
       WHERE id = ? AND owner_token = ?`,
      status,
      result.error ?? null,
      status === 'waiting_human' ? null : now,
      now,
      claimed.runId,
      claimed.ownerToken,
    )
    if (updatedRun.changes !== 1) {
      throw new LostRunOwnershipError(claimed.runId)
    }
    if (status !== 'waiting_human') {
      db.run('DELETE FROM kv_meta WHERE key = ?', `run_target:${claimed.runId}`)
      db.run(
        'DELETE FROM kv_meta WHERE key = ?',
        `stop_requested:${claimed.runId}`,
      )
    }
    db.run(
      `UPDATE sessions
       SET state = ?, waiting_reason = ?, updated_at = ?
       WHERE id = ?`,
      nextSessionState,
      nextSessionState === 'waiting_human' ? 'approval' : null,
      now,
      claimed.session.id,
    )
    if (status !== 'interrupted') {
      completeInboxBatchInTx(db, claimed.runId, now)
    }
    eventBus.append({
      sessionId: claimed.session.id,
      projectId: claimed.session.projectId,
      runId: claimed.runId,
      payload: {
        type: 'run_finished',
        runId: claimed.runId,
        status,
        ...(result.error ? { error: result.error } : {}),
      },
    })
    if (
      status === 'completed' &&
      !result.silent &&
      result.replyText &&
      outboxTarget
    ) {
      enqueueOutboxInTx(db, {
        sessionId: claimed.session.id,
        runId: claimed.runId,
        channel: outboxTarget.channel,
        externalChatId: outboxTarget.externalChatId,
        threadId: outboxTarget.threadId,
        replyToMessageId: outboxTarget.replyToMessageId,
        kind: 'reply',
        text: result.replyText,
      })
    }
  })
}

function outboxTargetFromInputs(
  inputs: readonly DriverInboxItem[],
): OutboxTarget | undefined {
  for (let i = inputs.length - 1; i >= 0; i--) {
    const payload = inputs[i]!.payload
    if (
      inputs[i]!.source === 'channel' &&
      typeof payload.channel === 'string' &&
      typeof payload.externalChatId === 'string'
    ) {
      return {
        channel: payload.channel,
        externalChatId: payload.externalChatId,
        ...(typeof payload.threadId === 'string'
          ? { threadId: payload.threadId }
          : {}),
        ...(typeof payload.messageId === 'string'
          ? { replyToMessageId: payload.messageId }
          : {}),
      }
    }
  }
  return undefined
}

export function resolveOutboxTargetInDb(
  db: VelaDatabase,
  session: SessionRecord,
  inputs: readonly DriverInboxItem[],
  runId?: string,
): OutboxTarget | undefined {
  const directInput = outboxTargetFromInputs(inputs)
  if (directInput) return directInput

  if (runId) {
    const stored = db.get<{ value_json: string }>(
      'SELECT value_json FROM kv_meta WHERE key = ?',
      `run_target:${runId}`,
    )
    if (stored) {
      try {
        const parsed = JSON.parse(stored.value_json) as OutboxTarget
        if (
          parsed &&
          typeof parsed.channel === 'string' &&
          typeof parsed.externalChatId === 'string'
        ) {
          return parsed
        }
      } catch {}
    }
  }

  const direct = db.get<{
    channel: string
    external_id: string
    thread_id: string | null
  }>(
    `SELECT channel, external_id, thread_id FROM channel_bindings
     WHERE session_id = ? AND enabled = 1
     ORDER BY created_at ASC LIMIT 1`,
    session.id,
  )
  if (direct) {
    return {
      channel: direct.channel,
      externalChatId: direct.external_id,
      ...(direct.thread_id ? { threadId: direct.thread_id } : {}),
    }
  }
  if (session.projectId && session.kind === 'hub') {
    const root = db.get<{ channel: string; external_id: string }>(
      `SELECT channel, external_id FROM channel_bindings
       WHERE project_id = ? AND thread_id IS NULL AND enabled = 1
       ORDER BY created_at ASC LIMIT 1`,
      session.projectId,
    )
    if (root) {
      return { channel: root.channel, externalChatId: root.external_id }
    }
  }
  return undefined
}
