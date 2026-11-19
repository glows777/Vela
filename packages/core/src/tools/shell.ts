import z from 'zod'
import type { ExecutionEnv } from '../execution/types.ts'
import { backgroundBash, environmentBash } from './environment-bash.ts'
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
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      'Run the command as a background task and return at once with its id and output file. Its output arrives here when it exits; read the file to see output so far. Use it for a server, a watch build or a long test run instead of blocking the turn.',
    ),
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
  description: `Runs a shell command in the working directory. Returns the combined stdout/stderr, truncated to the last ${OUTPUT_MAX_LINES} lines or ${OUTPUT_MAX_BYTES / 1024}KB (whichever is hit first); the full output is saved to a file that read_file can page through. Optionally provide a timeout in seconds; there is no default timeout. With run_in_background the command starts as a background task: the call returns at once with its id and output file, and its result arrives here when it exits.`,
  inputSchema: bashToolParamSchema,
  annotations: { destructiveHint: true, openWorldHint: true },
  promptSnippet: 'Run a shell command',
  promptGuidelines: [
    'A command that may keep running (a dev server, a watch build, a long test run) starts with run_in_background: true instead of blocking the turn.',
  ],
  execute: async (
    {
      command,
      timeout,
      run_in_background: runInBackground,
    }: { command: string; timeout?: number; run_in_background?: boolean },
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
    if (!runInBackground)
      return environmentBash(command, timeout, cwd, shellPath, context)
    // Only the extension installs the capability, and a job needs the tool that reads and ends it:
    // a session without both (no extension, a DM, a narrowed tool list) refuses the parameter instead
    // of starting a command nothing could stop.
    const commands = context?.background
    const stoppable = context?.registry
      ?.getActiveTools()
      .some((tool) => tool.name === 'background_stop')
    if (!commands || !stoppable)
      throw new Error(
        'Background commands are not enabled in this session: it has no background tools. Run the command without run_in_background, or enable the background extension and its tools for this session.',
      )
    return backgroundBash(command, timeout, cwd, shellPath, context, commands)
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
