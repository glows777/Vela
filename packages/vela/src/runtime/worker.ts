import { randomUUID } from 'node:crypto'
import type { VelaDatabase } from '../db/index.ts'
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
  type InboxEventRecord,
  isTopicAwaitingBindingInDb,
  listProcessingInboxForRun,
  requeueProcessingForRunInTx,
} from './inbox.ts'
import { enqueueOutboxInTx } from './outbox.ts'
import { recordChildStatusNoteForHubInTx } from './recovery.ts'

export {
  canWakeSessionInDb,
  recoverRuntimeState,
  stopSessionInRuntime,
  stopSessionRunsInDb,
} from './recovery.ts'

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
  recipientId?: string
  mentionRecipient?: boolean
  isRoutine?: boolean
  isHandoff?: boolean
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
    const initialTarget =
      outboxTargetFromInputs(inputs) ??
      (inputs.some(
        (i) =>
          i.wake &&
          !i.passive &&
          i.source === 'handoff' &&
          i.payload.type !== 'handoff_note',
      )
        ? resolveOutboxTargetInDb(db, session, inputs)
        : undefined)
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
     WHERE id = ? AND owner_token = ? AND status IN ('queued', 'running', 'waiting_human')`,
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
      recipientId: outboxTarget.recipientId,
      mentionRecipient: outboxTarget.mentionRecipient,
      isRoutine: outboxTarget.isRoutine,
      isHandoff: outboxTarget.isHandoff,
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
       WHERE id = ? AND owner_token = ? AND status IN ('queued', 'running', 'waiting_human')`,
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
      const hasProgress = Boolean(
        db.get<{ ok: number }>(
          `SELECT 1 AS ok FROM vela_messages WHERE session_id = ? AND run_id = ? LIMIT 1`,
          claimed.session.id,
          claimed.runId,
        ) ??
          db.get<{ ok: number }>(
            `SELECT 1 AS ok FROM vela_tool_calls WHERE session_id = ? AND run_id = ? LIMIT 1`,
            claimed.session.id,
            claimed.runId,
          ),
      )
      if (hasProgress) {
        completeInboxBatchInTx(db, claimed.runId, now)
      } else {
        requeueProcessingForRunInTx(db, claimed.runId)
      }
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
        ...(result.errorKind ? { errorKind: result.errorKind } : {}),
        ...(result.errorHint ? { errorHint: result.errorHint } : {}),
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
        recipientId: outboxTarget.recipientId,
        mentionRecipient: outboxTarget.mentionRecipient,
        isRoutine: outboxTarget.isRoutine,
        isHandoff: outboxTarget.isHandoff,
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

function inputFlagsFromInputs(inputs: readonly DriverInboxItem[]): {
  isHandoff?: true
  mentionRecipient?: true
} {
  const hasHandoff = inputs.some(
    (item) =>
      item.wake &&
      !item.passive &&
      item.source === 'handoff' &&
      item.payload.type !== 'handoff_note',
  )
  const hasMention = inputs.some(
    (item) =>
      item.wake && !item.passive && item.payload.mentionRecipient === true,
  )
  return {
    ...(hasHandoff ? { isHandoff: true } : {}),
    ...(hasMention ? { mentionRecipient: true } : {}),
  }
}

function outboxTargetFromInputs(
  inputs: readonly DriverInboxItem[],
): OutboxTarget | undefined {
  const flags = inputFlagsFromInputs(inputs)
  for (const requireWake of [true, false]) {
    for (let i = inputs.length - 1; i >= 0; i--) {
      const item = inputs[i]!
      const isRouteSource =
        item.source === 'channel' ||
        item.source === 'timer' ||
        item.source === 'webhook' ||
        item.source === 'handoff' ||
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
        const recipientId =
          typeof payload.senderId === 'string' && payload.senderId
            ? payload.senderId
            : typeof payload.creatorId === 'string' && payload.creatorId
              ? payload.creatorId
              : undefined
        const isRoutine = item.source === 'timer' && payload.kind === 'routine'
        return {
          channel: payload.channel,
          externalChatId: payload.externalChatId,
          ...(typeof payload.threadId === 'string'
            ? { threadId: payload.threadId }
            : {}),
          ...(replyToMessageId ? { replyToMessageId } : {}),
          ...(recipientId ? { recipientId } : {}),
          ...(flags.mentionRecipient || payload.mentionRecipient === true
            ? { mentionRecipient: true }
            : {}),
          ...(isRoutine ? { isRoutine: true } : {}),
          ...(flags.isHandoff ? { isHandoff: true } : {}),
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

  const flags = inputFlagsFromInputs(inputs)
  const applyFlags = (target: OutboxTarget): OutboxTarget =>
    flags.isHandoff || flags.mentionRecipient
      ? {
          ...target,
          ...(flags.isHandoff ? { isHandoff: true } : {}),
          ...(flags.mentionRecipient ? { mentionRecipient: true } : {}),
        }
      : target

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
          return applyFlags(parsed)
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
    return applyFlags({
      channel: direct.channel,
      externalChatId: direct.external_id,
      ...(direct.thread_id ? { threadId: direct.thread_id } : {}),
    })
  }
  if (session.projectId && session.kind === 'hub') {
    const root = db.get<{ channel: string; external_id: string }>(
      `SELECT channel, external_id FROM channel_bindings
       WHERE project_id = ? AND thread_id IS NULL AND enabled = 1
       ORDER BY created_at ASC LIMIT 1`,
      session.projectId,
    )
    if (root) {
      return applyFlags({
        channel: root.channel,
        externalChatId: root.external_id,
      })
    }
  }
  return undefined
}
