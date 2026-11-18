import z from 'zod'
import type { ExecutionEnv } from '../execution/types.ts'
import { environmentBash } from './environment-bash.ts'
import {
  fitOutputTail,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_LINES,
} from './output-tail.ts'
import type { ToolDefinition } from './registry.ts'

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000 // setTimeout's limit

const bashToolParamSchema = z.object({
  command: z.string().describe('Shell command to run'),
  timeout: z
    .number()
    .optional()
    .describe('Timeout in seconds (optional, no default timeout)'),
})

export interface BashToolOptions {
  /** Shell to run commands with (settings `shellPath`). Default: bash on PATH, or bash.exe on Windows */
  shellPath?: string
}

export const createBashTool = (
  cwd?: string,
  { shellPath }: BashToolOptions = {},
): ToolDefinition => ({
  name: 'bash',
  description: `Runs a shell command in the working directory. Returns the combined stdout/stderr, truncated to the last ${OUTPUT_MAX_LINES} lines or ${OUTPUT_MAX_BYTES / 1024}KB (whichever is hit first); the full output is saved to a file that read_file can page through. Optionally provide a timeout in seconds; there is no default timeout.`,
  inputSchema: bashToolParamSchema,
  annotations: { destructiveHint: true, openWorldHint: true },
  promptSnippet: 'Run a shell command',
  execute: async (
    { command, timeout }: { command: string; timeout?: number },
    context,
  ) => {
    if (
      timeout !== undefined &&
      (!Number.isFinite(timeout) ||
        timeout <= 0 ||
        timeout > MAX_TIMEOUT_SECONDS)
    )
      throw new Error(
        `Invalid timeout: must be a positive number of seconds, at most ${MAX_TIMEOUT_SECONDS}`,
      )
    return environmentBash(command, timeout, cwd, shellPath, context)
  },
})

/** A command the user ran themselves (`!cmd`), shaped like pi's `BashResult`. */
export interface BashResult {
  /** The output's last OUTPUT_MAX_LINES lines / OUTPUT_MAX_BYTES bytes (stdout and stderr combined) */
  output: string
  /** Undefined when the command was cancelled */
  exitCode: number | undefined
  cancelled: boolean
  /** Whether `output` is only the end of the output */
  truncated: boolean
  /** File with the whole output, set when `output` is truncated */
  fullOutputPath?: string
}

/** Run a user command inside the selected execution environment. */
export async function runBash(
  command: string,
  options: {
    env: ExecutionEnv
    signal?: AbortSignal
    onUpdate?: (output: string) => void
    onDelta?: (delta: string) => void
  },
): Promise<BashResult> {
  let body = '',
    cut = false
  let pendingDelta = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const publish = (final: boolean) => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const delta = pendingDelta
    pendingDelta = ''
    try {
      if (delta) options.onDelta?.(delta)
    } catch {
      // A disconnected output subscriber cannot cancel the user's command.
    }
    if (!final) {
      try {
        options.onUpdate?.(fitOutputTail(body, cut).text)
      } catch {}
    }
  }
  const run = await options.env
    .exec(
      command,
      {
        spill: { afterBytes: OUTPUT_MAX_BYTES, afterLines: OUTPUT_MAX_LINES },
        onOutput: (text) => {
          const combined = Buffer.from(body + text)
          if (combined.length > OUTPUT_MAX_BYTES) cut = true
          body = combined.subarray(-OUTPUT_MAX_BYTES).toString()
          if (options.onDelta) pendingDelta += text
          if (!timer && (options.onDelta || options.onUpdate))
            timer = setTimeout(() => publish(false), 100)
        },
      },
      options.signal,
    )
    .finally(() => publish(true))
  const tail = fitOutputTail(body, cut)
  if (!run.ok) {
    if (run.error.code === 'aborted')
      return {
        output: tail.text.replace(/\n$/, ''),
        exitCode: undefined,
        cancelled: true,
        truncated: tail.truncated || !!run.error.spillPath,
        ...(run.error.spillPath ? { fullOutputPath: run.error.spillPath } : {}),
      }
    if (
      run.error.code === 'unknown' &&
      run.error.message.startsWith('Failed to preserve complete shell output:')
    )
      throw new Error(
        `Command started and was stopped because its full output could not be saved; it may have had partial effects. ${tail.text}`,
      )
    throw run.error
  }
  return {
    output: tail.text.replace(/\n$/, ''),
    exitCode: run.value.exitCode,
    cancelled: false,
    truncated: !!run.value.spillPath,
    ...(run.value.spillPath ? { fullOutputPath: run.value.spillPath } : {}),
  }
}
