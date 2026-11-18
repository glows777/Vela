import { createSessionLocalExecutionEnv } from '../execution/local.ts'
import { StoredToolResult, ToolResultStore } from '../session/tool-results.ts'
import {
  fitOutputTail,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_LINES,
} from './output-tail.ts'
import type { ToolContext } from './registry.ts'
import { ToolExecutionResult } from './types.ts'

/** Execute within the selected session environment, retaining a bounded output tail. */
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
    createSessionLocalExecutionEnv({
      cwd: cwd ?? process.cwd(),
      shellPath,
      tempRoot: results.dir,
    })
  let tail = '',
    cut = false,
    bytes = 0
  let updateTimer: ReturnType<typeof setTimeout> | undefined
  const onUpdate = context?.onUpdate
  const result = await env
    .exec(
      command,
      {
        timeout,
        spill: { afterBytes: OUTPUT_MAX_BYTES, afterLines: OUTPUT_MAX_LINES },
        onOutput: (text) => {
          bytes += Buffer.byteLength(text)
          const combined = Buffer.from(tail + text)
          if (combined.length > OUTPUT_MAX_BYTES) cut = true
          tail = combined.subarray(-OUTPUT_MAX_BYTES).toString()
          if (onUpdate && !updateTimer) {
            // Publish the latest tail even if the command goes quiet after a burst.
            updateTimer = setTimeout(() => {
              updateTimer = undefined
              try {
                onUpdate({
                  content: [
                    { type: 'text', text: fitOutputTail(tail, cut).text },
                  ],
                })
              } catch {
                // A failed progress notification does not interrupt the command.
              }
            }, 100)
          }
        },
      },
      context?.signal,
    )
    .finally(() => clearTimeout(updateTimer))
  if (!result.ok) {
    const output = fitOutputTail(tail, cut).text || '(no output)'
    const message =
      result.error.code === 'unknown' &&
      result.error.message.startsWith(
        'Failed to preserve complete shell output:',
      )
        ? 'The command started and was stopped because its full output could not be saved; it may have had partial effects. Do not automatically rerun it.'
        : result.error.code === 'shell_unavailable'
          ? 'Shell not found in the execution environment. The command did not run.'
          : result.error.code === 'timeout'
            ? `Command timed out after ${timeout} seconds`
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
        info.ok ? info.value.size : bytes,
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
  const fit = fitOutputTail(tail, cut)
  let preview = fit.text || '(no output)'
  if (spillPath) {
    preview += `\n\n[Showing the last ${fit.lines} lines${fit.partialLine ? ' (the last line is cut)' : ''} of ${bytes} bytes of output. Full output: ${spillPath}]`
    const stored = new StoredToolResult(
      spillPath,
      results.indexPath,
      bytes,
      preview + status,
    )
    stored.execution = execution
    return stored
  }
  preview += status
  return new ToolExecutionResult(preview, preview, execution)
}
