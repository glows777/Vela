import { createSessionLocalExecutionEnv } from '../execution/local.ts'
import type {
  ExecutionError,
  Result,
  ShellExecResult,
} from '../execution/types.ts'
import { StoredToolResult, ToolResultStore } from '../session/tool-results.ts'
import type { BackgroundAdmission, BackgroundCommands } from './background.ts'
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
 * Execute within the selected session environment, retaining a bounded output tail. In a session with
 * background commands the call is registered while it runs so the user (`Ctrl+B`) can move it to the
 * background, returning the manual-move notice and handing its exit to the job table.
 */
export async function environmentBash(
  command: string,
  timeout: number | undefined,
  cwd: string | undefined,
  shellPath: string | undefined,
  context: ToolContext | undefined,
) {
  const results = context?.results ?? new ToolResultStore()
  const env =
    context?.execution ??
    (context?.requireEnv
      ? await context.requireEnv(context?.signal)
      : createSessionLocalExecutionEnv({
          cwd: cwd ?? process.cwd(),
          shellPath,
          tempRoot: results.dir,
        }))
  const tail = new OutputTail()
  let updateTimer: ReturnType<typeof setTimeout> | undefined
  const onUpdate = context?.onUpdate
  const effectiveTimeout = timeout ?? 120
  const start = (signal: AbortSignal | undefined) =>
    env.exec(
      command,
      {
        timeout: effectiveTimeout,
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
      if (outcome.type === 'detached')
        return movedToBackground(outcome.admission)
      result = outcome.value
    }
  } finally {
    clearTimeout(updateTimer)
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
            ? `Command timed out after ${effectiveTimeout} seconds. Pass a larger timeout (up to 1800s) or run_in_background: true for long-running commands.`
            : result.error.code === 'aborted'
              ? 'Command aborted'
              : result.error.message
    const execution = {
      isError: true,
      timedOut: result.error.code === 'timeout' || undefined,
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
    (context?.requireEnv
      ? await context.requireEnv(context?.signal)
      : createSessionLocalExecutionEnv({
          cwd: cwd ?? process.cwd(),
          shellPath,
          tempRoot: results.dir,
        }))
  const { id, output, truncated } = await commands.adopt({
    command,
    timeout,
    // Cancelling this call during admission starts nothing; the running job gets its own signal.
    signal: context?.signal,
    start: ({ onOutput, signal, shell, timeout }) =>
      env.exec(
        // Only a local session has a host shell to honour; other environments run the command.
        shell !== undefined && env.id === 'node:local'
          ? [shell, '-c', command]
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
