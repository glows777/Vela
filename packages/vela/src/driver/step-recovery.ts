import type { VelaDatabase } from '../db/index.ts'
import type { VelaEvent } from './agent/events.ts'
import type {
  AssistantModelMessage,
  ModelMessage,
  ToolCallPart,
  ToolModelMessage,
  ToolResultOutput,
  ToolResultPart,
} from './messages.ts'
import type { SessionStore } from './session/index.ts'
import { pendingToolCalls } from './session/recovery.ts'
import { executeStepCalls, type VelaToolCallRow } from './tool-executor.ts'
import type { ToolRegistry } from './tools/registry.ts'

export interface ApprovalDecision {
  approved: boolean
  reason?: string
  decidedBy?: string
}

export interface ResolvedApprovalInfo {
  id: string
  runId: string
  toolCallId: string | null
  toolName: string
  status: 'approved' | 'denied'
}

export interface PendingApprovalInfo {
  id: string
  runId: string
  toolCallId: string | null
  toolName: string
  summary: string | null
  input: unknown
  createdAt: string
}

export interface RecoverStepResult {
  recovered: boolean
  waitingHuman: boolean
  toolMessage?: ToolModelMessage
  details?: Record<string, unknown>
}

/** Lists pending human approval requests for `sessionId` in creation order. */
export function listPendingApprovals(
  db: VelaDatabase,
  sessionId: string,
): PendingApprovalInfo[] {
  const rows = db.all<{
    id: string
    run_id: string
    tool_call_id: string | null
    tool_name: string
    summary: string | null
    input_json: string | null
    created_at: string
  }>(
    `SELECT id, run_id, tool_call_id, tool_name, summary, input_json, created_at
     FROM approvals
     WHERE session_id = ? AND status = 'pending'
     ORDER BY created_at ASC`,
    sessionId,
  )
  return rows.map((row) => {
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
      runId: row.run_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      summary: row.summary,
      input,
      createdAt: row.created_at,
    }
  })
}

/** Resolve a pending human approval row and transition its corresponding tool call row. */
export function resolveApproval(
  db: VelaDatabase,
  sessionId: string,
  approvalId: string,
  decision: ApprovalDecision,
): ResolvedApprovalInfo {
  const now = new Date().toISOString()
  const nextStatus: 'approved' | 'denied' = decision.approved
    ? 'approved'
    : 'denied'
  return db.transaction(() => {
    const approval = db.get<{
      id: string
      run_id: string
      tool_call_id: string | null
      tool_name: string
      status: string
    }>(
      'SELECT id, run_id, tool_call_id, tool_name, status FROM approvals WHERE id = ? AND session_id = ?',
      approvalId,
      sessionId,
    )
    if (!approval) {
      throw new Error(
        `Approval ${approvalId} not found in session ${sessionId}`,
      )
    }
    if (approval.status !== 'pending') {
      throw new Error(
        `Approval ${approvalId} is already ${approval.status} and cannot be resolved again`,
      )
    }
    db.run(
      `UPDATE approvals
       SET status = ?, decision_reason = ?, decided_by = ?, resolved_at = ?
       WHERE id = ?`,
      nextStatus,
      decision.reason ?? null,
      decision.decidedBy ?? null,
      now,
      approvalId,
    )
    if (approval.tool_call_id) {
      if (decision.approved) {
        db.run(
          `UPDATE vela_tool_calls
           SET status = 'pending', updated_at = ?
           WHERE session_id = ? AND run_id = ? AND tool_call_id = ? AND status = 'awaiting_approval'`,
          now,
          sessionId,
          approval.run_id,
          approval.tool_call_id,
        )
      } else {
        const reason = decision.reason
          ? `[Denied] ${decision.reason}`
          : `[Denied] ${approval.tool_name} was denied by user`
        const out: ToolResultOutput = { type: 'error-text', value: reason }
        db.run(
          `UPDATE vela_tool_calls
           SET status = 'failed', is_error = 1, preview = ?, result_json = ?,
               finished_at = ?, updated_at = ?
           WHERE session_id = ? AND run_id = ? AND tool_call_id = ? AND status = 'awaiting_approval'`,
          reason,
          JSON.stringify(out),
          now,
          now,
          sessionId,
          approval.run_id,
          approval.tool_call_id,
        )
      }
    }
    return {
      id: approval.id,
      runId: approval.run_id,
      toolCallId: approval.tool_call_id,
      toolName: approval.tool_name,
      status: nextStatus,
    }
  })
}

/** Finds the unresolved assistant step on the active branch (and validates no trailing user messages exist). */
function findUnresolvedAssistantStep(
  store: SessionStore,
  messages: readonly ModelMessage[],
):
  | { entryId: string; assistant: AssistantModelMessage; calls: ToolCallPart[] }
  | undefined {
  const unresolved = pendingToolCalls(messages)
  if (!unresolved.length) return undefined
  const branch = store.getBranch()
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!
    if (
      entry.type === 'message' &&
      !entry.stopReason &&
      entry.message.role === 'assistant' &&
      Array.isArray(entry.message.content)
    ) {
      const clientCalls = entry.message.content.filter(
        (part): part is ToolCallPart =>
          part.type === 'tool_call' && !part.providerExecuted,
      )
      if (clientCalls.length) {
        return {
          entryId: entry.id,
          assistant: entry.message,
          calls: clientCalls,
        }
      }
    }
  }
  return undefined
}

export function loadStepToolCallRows(
  db: VelaDatabase,
  sessionId: string,
  assistantMessageId: string,
): VelaToolCallRow[] {
  return db.all<Record<string, unknown>>(
    `SELECT * FROM vela_tool_calls
     WHERE session_id = ? AND assistant_message_id = ?
     ORDER BY call_index ASC`,
    sessionId,
    assistantMessageId,
  ) as unknown as VelaToolCallRow[]
}

const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'skipped',
  'interrupted',
])

/** Build the single ordered `role: 'tool'` message from terminal `vela_tool_calls` rows. */
export function assembleCompletedToolMessage(
  rows: readonly VelaToolCallRow[],
): { message: ToolModelMessage; details: Record<string, unknown> } {
  const content: ToolResultPart[] = []
  const details: Record<string, unknown> = {}
  const sorted = [...rows].sort((a, b) => a.call_index - b.call_index)
  for (const row of sorted) {
    if (!TERMINAL_STATUSES.has(row.status)) {
      throw new Error(
        `Cannot assemble tool message while call ${row.tool_call_id} is ${row.status}`,
      )
    }
    const output: ToolResultOutput = row.result_json
      ? (JSON.parse(row.result_json) as ToolResultOutput)
      : {
          type: row.is_error ? 'error-text' : 'text',
          value: row.preview ?? '',
        }
    content.push({
      type: 'tool_result',
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      output,
    })
    if (row.details_json) {
      details[row.tool_call_id] = JSON.parse(row.details_json)
    }
  }
  return { message: { role: 'tool', content }, details }
}

/**
 * Reconcile an unresolved assistant step on recovery / approval resume using `vela_tool_calls`.
 * Only emits a `role: 'tool'` message once EVERY call in the step has settled.
 */
export async function recoverPendingStep(options: {
  db: VelaDatabase
  store: SessionStore
  registry: ToolRegistry
  sessionId: string
  messages: ModelMessage[]
  runId: string
  emit: (event: VelaEvent) => void
  isDraining?: () => boolean
  signal?: AbortSignal
}): Promise<RecoverStepResult> {
  const {
    db,
    store,
    registry,
    sessionId,
    messages,
    runId,
    emit,
    isDraining,
    signal,
  } = options
  const step = findUnresolvedAssistantStep(store, messages)
  if (!step) return { recovered: false, waitingHuman: false }

  let rows = loadStepToolCallRows(db, sessionId, step.entryId)
  if (rows.length === 0) {
    // Backfill interrupted placeholders if an unresolved assistant message lacked rows.
    const now = new Date().toISOString()
    db.transaction(() => {
      for (const [idx, call] of step.calls.entries()) {
        const msg = `Tool ${call.toolName} was interrupted by a restart and may have partially run. Do not blindly repeat it; verify its effects first.`
        db.run(
          `INSERT INTO vela_tool_calls (
             id, session_id, run_id, assistant_message_id, tool_call_id, call_index,
             tool_name, input_json, execution_mode, replay, status, attempt,
             is_error, preview, result_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sequential', 'none', 'interrupted', 1, 1, ?, ?, ?, ?)`,
          crypto.randomUUID(),
          sessionId,
          runId,
          step.entryId,
          call.toolCallId,
          idx,
          call.toolName,
          JSON.stringify(call.input ?? {}),
          msg,
          JSON.stringify({ type: 'error-text', value: msg }),
          now,
          now,
        )
      }
    })
    rows = loadStepToolCallRows(db, sessionId, step.entryId)
  }

  let hasPendingApproval = false
  const now = new Date().toISOString()

  for (const row of rows) {
    signal?.throwIfAborted()
    if (TERMINAL_STATUSES.has(row.status)) continue
    if (row.status === 'awaiting_approval') {
      const approval = db.get<{
        status: string
        decision_reason: string | null
      }>(
        `SELECT status, decision_reason FROM approvals
         WHERE session_id = ? AND run_id = ? AND tool_call_id = ?
         ORDER BY created_at DESC LIMIT 1`,
        sessionId,
        row.run_id,
        row.tool_call_id,
      )
      if (!approval || approval.status === 'pending') {
        hasPendingApproval = true
      } else if (approval.status === 'approved') {
        db.run(
          `UPDATE vela_tool_calls SET status = 'pending', updated_at = ? WHERE id = ?`,
          now,
          row.id,
        )
        row.status = 'pending'
      } else {
        const reason = approval.decision_reason
          ? `[Denied] ${approval.decision_reason}`
          : `[Denied] ${row.tool_name} approval was ${approval.status}`
        const out: ToolResultOutput = { type: 'error-text', value: reason }
        db.run(
          `UPDATE vela_tool_calls
           SET status = 'failed', is_error = 1, preview = ?, result_json = ?, finished_at = ?, updated_at = ?
           WHERE id = ?`,
          reason,
          JSON.stringify(out),
          now,
          now,
          row.id,
        )
        row.status = 'failed'
        row.is_error = 1
        row.preview = reason
        row.result_json = JSON.stringify(out)
      }
      continue
    }

    if (row.status === 'running') {
      const tool = registry.get(row.tool_name)
      const safe = row.replay === 'safe' && tool?.replay === 'safe'
      if (row.attempt >= 5) {
        const msg = `Tool ${row.tool_name} was interrupted ${row.attempt} times in a row; it is not run again`
        const out: ToolResultOutput = { type: 'error-text', value: msg }
        db.run(
          `UPDATE vela_tool_calls
           SET status = 'failed', is_error = 1, preview = ?, result_json = ?, finished_at = ?, updated_at = ?
           WHERE id = ?`,
          msg,
          JSON.stringify(out),
          now,
          now,
          row.id,
        )
        row.status = 'failed'
        row.is_error = 1
        row.preview = msg
        row.result_json = JSON.stringify(out)
      } else if (!safe) {
        const msg = `Tool ${row.tool_name} was interrupted by a restart and may have partially run. Do not blindly repeat it; verify its effects first.`
        const out: ToolResultOutput = { type: 'error-text', value: msg }
        db.run(
          `UPDATE vela_tool_calls
           SET status = 'interrupted', is_error = 1, preview = ?, result_json = ?, finished_at = ?, updated_at = ?
           WHERE id = ?`,
          msg,
          JSON.stringify(out),
          now,
          now,
          row.id,
        )
        row.status = 'interrupted'
        row.is_error = 1
        row.preview = msg
        row.result_json = JSON.stringify(out)
      }
      // Safe replay rows keep `status = 'running'` so executeStepCalls runs TX2a/TX2b.
    }
  }

  const needsExecution = rows.some(
    (row) => row.status === 'pending' || row.status === 'running',
  )
  if (needsExecution) {
    const execResult = await executeStepCalls({
      db,
      store,
      registry,
      sessionId,
      rows,
      emit,
      signal,
      isDraining,
      isRecovery: true,
    })
    if (execResult.waitingHuman) hasPendingApproval = true
  }

  const refreshed = loadStepToolCallRows(db, sessionId, step.entryId)
  if (
    hasPendingApproval ||
    refreshed.some((row) => !TERMINAL_STATUSES.has(row.status))
  ) {
    return { recovered: false, waitingHuman: true }
  }

  const { message, details } = assembleCompletedToolMessage(refreshed)
  return { recovered: true, waitingHuman: false, toolMessage: message, details }
}
