import { randomUUID } from 'node:crypto'
import type { VelaDatabase } from '../db/index.ts'
import type { SessionRecord, SessionStoreControl } from './domain.ts'
import {
  abortLiveProcessOwner,
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
  isTopicAwaitingBindingInDb,
  listProcessingInboxForRun,
  requeueProcessingForRunInTx,
} from './inbox.ts'
import { enqueueOutboxInTx } from './outbox.ts'

export { recoverRuntimeState } from './recovery.ts'

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

export function claimNextTurnInDb(params: {
  db: VelaDatabase
  sessions: SessionStoreControl
  eventBus: RuntimeEventBus
  activeOwners: ReadonlySet<string>
  sessionId: string
  ownerToken?: string
}): ClaimedTurn | undefined {
  const { db, sessions, eventBus, activeOwners, sessionId } = params
  const now = new Date().toISOString()
  const ownerToken =
    params.ownerToken ??
    `${PROCESS_OWNER_PREFIX}:${process.pid}:${randomUUID()}`

  return db.transaction(() => {
    const session = sessions.get(sessionId)
    if (!session) return undefined
    if (session.kind === 'topic' && isTopicAwaitingBindingInDb(db, sessionId)) {
      return undefined
    }

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
      const hasResolvedToolResume =
        batch.length > 0 ||
        Boolean(
          db.get<{ id: string }>(
            `SELECT id FROM approvals WHERE run_id = ? AND status != 'pending' LIMIT 1`,
            waitingRun.id,
          ),
        )
      if (!hasResolvedToolResume) return undefined
      const inputs =
        batch.length > 0
          ? batch.map((item) => ({
              id: item.id,
              source: item.source,
              wake: item.wake,
              passive: item.passive,
              payload: item.payload,
              createdAt: item.createdAt,
            }))
          : [
              {
                id: `resume-${waitingRun.id}`,
                source: 'approval',
                wake: true,
                passive: false,
                payload: { type: 'approval_resolved', runId: waitingRun.id },
                createdAt: now,
              },
            ]

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
        inputs,
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
  const stopRequested = Boolean(
    db.get<{ key: string }>(
      'SELECT key FROM kv_meta WHERE key = ?',
      `stop_requested:${claimed.runId}`,
    ),
  )
  const pendingApproval = !stopRequested
    ? db.get<{ id: string; summary: string }>(
        `SELECT id, summary FROM approvals WHERE run_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
        claimed.runId,
      )
    : undefined
  const finalStatus: RunEndStatus = stopRequested
    ? 'stopped'
    : pendingApproval
      ? 'waiting_human'
      : 'completed'
  const updatedRun = db.run(
    `UPDATE runs
     SET status = ?,
         error = NULL,
         owner_token = CASE WHEN ? = 'waiting_human' THEN owner_token ELSE NULL END,
         finished_at = ?,
         updated_at = ?
     WHERE id = ? AND owner_token = ?`,
    finalStatus,
    finalStatus,
    finalStatus === 'waiting_human' ? null : now,
    now,
    claimed.runId,
    claimed.ownerToken,
  )
  if (updatedRun.changes !== 1) {
    throw new LostRunOwnershipError(claimed.runId)
  }
  db.run('DELETE FROM kv_meta WHERE key = ?', `stop_requested:${claimed.runId}`)
  if (finalStatus !== 'waiting_human') {
    db.run(
      'DELETE FROM kv_meta WHERE key IN (?, ?, ?, ?)',
      `run_target:${claimed.runId}`,
      `run_silent:${claimed.runId}`,
      `run_handoff_depth:${claimed.runId}`,
      `run_input_meta:${claimed.runId}`,
    )
  }
  db.run(
    `UPDATE sessions
     SET state = ?, waiting_reason = ?, updated_at = ?
     WHERE id = ?`,
    finalStatus === 'waiting_human' ? 'waiting_human' : 'idle',
    finalStatus === 'waiting_human'
      ? (pendingApproval?.summary ?? 'approval')
      : null,
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
      status: finalStatus,
    },
  })
  if (
    (finalStatus === 'completed' || finalStatus === 'waiting_human') &&
    !outcome.silent &&
    outcome.replyText &&
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
      text: outcome.replyText,
    })
  }
  recordChildStatusNoteForHubInTx(
    db,
    claimed,
    finalStatus,
    pendingApproval?.summary ?? outcome.replyText,
  )
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
    const stopRequested = Boolean(
      db.get<{ key: string }>(
        'SELECT key FROM kv_meta WHERE key = ?',
        `stop_requested:${claimed.runId}`,
      ),
    )
    const pendingApproval = !stopRequested
      ? db.get<{ id: string; summary: string }>(
          `SELECT id, summary FROM approvals WHERE run_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
          claimed.runId,
        )
      : undefined
    const awaitingToolCall = !stopRequested
      ? db.get<{ id: string }>(
          `SELECT id FROM vela_tool_calls WHERE run_id = ? AND status = 'awaiting_approval' LIMIT 1`,
          claimed.runId,
        )
      : undefined
    const canWaitForHuman =
      !stopRequested &&
      (result.status === 'waiting_human' ||
        (result.status === 'completed' &&
          Boolean(pendingApproval || awaitingToolCall)))
    const status: RunEndStatus = canWaitForHuman
      ? 'waiting_human'
      : stopRequested
        ? 'stopped'
        : result.status
    const nextSessionState =
      status === 'waiting_human' ? 'waiting_human' : 'idle'

    const updatedRun = db.run(
      `UPDATE runs
       SET status = ?,
           error = ?,
           owner_token = CASE WHEN ? = 'waiting_human' THEN owner_token ELSE NULL END,
           finished_at = ?,
           updated_at = ?
       WHERE id = ? AND owner_token = ?`,
      status,
      status === 'waiting_human' ? null : (result.error ?? null),
      status,
      status === 'waiting_human' ? null : now,
      now,
      claimed.runId,
      claimed.ownerToken,
    )
    if (updatedRun.changes !== 1) {
      throw new LostRunOwnershipError(claimed.runId)
    }
    if (status !== 'waiting_human') {
      const orphanedApprovals = db.all<{ id: string }>(
        `SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'`,
        claimed.runId,
      )
      for (const app of orphanedApprovals) {
        db.run(
          `UPDATE approvals
           SET status = 'cancelled', decision_reason = COALESCE(decision_reason, ?), resolved_at = COALESCE(resolved_at, ?)
           WHERE id = ? AND status = 'pending'`,
          result.error ?? 'Run terminated before human reply',
          now,
          app.id,
        )
        eventBus.append({
          sessionId: claimed.session.id,
          projectId: claimed.session.projectId,
          runId: claimed.runId,
          payload: {
            type: 'approval_resolved',
            runId: claimed.runId,
            approvalId: app.id,
            decision: 'cancelled',
            reason: result.error ?? 'Run terminated before human reply',
          },
        })
      }
      db.run(
        'DELETE FROM kv_meta WHERE key IN (?, ?, ?, ?, ?)',
        `run_target:${claimed.runId}`,
        `stop_requested:${claimed.runId}`,
        `run_silent:${claimed.runId}`,
        `run_handoff_depth:${claimed.runId}`,
        `run_input_meta:${claimed.runId}`,
      )
    }
    db.run(
      `UPDATE sessions
       SET state = ?, waiting_reason = ?, updated_at = ?
       WHERE id = ?`,
      nextSessionState,
      nextSessionState === 'waiting_human'
        ? (pendingApproval?.summary ?? 'approval')
        : null,
      now,
      claimed.session.id,
    )
    if (status === 'interrupted') {
      requeueProcessingForRunInTx(db, claimed.runId)
    } else {
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
      (status === 'completed' || status === 'waiting_human') &&
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
    if (status !== 'interrupted') {
      recordChildStatusNoteForHubInTx(
        db,
        claimed,
        status,
        pendingApproval?.summary ?? result.error ?? result.replyText,
      )
    }
  })
}

function recordChildStatusNoteForHubInTx(
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

function outboxTargetFromInputs(
  inputs: readonly DriverInboxItem[],
): OutboxTarget | undefined {
  for (const requireWake of [true, false]) {
    for (let i = inputs.length - 1; i >= 0; i--) {
      const item = inputs[i]!
      const isRouteSource =
        item.source === 'channel' ||
        item.source === 'timer' ||
        (item.source === 'approval' && item.payload.waitForInput === true)
      if (!isRouteSource || item.passive) {
        continue
      }
      if (requireWake && !item.wake) continue
      const payload = item.payload
      if (
        typeof payload.channel === 'string' &&
        typeof payload.externalChatId === 'string'
      ) {
        const replyToMessageId =
          typeof payload.replyToMessageId === 'string'
            ? payload.replyToMessageId
            : typeof payload.messageId === 'string'
              ? payload.messageId
              : undefined
        return {
          channel: payload.channel,
          externalChatId: payload.externalChatId,
          ...(typeof payload.threadId === 'string'
            ? { threadId: payload.threadId }
            : {}),
          ...(replyToMessageId ? { replyToMessageId } : {}),
        }
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

export async function stopExternalSessionRuns(params: {
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
): boolean {
  const now = new Date().toISOString()
  return db.transaction(() => {
    const rows = db.all<{ id: string }>(
      `SELECT id FROM runs
       WHERE session_id = ? AND status IN ('queued', 'running', 'waiting_human')`,
      sessionId,
    )
    const updated = db.run(
      `UPDATE runs SET status = 'stopped', finished_at = COALESCE(finished_at, ?), updated_at = ?
       WHERE session_id = ? AND status IN ('queued', 'running', 'waiting_human')`,
      now,
      now,
      sessionId,
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
    return updated.changes > 0
  })
}
