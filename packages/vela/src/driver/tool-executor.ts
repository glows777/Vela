import type { VelaDatabase } from '../db/index.ts'
import type { VelaEvent } from './agent/events.ts'
import { ABORTED_RESULT, errorMessageOf } from './agent/step.ts'
import { toolResultOutputToText } from './context/tool-result-output.ts'
import type { ExecutionEnv, ExecutionLocation } from './execution/types.ts'
import {
  isToolContent,
  normalizeToolContent,
  type ToolResultOutput,
  toolContentText,
} from './messages.ts'
import type { SessionStore } from './session/index.ts'
import { prepareCallResult } from './tools/call-result.ts'
import {
  createLazyEnvResolver,
  errorOutput,
  normalOutput,
} from './tools/recovery.ts'
import type { ToolDefinition, ToolRegistry } from './tools/registry.ts'
import {
  type InterceptionContext,
  SpilledToolOutput,
  ToolExecutionResult,
  type ToolInterception,
  ToolResultError,
} from './tools/types.ts'
import { validateInput } from './tools/validation.ts'

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

function outputPreviewText(output: ToolResultOutput): string {
  return toolResultOutputToText(output)
}

function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function persistTerminalRow(
  db: VelaDatabase,
  row: VelaToolCallRow,
  status: 'completed' | 'failed' | 'skipped',
  output: ToolResultOutput,
  isError: boolean,
  options: {
    preview?: string
    spillPath?: string
    details?: unknown
    durationMs?: number
    discoveredTools?: Iterable<string>
    store?: SessionStore
  } = {},
): void {
  const now = new Date().toISOString()
  const preview = options.preview ?? outputPreviewText(output)
  const resultJson = JSON.stringify(output)
  const detailsJson =
    options.details === undefined ? null : JSON.stringify(options.details)
  db.transaction(() => {
    db.run(
      `UPDATE vela_tool_calls
       SET status = ?, is_error = ?, preview = ?, result_json = ?,
           spill_path = COALESCE(?, spill_path),
           details_json = ?, duration_ms = COALESCE(?, duration_ms),
           finished_at = ?, updated_at = ?
       WHERE id = ?`,
      status,
      isError ? 1 : 0,
      preview,
      resultJson,
      options.spillPath ?? null,
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

function emitImmediateError(
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

async function failPrecheck(
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

function markApprovalRequested(
  db: VelaDatabase,
  row: VelaToolCallRow,
  input: unknown,
  summary: string,
  emit: (event: VelaEvent) => void,
): void {
  const now = new Date().toISOString()
  const approvalId = crypto.randomUUID()
  const inputJson = JSON.stringify(input)
  db.transaction(() => {
    db.run(
      `UPDATE vela_tool_calls
       SET status = 'awaiting_approval', input_json = ?, updated_at = ?
       WHERE id = ?`,
      inputJson,
      now,
      row.id,
    )
    db.run(
      `INSERT INTO approvals (
         id, session_id, run_id, tool_call_id, tool_name, summary, input_json, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      approvalId,
      row.session_id,
      row.run_id,
      row.tool_call_id,
      row.tool_name,
      summary,
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
    summary,
  })
}

function createLocatedEnvResolver(
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

async function runSingleToolCall(
  options: ExecuteStepCallsOptions,
  row: VelaToolCallRow,
  tool: ToolDefinition,
  input: unknown,
  interception: ToolInterception | undefined,
  recoveryLocation: ExecutionLocation | undefined,
): Promise<void> {
  const {
    db,
    store,
    registry,
    sessionId,
    emit,
    signal,
    isDraining,
    shouldSkipForSteer,
  } = options
  const name = tool.name
  const mode = tool.executionMode ?? 'parallel'

  await registry.trackCall(() =>
    registry.runInGate(mode, async () => {
      if (shouldSkipForSteer?.()) {
        const reason = 'Skipped due to queued user message.'
        const output: ToolResultOutput = { type: 'error-text', value: reason }
        persistTerminalRow(db, row, 'skipped', output, true, {
          preview: reason,
          durationMs: 0,
        })
        emitImmediateError(emit, row, input, reason)
        return
      }
      if (isDraining?.()) {
        await failPrecheck(
          db,
          row,
          input,
          `Tool ${name} was not executed because the session is shutting down`,
          emit,
        )
        return
      }
      if (signal?.aborted) {
        await failPrecheck(db, row, input, 'Operation aborted', emit)
        return
      }

      registry.logger.debug(`[tools] ${name} started (${mode})`)
      const context: InterceptionContext = {
        sessionId,
        toolCallId: row.tool_call_id,
      }
      const baseRequireEnv = interception?.resolveEnv
        ? createLazyEnvResolver(
            (envSignal) => interception.resolveEnv!(sessionId, envSignal),
            signal,
            (resolved) => {
              context.execution = resolved
            },
            () => context.execution,
          )
        : undefined
      const located = baseRequireEnv
        ? createLocatedEnvResolver(db, row, baseRequireEnv, recoveryLocation)
        : undefined

      if (
        options.isRecovery &&
        (recoveryLocation ||
          (tool.replay === 'safe' &&
            (name === 'read' ||
              name === 'ls' ||
              name === 'grep' ||
              name === 'find'))) &&
        !context.execution &&
        located
      ) {
        try {
          await located.requireEnv(signal)
        } catch (error) {
          await failPrecheck(db, row, input, errorMessageOf(error), emit)
          return
        }
      }

      const now = new Date().toISOString()
      const resolvedLoc =
        located?.getLocation() ??
        (context.execution
          ? { environment: context.execution.id, cwd: context.execution.cwd }
          : undefined)
      const locJson = resolvedLoc ? JSON.stringify(resolvedLoc) : null

      // TX2a: atomically enter running state and increment attempt before invoking side effects.
      db.transaction(() => {
        db.run(
          `UPDATE vela_tool_calls
           SET status = 'running',
               attempt = attempt + 1,
               location_json = COALESCE(?, location_json),
               started_at = COALESCE(started_at, ?),
               updated_at = ?
           WHERE id = ?`,
          locJson,
          now,
          now,
          row.id,
        )
      })
      row.status = 'running'
      row.attempt += 1
      if (locJson) row.location_json = locJson

      emit({
        type: 'tool_execution_start',
        toolCallId: row.tool_call_id,
        toolName: name,
        args: input,
      })

      const startedAt = performance.now()
      let settled = false
      const onUpdate = (partialResult: unknown) => {
        if (settled) return
        emit({
          type: 'tool_execution_update',
          toolCallId: row.tool_call_id,
          toolName: name,
          args: input,
          partialResult,
        })
      }

      let raw: unknown
      try {
        signal?.throwIfAborted()
        raw = await tool.execute(input, {
          ...context,
          requireEnv: located?.requireEnv,
          background: registry.background,
          scope: registry.currentScope(),
          spillDir: registry.spillDir,
          toolCallId: row.tool_call_id,
          signal,
          registry,
          onUpdate,
        })
        const alreadyAbortedError =
          (raw instanceof ToolExecutionResult ||
            raw instanceof SpilledToolOutput) &&
          raw.execution?.isError === true
        if (signal?.aborted && !alreadyAbortedError) {
          throw new Error(ABORTED_RESULT)
        }
      } catch (error) {
        settled = true
        const aborted = Boolean(signal?.aborted)
        if (aborted) {
          registry.takeDetails(row.tool_call_id)
        }
        const isGenericAbort =
          ((error instanceof Error || error instanceof DOMException) &&
            error.name === 'AbortError') ||
          errorMessageOf(error) === ABORTED_RESULT
        const rawMessage =
          aborted && isGenericAbort ? ABORTED_RESULT : errorMessageOf(error)
        let errorText = rawMessage
        let afterOutput: unknown = errorText
        if (interception?.after) {
          afterOutput = await interception.after(
            name,
            input,
            errorText,
            context,
            true,
          )
          if (isToolContent(afterOutput)) {
            const normalized = await normalizeToolContent(afterOutput)
            afterOutput = normalized
            errorText = toolContentText(normalized) || errorText
          } else if (typeof afterOutput === 'string') {
            errorText = afterOutput
          }
        }
        const durationMs = performance.now() - startedAt
        const modelOut = errorOutput(
          isToolContent(afterOutput)
            ? new ToolResultError(errorText, afterOutput)
            : errorText,
        )
        persistTerminalRow(db, row, 'failed', modelOut, true, {
          preview: errorText,
          durationMs,
        })
        emit({
          type: 'tool_execution_end',
          toolCallId: row.tool_call_id,
          toolName: name,
          result: aborted
            ? error instanceof Error
              ? error
              : new Error(errorText)
            : isToolContent(afterOutput) || typeof afterOutput === 'string'
              ? afterOutput
              : errorText,
          isError: true,
          durationMs: Math.round(durationMs),
        })
        return
      }

      settled = true
      const rawDetails =
        raw instanceof ToolExecutionResult ? raw.value : undefined
      const prepared = await prepareCallResult({
        raw,
        spillDir: registry.spillDir,
        environment: context.execution,
        resolveEnvironment: located
          ? () => located.requireEnv(signal)
          : undefined,
        signal,
        maxResultChars: tool.maxResultChars,
      })
      let { output } = prepared
      const { execution, stored } = prepared
      if (interception?.after) {
        output = await interception.after(
          name,
          input,
          output,
          context,
          Boolean(execution.isError),
        )
      }
      if (isToolContent(output)) output = await normalizeToolContent(output)

      const durationMs = performance.now() - startedAt
      const isError = Boolean(execution.isError)
      const details = !isError ? rawDetails : undefined
      if (details !== undefined) {
        registry.setDetails(row.tool_call_id, details)
      }
      const modelOut: ToolResultOutput = isError
        ? errorOutput(
            new ToolResultError(
              (typeof output === 'string' ? output : toolContentText(output)) ||
                'Tool reported an error',
              typeof output === 'string' ? undefined : output,
            ),
          )
        : normalOutput(output)

      // TX2b: finalize outcome and discovered tools atomically.
      persistTerminalRow(
        db,
        row,
        isError ? 'failed' : 'completed',
        modelOut,
        isError,
        {
          preview: outputPreviewText(modelOut),
          spillPath: stored?.path,
          details,
          durationMs,
          discoveredTools:
            name === 'tool_search' && !isError
              ? registry.discoveredTools
              : undefined,
          store,
        },
      )

      emit({
        type: 'tool_execution_end',
        toolCallId: row.tool_call_id,
        toolName: name,
        result: output,
        isError,
        ...(details !== undefined ? { details } : {}),
        durationMs: Math.round(durationMs),
      })
    }),
  )
}

/**
 * Executes pending client tool calls for a step:
 * 1. Sequential pre-hooks (`before`, block/reject/approval/input mutation).
 * 2. Gated execution (`parallel` vs `sequential`) with TX2a -> execute -> spill/after -> TX2b.
 */
export async function executeStepCalls(
  options: ExecuteStepCallsOptions,
): Promise<ExecuteStepCallsResult> {
  const { db, registry, sessionId, rows, emit, signal, isDraining } = options
  const interception = registry.getInterception()
  const runnable: Array<{
    row: VelaToolCallRow
    tool: ToolDefinition
    input: unknown
    recoveryLocation?: ExecutionLocation
  }> = []

  for (const row of rows) {
    if (
      row.status !== 'pending' &&
      !(options.isRecovery && row.status === 'running')
    )
      continue
    const tool = registry.get(row.tool_name)
    let input = parseJsonSafe(row.input_json)
    const recoveryLocation = row.location_json
      ? (parseJsonSafe(row.location_json) as ExecutionLocation)
      : undefined

    if (row.status === 'running') {
      // Safe-replay path from step-recovery: pre-hooks already passed on the initial attempt.
      if (!tool) {
        await failPrecheck(
          db,
          row,
          input,
          `[Rejected] ${row.tool_name} is not enabled in this session`,
          emit,
        )
        continue
      }
      runnable.push({ row, tool, input, recoveryLocation })
      continue
    }

    if (isDraining?.()) {
      await failPrecheck(
        db,
        row,
        input,
        `Tool ${row.tool_name} was not executed because the session is shutting down`,
        emit,
      )
      continue
    }
    if (tool?.hostedOnly) {
      await failPrecheck(
        db,
        row,
        input,
        `[Rejected] ${row.tool_name} is unavailable locally`,
        emit,
      )
      continue
    }
    if (!tool || !registry.isAvailable(row.tool_name)) {
      await failPrecheck(
        db,
        row,
        input,
        `[Rejected] ${row.tool_name} is not enabled in this session`,
        emit,
      )
      continue
    }

    try {
      input = await validateInput(tool.inputSchema, input)
    } catch (error) {
      await failPrecheck(
        db,
        row,
        input,
        `[Rejected] Invalid input for ${row.tool_name}: ${errorMessageOf(error)}`,
        emit,
      )
      continue
    }

    const context: InterceptionContext = {
      sessionId,
      toolCallId: row.tool_call_id,
    }
    if (interception?.before) {
      const pre = await interception.before(row.tool_name, input, context)
      if (pre.block && pre.approval) {
        await failPrecheck(
          db,
          row,
          input,
          '[Rejected] Tool hook returned both block and approval',
          emit,
        )
        continue
      }
      if (pre.block) {
        await failPrecheck(
          db,
          row,
          input,
          `[Blocked by hook] ${pre.reason || 'Operation blocked'}`,
          emit,
        )
        continue
      }
      if (pre.input !== input) {
        try {
          input = await validateInput(tool.inputSchema, pre.input)
        } catch (error) {
          await failPrecheck(
            db,
            row,
            input,
            `[Rejected] Input modified by hook is invalid: ${errorMessageOf(error)}`,
            emit,
          )
          continue
        }
        const inputJson = JSON.stringify(input)
        row.input_json = inputJson
        db.run(
          'UPDATE vela_tool_calls SET input_json = ?, updated_at = ? WHERE id = ?',
          inputJson,
          new Date().toISOString(),
          row.id,
        )
      }
      if (pre.approval) {
        const alreadyApproved = db.get<{ id: string }>(
          `SELECT id FROM approvals
           WHERE session_id = ? AND run_id = ? AND tool_call_id = ? AND status = 'approved'
           LIMIT 1`,
          row.session_id,
          row.run_id,
          row.tool_call_id,
        )
        if (!alreadyApproved) {
          markApprovalRequested(db, row, input, pre.approval.summary, emit)
          continue
        }
      }
    }

    if (row.tool_name === 'bash') {
      const command = (input as { command?: unknown } | null)?.command
      if (typeof command !== 'string') {
        await failPrecheck(
          db,
          row,
          input,
          '[Rejected] bash command must be a string',
          emit,
        )
        continue
      }
    }

    if (signal?.aborted) {
      await failPrecheck(db, row, input, 'Operation aborted', emit)
      continue
    }

    runnable.push({ row, tool, input, recoveryLocation })
  }

  if (runnable.length > 0) {
    await Promise.all(
      runnable.map((item) =>
        runSingleToolCall(
          options,
          item.row,
          item.tool,
          item.input,
          interception,
          item.recoveryLocation,
        ),
      ),
    )
  }

  const waitingHuman = rows.some((row) => row.status === 'awaiting_approval')
  return { waitingHuman }
}
