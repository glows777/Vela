import { ABORTED_RESULT, errorMessageOf } from './agent/step.ts'
import { abortable } from './execution/location.ts'
import type { ExecutionEnv, ExecutionLocation } from './execution/types.ts'
import {
  isToolContent,
  normalizeToolContent,
  type ToolResultOutput,
  toolContentText,
} from './messages.ts'
import {
  checkCallableTool,
  createLocatedEnvResolver,
  type ExecuteStepCallsOptions,
  type ExecuteStepCallsResult,
  emitImmediateError,
  failPrecheck,
  markApprovalRequested,
  outputPreviewText,
  parseJsonSafe,
  persistTerminalRow,
  type VelaToolCallRow,
} from './tool-call-helpers.ts'
import { prepareCallResult } from './tools/call-result.ts'
import {
  createLazyEnvResolver,
  errorOutput,
  normalOutput,
} from './tools/recovery.ts'
import type { ToolDefinition } from './tools/registry.ts'
import {
  type InterceptionContext,
  SpilledToolOutput,
  ToolExecutionResult,
  type ToolInterception,
  ToolResultError,
} from './tools/types.ts'
import { validateInput } from './tools/validation.ts'

export type {
  ExecuteStepCallsOptions,
  ExecuteStepCallsResult,
  VelaToolCallRow,
} from './tool-call-helpers.ts'

async function runSingleToolCall(
  options: ExecuteStepCallsOptions,
  row: VelaToolCallRow,
  tool: ToolDefinition,
  input: unknown,
  interception: ToolInterception | undefined,
  recoveryLocation: ExecutionLocation | undefined,
  sharedResolveEnv?: (envSignal?: AbortSignal) => Promise<ExecutionEnv>,
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
  const mode = tool.executionMode ?? 'sequential'

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
      const baseRequireEnv = sharedResolveEnv
        ? createLazyEnvResolver(
            sharedResolveEnv,
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
        recoveryLocation &&
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
      const expectedStatus = row.status
      const expectedAttempt = row.attempt
      db.transaction(() => {
        const res = db.run(
          `UPDATE vela_tool_calls
           SET status = 'running',
               attempt = attempt + 1,
               location_json = COALESCE(?, location_json),
               started_at = COALESCE(started_at, ?),
               updated_at = ?
           WHERE id = ? AND status = ? AND attempt = ?`,
          locJson,
          now,
          now,
          row.id,
          expectedStatus,
          expectedAttempt,
        )
        if (res.changes !== 1) {
          throw new Error(
            `Tool call ${row.tool_call_id} state changed concurrently (expected ${expectedStatus} attempt ${expectedAttempt})`,
          )
        }
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
          try {
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
          } catch (afterError) {
            errorText = `${errorText} (tool_result hook error: ${errorMessageOf(afterError)})`
            afterOutput = errorText
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
          location: located?.getLocation(),
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
      let prepared: Awaited<ReturnType<typeof prepareCallResult>>
      let output: Awaited<ReturnType<typeof prepareCallResult>>['output']
      try {
        prepared = await prepareCallResult({
          raw,
          spillDir: registry.spillDir,
          environment: context.execution,
          resolveEnvironment: located
            ? () => located.requireEnv(signal)
            : undefined,
          signal,
          maxResultChars: tool.maxResultChars,
        })
        output = prepared.output
        if (interception?.after) {
          output = await interception.after(
            name,
            input,
            output,
            context,
            Boolean(prepared.execution.isError),
          )
        }
        if (isToolContent(output)) output = await normalizeToolContent(output)
      } catch (postError) {
        const postMessage = errorMessageOf(postError)
        const durationMs = performance.now() - startedAt
        const resolvedAfterLoc =
          located?.getLocation() ??
          (context.execution
            ? { environment: context.execution.id, cwd: context.execution.cwd }
            : undefined)
        persistTerminalRow(db, row, 'failed', errorOutput(postMessage), true, {
          preview: postMessage,
          location: resolvedAfterLoc,
          durationMs,
        })
        emit({
          type: 'tool_execution_end',
          toolCallId: row.tool_call_id,
          toolName: name,
          result: postMessage,
          isError: true,
          durationMs: Math.round(durationMs),
        })
        throw postError
      }
      const { execution, stored } = prepared

      const durationMs = performance.now() - startedAt
      const isError = Boolean(execution.isError)
      const details = !isError ? rawDetails : undefined
      const modelOut: ToolResultOutput = isError
        ? errorOutput(
            new ToolResultError(
              (typeof output === 'string' ? output : toolContentText(output)) ||
                'Tool reported an error',
              typeof output === 'string' ? undefined : output,
            ),
          )
        : normalOutput(output)
      const resolvedAfterLoc =
        located?.getLocation() ??
        (context.execution
          ? { environment: context.execution.id, cwd: context.execution.cwd }
          : undefined)

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
          location: resolvedAfterLoc,
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

  // Partition into ordered execution waves: contiguous parallel rows run together, sequential rows isolate.
  const waves: VelaToolCallRow[][] = []
  for (const row of rows) {
    if (row.execution_mode === 'sequential') {
      waves.push([row])
    } else {
      const lastWave = waves.at(-1)
      if (lastWave && lastWave[0]!.execution_mode === 'parallel') {
        lastWave.push(row)
      } else {
        waves.push([row])
      }
    }
  }

  const skipRemainingWaves = (startWave: number) => {
    const reason = 'Skipped due to queued user message.'
    const skipOut: ToolResultOutput = { type: 'error-text', value: reason }
    for (const remainingWave of waves.slice(startWave)) {
      for (const pendingRow of remainingWave) {
        if (pendingRow.status !== 'pending') continue
        const pendingInput = parseJsonSafe(pendingRow.input_json)
        persistTerminalRow(db, pendingRow, 'skipped', skipOut, true, {
          preview: reason,
          durationMs: 0,
        })
        pendingRow.status = 'skipped'
        pendingRow.is_error = 1
        pendingRow.preview = reason
        pendingRow.result_json = JSON.stringify(skipOut)
        emitImmediateError(emit, pendingRow, pendingInput, reason)
      }
    }
  }

  let blockedByApproval = false
  let steered = false

  for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
    if (blockedByApproval || steered) break
    const wave = waves[waveIndex]!
    if (options.shouldSkipForSteer?.()) {
      skipRemainingWaves(waveIndex)
      break
    }

    // Share one single-flight env resolution across parallel calls within this wave only.
    let waveEnvPromise: Promise<ExecutionEnv> | undefined
    const sharedResolveEnv = interception?.resolveEnv
      ? (envSignal?: AbortSignal): Promise<ExecutionEnv> => {
          waveEnvPromise ??= interception.resolveEnv!(sessionId, signal).catch(
            (error) => {
              waveEnvPromise = undefined
              throw error
            },
          )
          return abortable(waveEnvPromise, envSignal)
        }
      : undefined

    const runnable: Array<{
      row: VelaToolCallRow
      tool: ToolDefinition
      input: unknown
      recoveryLocation?: ExecutionLocation
    }> = []

    for (const row of wave) {
      if (row.status === 'awaiting_approval') {
        blockedByApproval = true
        continue
      }
      if (
        row.status !== 'pending' &&
        !(options.isRecovery && row.status === 'running')
      )
        continue

      const rawTool = registry.get(row.tool_name)
      let input = parseJsonSafe(row.input_json)
      const recoveryLocation = row.location_json
        ? (parseJsonSafe(row.location_json) as ExecutionLocation)
        : undefined

      const callable = checkCallableTool(
        rawTool,
        row.tool_name,
        registry,
        isDraining,
      )
      if (!callable.ok) {
        await failPrecheck(db, row, input, callable.reason, emit)
        continue
      }
      const tool = callable.tool

      if (row.status === 'running') {
        if (signal?.aborted) {
          await failPrecheck(db, row, input, 'Operation aborted', emit)
          continue
        }
        runnable.push({ row, tool, input, recoveryLocation })
        continue
      }

      const approval = db.get<{
        status: string
        input_json: string | null
      }>(
        `SELECT status, input_json FROM approvals
         WHERE tool_call_row_id = ?
            OR (tool_call_row_id IS NULL AND session_id = ? AND run_id = ? AND tool_call_id = ?)
         ORDER BY created_at DESC LIMIT 1`,
        row.id,
        row.session_id,
        row.run_id,
        row.tool_call_id,
      )
      const isApproved = approval?.status === 'approved'

      if (isApproved) {
        if (
          approval.input_json !== null &&
          approval.input_json !== row.input_json
        ) {
          await failPrecheck(
            db,
            row,
            input,
            '[Rejected] Tool input changed after human approval',
            emit,
          )
          continue
        }
        if (approval.input_json === null) {
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
        } else {
          input = parseJsonSafe(approval.input_json)
        }
      } else {
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
        const canonicalJson = JSON.stringify(input)
        if (canonicalJson !== row.input_json) {
          row.input_json = canonicalJson
          db.run(
            'UPDATE vela_tool_calls SET input_json = ?, updated_at = ? WHERE id = ?',
            canonicalJson,
            new Date().toISOString(),
            row.id,
          )
        }

        if (interception?.before) {
          const pre = await interception.before(row.tool_name, input, {
            sessionId,
            toolCallId: row.tool_call_id,
          })
          if (options.shouldSkipForSteer?.()) {
            runnable.length = 0
            skipRemainingWaves(waveIndex)
            steered = true
            break
          }
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
            if (options.shouldSkipForSteer?.()) {
              runnable.length = 0
              skipRemainingWaves(waveIndex)
              steered = true
              break
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
            markApprovalRequested(db, row, input, pre.approval.summary, emit)
            blockedByApproval = true
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
      const results = await Promise.allSettled(
        runnable.map((item) =>
          runSingleToolCall(
            options,
            item.row,
            item.tool,
            item.input,
            interception,
            item.recoveryLocation,
            sharedResolveEnv,
          ),
        ),
      )
      const rejected = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      if (rejected) throw rejected.reason
    }
  }

  const waitingHuman = rows.some((row) => row.status === 'awaiting_approval')
  return { waitingHuman }
}
