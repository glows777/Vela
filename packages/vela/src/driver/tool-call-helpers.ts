import type { VelaDatabase } from '../db/index.ts'
import type { VelaEvent } from './agent/events.ts'
import { toolResultOutputToText } from './context/tool-result-output.ts'
import type { ExecutionEnv, ExecutionLocation } from './execution/types.ts'
import type { ToolResultOutput } from './messages.ts'
import type { SessionStore } from './session/index.ts'
import type { ToolDefinition, ToolRegistry } from './tools/registry.ts'

export interface VelaToolCallRow {
  id: string
  session_id: string
  run_id: string
  assistant_message_id: string
  tool_call_id: string
  call_index: number
  tool_name: string
  input_json: string
  execution_mode: 'parallel' | 'sequential'
  replay: 'safe' | 'none'
  location_json: string | null
  status:
    | 'pending'
    | 'running'
    | 'awaiting_approval'
    | 'completed'
    | 'failed'
    | 'skipped'
    | 'interrupted'
  attempt: number
  is_error: number
  preview: string | null
  result_json: string | null
  spill_path: string | null
  details_json: string | null
  duration_ms: number | null
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

export interface ExecuteStepCallsOptions {
  db: VelaDatabase
  store: SessionStore
  registry: ToolRegistry
  sessionId: string
  rows: VelaToolCallRow[]
  emit: (event: VelaEvent) => void
  signal?: AbortSignal
  isDraining?: () => boolean
  shouldSkipForSteer?: () => boolean
  isRecovery?: boolean
}

export interface ExecuteStepCallsResult {
  waitingHuman: boolean
}

export function outputPreviewText(output: ToolResultOutput): string {
  return toolResultOutputToText(output)
}

export function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function persistTerminalRow(
  db: VelaDatabase,
  row: VelaToolCallRow,
  status: 'completed' | 'failed' | 'skipped',
  output: ToolResultOutput,
  isError: boolean,
  options: {
    preview?: string
    spillPath?: string
    location?: ExecutionLocation
    details?: unknown
    durationMs?: number
    discoveredTools?: Iterable<string>
    store?: SessionStore
  } = {},
): void {
  const now = new Date().toISOString()
  const preview = options.preview ?? outputPreviewText(output)
  const resultJson = JSON.stringify(output)
  const locationJson = options.location
    ? JSON.stringify(options.location)
    : null
  const detailsJson =
    options.details === undefined ? null : JSON.stringify(options.details)
  db.transaction(() => {
    db.run(
      `UPDATE vela_tool_calls
       SET status = ?, is_error = ?, preview = ?, result_json = ?,
           spill_path = COALESCE(?, spill_path),
           location_json = COALESCE(?, location_json),
           details_json = ?, duration_ms = COALESCE(?, duration_ms),
           finished_at = ?, updated_at = ?
       WHERE id = ?`,
      status,
      isError ? 1 : 0,
      preview,
      resultJson,
      options.spillPath ?? null,
      locationJson,
      detailsJson,
      options.durationMs === undefined ? null : Math.round(options.durationMs),
      now,
      now,
      row.id,
    )
    if (options.discoveredTools && options.store) {
      options.store.syncDiscoveredToolsInTx(options.discoveredTools, now)
    }
  })
}

export function emitImmediateError(
  emit: (event: VelaEvent) => void,
  row: VelaToolCallRow,
  input: unknown,
  message: string,
): void {
  emit({
    type: 'tool_execution_start',
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    args: input,
  })
  emit({
    type: 'tool_execution_end',
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    result: message,
    isError: true,
    durationMs: 0,
  })
}

export async function failPrecheck(
  db: VelaDatabase,
  row: VelaToolCallRow,
  input: unknown,
  reason: string,
  emit: (event: VelaEvent) => void,
): Promise<void> {
  const output: ToolResultOutput = { type: 'error-text', value: reason }
  persistTerminalRow(db, row, 'failed', output, true, {
    preview: reason,
    durationMs: 0,
  })
  row.status = 'failed'
  row.is_error = 1
  row.preview = reason
  row.result_json = JSON.stringify(output)
  emitImmediateError(emit, row, input, reason)
}

export function markApprovalRequested(
  db: VelaDatabase,
  row: VelaToolCallRow,
  input: unknown,
  summary: string,
  emit: (event: VelaEvent) => void,
): void {
  const now = new Date().toISOString()
  const approvalId = crypto.randomUUID()
  const safeSummary = summary.trim() || `Approval required for ${row.tool_name}`
  const inputJson = JSON.stringify(input)
  db.transaction(() => {
    const res = db.run(
      `UPDATE vela_tool_calls
       SET status = 'awaiting_approval', input_json = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      inputJson,
      now,
      row.id,
    )
    if (res.changes !== 1) {
      throw new Error(
        `Tool call ${row.tool_call_id} changed state before entering approval`,
      )
    }
    db.run(
      `INSERT INTO approvals (
         id, session_id, run_id, tool_call_row_id, tool_call_id, tool_name, summary, input_json, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      approvalId,
      row.session_id,
      row.run_id,
      row.id,
      row.tool_call_id,
      row.tool_name,
      safeSummary,
      inputJson,
      now,
    )
  })
  row.status = 'awaiting_approval'
  row.input_json = inputJson
  emit({
    type: 'approval_requested',
    approvalId,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    summary: safeSummary,
    input:
      input !== null && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : { value: input },
  })
}

export function checkCallableTool(
  tool: ToolDefinition | undefined,
  toolName: string,
  registry: ToolRegistry,
  isDraining?: () => boolean,
): { ok: true; tool: ToolDefinition } | { ok: false; reason: string } {
  if (isDraining?.()) {
    return {
      ok: false,
      reason: `Tool ${toolName} was not executed because the session is shutting down`,
    }
  }
  if (tool?.hostedOnly || tool?.exposure === 'hidden') {
    return {
      ok: false,
      reason: `[Rejected] ${toolName} is unavailable${tool.hostedOnly ? ' locally' : ''}`,
    }
  }
  if (!tool || !registry.isAvailable(toolName)) {
    return {
      ok: false,
      reason: `[Rejected] ${toolName} is not enabled in this session`,
    }
  }
  return { ok: true, tool }
}

export function createLocatedEnvResolver(
  db: VelaDatabase,
  row: VelaToolCallRow,
  baseRequireEnv: (signal?: AbortSignal) => Promise<ExecutionEnv>,
  recoveryLocation: ExecutionLocation | undefined,
): {
  requireEnv: (signal?: AbortSignal) => Promise<ExecutionEnv>
  getLocation: () => ExecutionLocation | undefined
} {
  let located = Boolean(row.location_json)
  let currentLocation: ExecutionLocation | undefined = row.location_json
    ? (parseJsonSafe(row.location_json) as ExecutionLocation)
    : undefined
  return {
    getLocation: () => currentLocation,
    requireEnv: async (envSignal?: AbortSignal) => {
      const env = await baseRequireEnv(envSignal)
      const envLoc: ExecutionLocation = { environment: env.id, cwd: env.cwd }
      if (
        recoveryLocation &&
        JSON.stringify(envLoc) !== JSON.stringify(recoveryLocation)
      ) {
        throw new Error(
          `Tool ${row.tool_name} was interrupted by a restart and may have partially run; its location changed, so it was not replayed`,
        )
      }
      currentLocation = envLoc
      if (!located && row.replay === 'safe') {
        located = true
        const locJson = JSON.stringify(envLoc)
        row.location_json = locJson
        db.run(
          'UPDATE vela_tool_calls SET location_json = ?, updated_at = ? WHERE id = ?',
          locJson,
          new Date().toISOString(),
          row.id,
        )
      }
      return env
    },
  }
}
