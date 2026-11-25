import z from 'zod'
import type { ExecutionEnv } from '../execution/types.ts'
import { backgroundBash, environmentBash } from './environment-bash.ts'
import {
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_LINES,
  OutputTail,
} from './output-tail.ts'
import type { ToolDefinition } from './registry.ts'

const DEFAULT_FOREGROUND_TIMEOUT_SECONDS = 120
const MAX_FOREGROUND_TIMEOUT_SECONDS = 1800
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000 // setTimeout's limit

const bashToolParamSchema = z.object({
  command: z.string().describe('Shell command to run'),
  timeout: z
    .number()
    .optional()
    .describe(
      `Optional timeout in seconds. Foreground commands default to ${DEFAULT_FOREGROUND_TIMEOUT_SECONDS}s (max ${MAX_FOREGROUND_TIMEOUT_SECONDS}s) and are stopped if exceeded; background commands honor an explicit timeout (clamped at 7200s / 2 hours).`,
    ),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      'Run the command as a background task and return at once with its id. Its output arrives here when it exits. Available only when this session has the background tools; otherwise the call fails and the command does not run. Use it for a server, a watch build or a long test run instead of blocking the turn.',
    ),
})

export interface BashToolOptions {
  /** Shell to run commands with (settings `shellPath`). Default: bash on PATH, or bash.exe on Windows */
  shellPath?: string
}

/** The same condition `run_in_background` checks: a job needs the tool that reads and ends it. */
const isStoppable = (context: Parameters<ToolDefinition['execute']>[1]) =>
  context?.registry
    ?.getActiveTools()
    .some((tool) => tool.name === 'background_stop') === true

export const createBashTool = (
  cwd?: string,
  { shellPath }: BashToolOptions = {},
): ToolDefinition => ({
  name: 'bash',
  description: `Runs a shell command in the working directory. Returns the combined stdout/stderr, truncated to the last ${OUTPUT_MAX_LINES} lines or ${OUTPUT_MAX_BYTES / 1024}KB (whichever is hit first); the full output is saved to a file that read can page through. With run_in_background the command starts as a background task: the call returns at once with its id, and its result arrives here when it exits.`,
  inputSchema: bashToolParamSchema,
  annotations: { destructiveHint: true, openWorldHint: true },
  promptSnippet: 'Run a shell command',
  execute: async (
    {
      command,
      timeout,
      run_in_background: runInBackground,
    }: { command: string; timeout?: number; run_in_background?: boolean },
    context,
  ) => {
    const maxTimeout = runInBackground
      ? MAX_TIMEOUT_SECONDS
      : MAX_FOREGROUND_TIMEOUT_SECONDS
    if (
      timeout !== undefined &&
      (!Number.isFinite(timeout) || timeout <= 0 || timeout > maxTimeout)
    )
      throw new Error(
        `Invalid timeout: must be a positive number of seconds, at most ${maxTimeout}`,
      )
    if (!runInBackground) {
      return environmentBash(
        command,
        timeout ?? DEFAULT_FOREGROUND_TIMEOUT_SECONDS,
        cwd,
        shellPath,
        context,
      )
    }
    // Only the extension installs the capability, and a job needs the tool that reads and ends it:
    // a session without both (no extension, a DM, a narrowed tool list) refuses the parameter instead
    // of starting a command nothing could stop.
    const commands = context?.background
    if (!commands || !isStoppable(context))
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
  /** Undefined when the command was cancelled, or when the user moved it to the background */
  exitCode: number | undefined
  cancelled: boolean
  /** Whether `output` is only the end of the output */
  truncated: boolean
  /** File with the whole output, set when `output` is truncated */
  fullOutputPath?: string
  /**
   * Set when the command was moved to the background while it ran: `output` is the tail so far and
   * the exit arrives as a background result.
   */
  backgroundTaskId?: string
}

/** Run a user command inside the selected execution environment. */
export async function runBash(
  command: string,
  options: {
    env: ExecutionEnv
    signal?: AbortSignal
    onUpdate?: (output: string) => void
    onDelta?: (delta: string) => void
    /** The tail the job table also holds, so a moved command keeps reporting from the same buffer */
    output?: OutputTail
  },
): Promise<BashResult> {
  const output = options.output ?? new OutputTail()
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
        options.onUpdate?.(output.read().text)
      } catch {}
    }
  }
  const run = await options.env
    .exec(
      command,
      {
        spill: { afterBytes: OUTPUT_MAX_BYTES, afterLines: OUTPUT_MAX_LINES },
        onOutput: (text) => {
          output.append(text)
          if (options.onDelta) pendingDelta += text
          if (!timer && (options.onDelta || options.onUpdate))
            timer = setTimeout(() => publish(false), 100)
        },
      },
      options.signal,
    )
    .finally(() => publish(true))
  const tail = output.read()
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
