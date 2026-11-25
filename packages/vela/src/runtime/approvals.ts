import { randomUUID } from 'node:crypto'
import type { VelaDatabase } from '../db/index.ts'
import type { RuntimeEventBus } from './event-bus.ts'
import { enqueueInboxEvent } from './inbox.ts'

type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'cancelled'

export interface ApprovalRecord {
  id: string
  sessionId: string
  runId: string
  toolCallRowId: string | null
  toolCallId: string | null
  toolName: string
  summary: string
  input: unknown
  status: ApprovalStatus
  decisionReason: string | null
  decidedBy: string | null
  createdAt: string
  resolvedAt: string | null
}

type ApprovalRow = {
  id: string
  session_id: string
  run_id: string
  tool_call_row_id: string | null
  tool_call_id: string | null
  tool_name: string
  summary: string
  input_json: string | null
  status: string
  decision_reason: string | null
  decided_by: string | null
  created_at: string
  resolved_at: string | null
}

function rowToApproval(row: ApprovalRow): ApprovalRecord {
  let input: unknown
  if (row.input_json !== null) {
    try {
      input = JSON.parse(row.input_json)
    } catch {
      input = row.input_json
    }
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    toolCallRowId: row.tool_call_row_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    summary: row.summary,
    input,
    status: row.status as ApprovalStatus,
    decisionReason: row.decision_reason,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

/**
 * Shared transition helper used by both `Runtime` approvals and `driver/step-recovery.ts`
 * so `approvals` decisions update `vela_tool_calls` consistently.
 */
export function syncToolCallForApprovalDecisionInTx(
  db: VelaDatabase,
  params: {
    sessionId: string
    runId: string
    toolCallRowId: string | null
    toolCallId: string | null
    toolName: string
    decision: 'approved' | 'denied' | 'cancelled'
    reason?: string
    now: string
  },
): void {
  if (!params.toolCallRowId && !params.toolCallId) return
  if (params.decision === 'approved') {
    if (params.toolCallRowId) {
      db.run(
        `UPDATE vela_tool_calls
         SET status = 'pending', updated_at = ?
         WHERE id = ? AND status = 'awaiting_approval'`,
        params.now,
        params.toolCallRowId,
      )
    } else {
      db.run(
        `UPDATE vela_tool_calls
         SET status = 'pending', updated_at = ?
         WHERE session_id = ? AND run_id = ? AND tool_call_id = ? AND status = 'awaiting_approval'`,
        params.now,
        params.sessionId,
        params.runId,
        params.toolCallId,
      )
    }
    return
  }

  const label = params.decision === 'cancelled' ? 'Cancelled' : 'Denied'
  const verb = params.decision === 'cancelled' ? 'cancelled' : 'denied'
  const text = params.reason
    ? `[${label}] ${params.reason}`
    : `[${label}] ${params.toolName} was ${verb} by user`
  const out = JSON.stringify({ type: 'error-text', value: text })
  if (params.toolCallRowId) {
    db.run(
      `UPDATE vela_tool_calls
       SET status = 'failed', is_error = 1, preview = ?, result_json = ?,
           finished_at = ?, updated_at = ?
       WHERE id = ? AND status = 'awaiting_approval'`,
      text,
      out,
      params.now,
      params.now,
      params.toolCallRowId,
    )
  } else {
    db.run(
      `UPDATE vela_tool_calls
       SET status = 'failed', is_error = 1, preview = ?, result_json = ?,
           finished_at = ?, updated_at = ?
       WHERE session_id = ? AND run_id = ? AND tool_call_id = ? AND status = 'awaiting_approval'`,
      text,
      out,
      params.now,
      params.now,
      params.sessionId,
      params.runId,
      params.toolCallId,
    )
  }
}

export function createApprovalRequest(
  db: VelaDatabase,
  eventBus: RuntimeEventBus,
  input: {
    id?: string
    sessionId: string
    projectId: string | null
    runId: string
    toolCallRowId?: string | null
    toolCallId?: string | null
    toolName: string
    summary: string
    input?: unknown
  },
): ApprovalRecord {
  const id = input.id ?? randomUUID()
  const now = new Date().toISOString()
  const inputJson =
    input.input === undefined ? null : JSON.stringify(input.input)
  return db.transaction(() => {
    db.run(
      `INSERT INTO approvals (
         id, session_id, run_id, tool_call_row_id, tool_call_id, tool_name,
         summary, input_json, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id,
      input.sessionId,
      input.runId,
      input.toolCallRowId ?? null,
      input.toolCallId ?? null,
      input.toolName,
      input.summary,
      inputJson,
      now,
    )
    eventBus.append({
      sessionId: input.sessionId,
      projectId: input.projectId,
      runId: input.runId,
      payload: {
        type: 'approval_requested',
        runId: input.runId,
        approvalId: id,
        toolCallId: input.toolCallId ?? id,
        toolName: input.toolName,
        summary: input.summary,
        input: input.input ?? {},
      },
    })
    const row = db.get<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', id)!
    return rowToApproval(row)
  })
}

export function listRuntimePendingApprovals(
  db: VelaDatabase,
  sessionId?: string,
): ApprovalRecord[] {
  const rows = sessionId
    ? db.all<ApprovalRow>(
        `SELECT * FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC`,
        sessionId,
      )
    : db.all<ApprovalRow>(
        `SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC`,
      )
  return rows.map(rowToApproval)
}

export function resolveRuntimeApproval(
  db: VelaDatabase,
  eventBus: RuntimeEventBus,
  input: {
    approvalId: string
    decision: 'approved' | 'denied' | 'cancelled'
    reason?: string
    decidedBy?: string
    enqueueWake?: boolean
  },
): { approval: ApprovalRecord; shouldWake: boolean } {
  const now = new Date().toISOString()
  return db.transaction(() => {
    const row = db.get<ApprovalRow>(
      'SELECT * FROM approvals WHERE id = ?',
      input.approvalId,
    )
    if (!row) throw new Error(`Approval ${input.approvalId} not found`)
    if (row.status !== 'pending') {
      throw new Error(
        `Approval ${input.approvalId} is already ${row.status} and cannot be resolved again`,
      )
    }

    db.run(
      `UPDATE approvals
       SET status = ?, decision_reason = ?, decided_by = ?, resolved_at = ?
       WHERE id = ?`,
      input.decision,
      input.reason ?? null,
      input.decidedBy ?? null,
      now,
      row.id,
    )

    syncToolCallForApprovalDecisionInTx(db, {
      sessionId: row.session_id,
      runId: row.run_id,
      toolCallRowId: row.tool_call_row_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      decision: input.decision,
      reason: input.reason,
      now,
    })

    const sessionRow = db.get<{ project_id: string | null }>(
      'SELECT project_id FROM sessions WHERE id = ?',
      row.session_id,
    )
    eventBus.append({
      sessionId: row.session_id,
      projectId: sessionRow?.project_id ?? null,
      runId: row.run_id,
      payload: {
        type: 'approval_resolved',
        runId: row.run_id,
        approvalId: row.id,
        decision: input.decision,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.decidedBy ? { decidedBy: input.decidedBy } : {}),
      },
    })

    const remaining = db.get<{ id: string }>(
      `SELECT id FROM approvals WHERE run_id = ? AND status = 'pending' LIMIT 1`,
      row.run_id,
    )
    const shouldWake =
      !remaining &&
      input.decision !== 'cancelled' &&
      input.enqueueWake !== false
    if (shouldWake) {
      enqueueInboxEvent(db, {
        sessionId: row.session_id,
        projectId: sessionRow?.project_id ?? null,
        source: 'approval',
        dedupeKey: `approval:${row.id}`,
        wake: true,
        payload: {
          type: 'approval_resolved',
          approvalId: row.id,
          runId: row.run_id,
          decision: input.decision,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.decidedBy ? { decidedBy: input.decidedBy } : {}),
        },
      })
    }

    const updated = db.get<ApprovalRow>(
      'SELECT * FROM approvals WHERE id = ?',
      row.id,
    )!
    return { approval: rowToApproval(updated), shouldWake }
  })
}

export function cancelPendingApprovalsForSession(
  db: VelaDatabase,
  eventBus: RuntimeEventBus,
  sessionId: string,
  reason = 'Cancelled by session control action',
): number {
  return db.transaction(() => {
    const pending = listRuntimePendingApprovals(db, sessionId)
    for (const item of pending) {
      resolveRuntimeApproval(db, eventBus, {
        approvalId: item.id,
        decision: 'cancelled',
        reason,
        enqueueWake: false,
      })
    }
    return pending.length
  })
}
