import { createSessionLocalExecutionEnv } from '../execution/local.ts'
import type {
  ExecutionError,
  Result,
  ShellExecResult,
} from '../execution/types.ts'
import { StoredToolResult, ToolResultStore } from '../session/tool-results.ts'
import type { BackgroundAdmission, BackgroundCommands } from './background.ts'
import {
  type ForegroundBudget,
  seconds,
  sleepsFirst,
} from './foreground-budget.ts'
import {
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_LINES,
  OutputTail,
} from './output-tail.ts'
import type { ToolContext } from './registry.ts'
import { ToolExecutionResult } from './types.ts'

/** The result of a call the user moved to the background while it ran. */
function movedToBackground({
  id,
  output,
  truncated,
}: BackgroundAdmission): ToolExecutionResult {
  const tail = output
    ? `${output}${truncated ? '\n\n[Showing the last output only]' : ''}\n\n`
    : ''
  const text = `${tail}Command was manually moved to the background with ID: ${id}.\nYou will be notified when it completes; do not poll the file or start a second copy.`
  return new ToolExecutionResult({ id }, text, {
    backgroundTaskId: id,
    backgroundedByUser: true,
  })
}

/**
 * The result of a call whose foreground budget expired: the command keeps running as a job, and the
 * notice comes before the tail, so the model cannot mistake it for one it declared itself.
 */
function budgetExpired(
  { id, output, truncated }: BackgroundAdmission,
  timedOutAfterMs: number,
  notice: string,
): ToolExecutionResult {
  const tail = output
    ? `\n\n${output.trimEnd()}${truncated ? '\n\n[Showing the last output only]' : ''}`
    : ''
  return new ToolExecutionResult(
    { id },
    `${notice}${tail}\n\nYou will be notified when it completes; do not poll the file or start a second copy.`,
    { backgroundTaskId: id, timedOutAfterMs },
  )
}

/** The foreground deadline for this call. */
interface Deadline {
  /** Seconds the command may stay in the foreground before the budget is spent. */
  seconds: number
  /** Whether the expiry hands the command to the job table instead of killing it. */
  move: boolean
  /** The sentence that says a requested timeout was held to the ceiling. */
  capped: string
}

/**
 * The deadline for this call: a requested `timeout` is the foreground budget, held to the ceiling,
 * and the session's own budget applies when the call names none. A command that starts with `sleep`
 * has no work to lose, so it keeps the kill at the same deadline.
 */
function deadlineFor(
  command: string,
  timeout: number | undefined,
  budget: ForegroundBudget,
): Deadline {
  // A budget of 0 means the session has no foreground budget: a `timeout` is a deadline that kills,
  // as it was before, and nothing is clamped to a ceiling this session does not apply.
  if (budget.seconds <= 0)
    return { seconds: timeout ?? 0, move: false, capped: '' }
  // Like Claude Code: the configured budget raises the ceiling, so a session whose budget is longer
  // than the ceiling keeps its own budget instead of being cut to it.
  const ceiling = Math.max(budget.seconds, budget.maxSeconds)
  const allowed =
    timeout === undefined ? budget.seconds : Math.min(timeout, ceiling)
  const capped =
    timeout !== undefined && timeout > ceiling
      ? `The requested ${seconds(timeout)}s timeout is capped at ${seconds(ceiling)}s.`
      : ''
  return { seconds: allowed, move: !sleepsFirst(command), capped }
}

/**
 * Execute within the selected session environment, retaining a bounded output tail. In a session with
 * background commands the call is registered while it runs, so `session.backgroundTasks()` can move it
 * to the background, and its own budget moves it there when the deadline passes: it then returns the
 * notice and the tail so far, and the job table owns the exit.
 */
export async function environmentBash(
  command: string,
  timeout: number | undefined,
  cwd: string | undefined,
  shellPath: string | undefined,
  context: ToolContext | undefined,
  /** The session's foreground budget; unset when it has no job table or no stop tool. */
  budget?: ForegroundBudget,
) {
  const results = context?.results ?? new ToolResultStore()
  const env =
    context?.execution ??
    createSessionLocalExecutionEnv({
      cwd: cwd ?? process.cwd(),
      shellPath,
      tempRoot: results.dir,
    })
  const tail = new OutputTail()
  let updateTimer: ReturnType<typeof setTimeout> | undefined
  const onUpdate = context?.onUpdate
  const deadline = budget ? deadlineFor(command, timeout, budget) : undefined
  // A move names the call by its tool-call id; a host that runs the tool without one keeps the
  // deadline that kills, so nothing is left running without a job to report it.
  const movable = deadline?.move === true && context?.toolCallId !== undefined
  const start = (signal: AbortSignal | undefined) =>
    env.exec(
      command,
      {
        // A deadline that moves the command must not also kill it: the job table owns it from then.
        // A budget of 0 leaves the command with no deadline at all, as it had before.
        timeout: movable
          ? undefined
          : deadline && deadline.seconds > 0
            ? deadline.seconds
            : timeout,
        spill: { afterBytes: OUTPUT_MAX_BYTES, afterLines: OUTPUT_MAX_LINES },
        onOutput: (text) => {
          tail.append(text)
          if (onUpdate && !updateTimer) {
            // Publish the latest tail even if the command goes quiet after a burst.
            updateTimer = setTimeout(() => {
              updateTimer = undefined
              try {
                onUpdate({
                  content: [{ type: 'text', text: tail.read().text }],
                })
              } catch {
                // A failed progress notification does not interrupt the command.
              }
            }, 100)
          }
        },
      },
      signal,
    )
  const foreground = context?.background?.watch({
    command,
    ...(context?.toolCallId === undefined
      ? {}
      : { toolCallId: context.toolCallId }),
    signal: context?.signal,
    output: tail,
    start,
    exit: (settled) =>
      settled.ok
        ? {
            exitCode: settled.value.exitCode,
            spillPath: settled.value.spillPath,
          }
        : { spillPath: settled.error.spillPath, error: settled.error.message },
  })
  let result: Result<ShellExecResult, ExecutionError>
  // At the deadline the command is handed to the job table, exactly as Ctrl+B hands it over; the
  // environment is not asked to kill it. A move that loses the race (the user moved it, or the
  // command settled) is not an error: the race below already has or will have the answer. A move the
  // host refuses leaves the command with this call, which then waits as a session without a budget
  // does: its work is not thrown away to keep a deadline nobody can report.
  const expired =
    movable && foreground && deadline
      ? setTimeout(() => {
          void context.background
            ?.detach(context.toolCallId!, Math.round(deadline.seconds * 1000))
            .catch(() => {})
        }, deadline.seconds * 1000)
      : undefined
  try {
    if (!foreground) result = await start(context?.signal)
    else {
      const outcome = await Promise.race([
        foreground.result.then((value) => ({ type: 'result' as const, value })),
        foreground.detached.then((admission) => ({
          type: 'detached' as const,
          admission,
        })),
      ])
      if (outcome.type === 'detached') {
        const { admission } = outcome
        // The move itself records why it happened, so the two ways a call can be handed over are
        // never confused: the user's Ctrl+B leaves `timedOutAfterMs` unset.
        if (admission.timedOutAfterMs === undefined || !deadline)
          return movedToBackground(admission)
        return budgetExpired(
          admission,
          admission.timedOutAfterMs,
          `Command did not complete within its ${seconds(deadline.seconds)}s timeout and was moved to the background (ID: ${admission.id}).${deadline.capped ? ` ${deadline.capped}` : ''}`,
        )
      }
      result = outcome.value
    }
  } finally {
    clearTimeout(updateTimer)
    if (expired) clearTimeout(expired)
  }
  if (!result.ok) {
    const output = tail.read().text || '(no output)'
    const message =
      result.error.code === 'unknown' &&
      result.error.message.startsWith(
        'Failed to preserve complete shell output:',
      )
        ? 'The command started and was stopped because its full output could not be saved; it may have had partial effects. Do not automatically rerun it.'
        : result.error.code === 'shell_unavailable'
          ? 'Shell not found in the execution environment. The command did not run.'
          : result.error.code === 'timeout'
            ? `Command timed out after ${deadline?.seconds ?? timeout} seconds${deadline?.capped ? `. ${deadline.capped}` : ''}`
            : result.error.code === 'aborted'
              ? 'Command aborted'
              : result.error.message
    const execution = {
      isError: true,
      timedOut: result.error.code === 'timeout' || undefined,
      toolUnavailable: result.error.code === 'shell_unavailable' || undefined,
      error: message,
    }
    if (result.error.spillPath && result.error.code !== 'unknown') {
      const path = result.error.spillPath
      const info = await env.fileInfo(path)
      const stored = new StoredToolResult(
        path,
        results.indexPath,
        info.ok ? info.value.size : tail.bytes,
        `${output}\n\n[Full output: ${path}]\n\n${message}`,
      )
      stored.execution = execution
      return stored
    }
    return new ToolExecutionResult(output, `${output}\n\n${message}`, execution)
  }
  const { exitCode, spillPath } = result.value
  const status =
    exitCode === 0 ? '' : `\n\nCommand exited with code ${exitCode}`
  const execution = { exitCode, isError: exitCode !== 0 }
  const fit = tail.read()
  let preview = fit.text || '(no output)'
  if (spillPath) {
    preview += `\n\n[Showing the last ${fit.lines} lines${fit.partialLine ? ' (the last line is cut)' : ''} of ${tail.bytes} bytes of output. Full output: ${spillPath}]`
    const stored = new StoredToolResult(
      spillPath,
      results.indexPath,
      tail.bytes,
      preview + status,
    )
    stored.execution = execution
    return stored
  }
  preview += status
  return new ToolExecutionResult(preview, preview, execution)
}

/**
 * Starts a command as a background task: the call returns at once with the job's id and the tail the
 * command already wrote, and the job table delivers the exit to the session. The complete output goes
 * to the environment's own spill file, so a session whose environment is not the host can page it.
 */
export async function backgroundBash(
  command: string,
  timeout: number | undefined,
  cwd: string | undefined,
  shellPath: string | undefined,
  context: ToolContext | undefined,
  commands: BackgroundCommands,
): Promise<ToolExecutionResult> {
  const results = context?.results ?? new ToolResultStore()
  const env =
    context?.execution ??
    createSessionLocalExecutionEnv({
      cwd: cwd ?? process.cwd(),
      shellPath,
      tempRoot: results.dir,
    })
  const { id, output, truncated } = await commands.adopt({
    command,
    timeout,
    // Cancelling this call during admission starts nothing; the running job gets its own signal.
    signal: context?.signal,
    start: ({ onOutput, signal, shell, timeout }) =>
      env.exec(
        // Only a local session has a host shell to honour; other environments run the command.
        shell !== undefined && env.id === 'node:local'
          ? [shell, '-lc', command]
          : command,
        {
          timeout,
          spill: { afterBytes: OUTPUT_MAX_BYTES, afterLines: OUTPUT_MAX_LINES },
          onOutput,
        },
        signal,
      ),
  })
  const tail = output
    ? `${output}${truncated ? '\n\n[Showing the last output only]' : ''}\n\n`
    : ''
  const text = `${tail}Command running in background with ID: ${id}.\nYou will be notified when it completes; do not poll the file or start a second copy.`
  return new ToolExecutionResult({ id }, text, { backgroundTaskId: id })
}
