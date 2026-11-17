import { spawn } from 'node:child_process'
import { type FileHandle, open, stat } from 'node:fs/promises'
import { constants } from 'node:os'
import z from 'zod'
import type { ToolResultStore } from '../session/tool-results.ts'
import { environmentBash } from './environment-bash.ts'
import {
  fitOutputTail,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_LINES,
  type OutputTailFit,
} from './output-tail.ts'
import { signalProcessTree } from './process-tree.ts'
import type { ToolDefinition } from './registry.ts'

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000 // setTimeout's limit
/** How often a running command's output tail is sent to onUpdate (pi's BASH_UPDATE_THROTTLE_MS) */
const BASH_UPDATE_INTERVAL_MS = 100

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

function defaultShellPath(): string {
  return process.platform === 'win32' ? 'bash.exe' : 'bash'
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

/** How a command run by `runShell` ended. */
interface ShellRun {
  /** The exit code, or 128 + the signal number when a signal killed it */
  exitCode: number
  signal: NodeJS.Signals | null
  timedOut: boolean
  /** `signal` aborted the command */
  cancelled: boolean
}

/**
 * Runs a command with stdout and stderr going to `file`, which it closes. The process group is
 * killed on timeout or abort. Throws if the command cannot start.
 */
async function runShell(
  command: string,
  file: FileHandle,
  path: string,
  options: {
    cwd?: string
    shellPath?: string
    timeout?: number
    signal?: AbortSignal
    /** The output tail while the command runs */
    onUpdate?: (text: string) => void
    /** Each new piece of output, all of it, in order */
    onDelta?: (delta: string) => void
  },
): Promise<ShellRun> {
  const { signal: abortSignal } = options
  const streaming =
    options.onUpdate || options.onDelta
      ? streamOutput(path, options.onUpdate, options.onDelta)
      : undefined
  try {
    const proc = spawn(
      options.shellPath ?? defaultShellPath(),
      ['-lc', command],
      {
        cwd: options.cwd,
        stdio: ['ignore', file.fd, file.fd],
        // POSIX process groups and Windows taskkill /T stop pipelines and descendants.
        detached: process.platform !== 'win32',
      },
    )
    const exited = new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>((resolve, reject) => {
      proc.once('error', reject)
      proc.once('exit', (code, signal) => resolve({ code, signal }))
    })
    let termination: Promise<void> | undefined
    const terminate = () => {
      termination ??= signalProcessTree(proc, 'SIGKILL')
    }
    let timedOut = false
    const timer =
      options.timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            terminate()
          }, options.timeout * 1000)
    abortSignal?.addEventListener('abort', terminate, { once: true })
    if (abortSignal?.aborted) terminate()
    try {
      const result = await exited
      await termination
      return {
        // Killed by a signal: 128 + signal number, as shells report it
        exitCode:
          result.code ??
          128 + (result.signal ? (constants.signals[result.signal] ?? 0) : 0),
        signal: result.signal,
        timedOut,
        cancelled: !!abortSignal?.aborted,
      }
    } finally {
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', terminate)
    }
  } finally {
    await streaming?.stop()
    try {
      await file.sync()
    } finally {
      await file.close()
    }
  }
}

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

/**
 * Runs a command for the user (pi's `executeBash`), not as a tool: no tool selection, hooks or tool
 * history. The whole output goes to a file from `results`; the result holds its tail.
 */
export async function runBash(
  command: string,
  options: {
    results: ToolResultStore
    cwd?: string
    shellPath?: string
    signal?: AbortSignal
    /** The output tail while the command runs */
    onUpdate?: (output: string) => void
    /** Each new piece of output, all of it, in order */
    onDelta?: (delta: string) => void
  },
): Promise<BashResult> {
  const { path, file } = await options.results.createFile()
  const run = await runShell(command, file, path, {
    ...options,
    shellPath: options.shellPath ?? defaultShellPath(),
  })
  const { size } = await stat(path)
  const tail = await readTail(path, size)
  return {
    output: tail.text.replace(/\n$/, ''),
    exitCode: run.cancelled ? undefined : run.exitCode,
    cancelled: run.cancelled,
    truncated: tail.truncated,
    ...(tail.truncated ? { fullOutputPath: path } : {}),
  }
}

/**
 * Sends the output tail to onUpdate and each new piece of output to onDelta while the command runs.
 * Unlike pi, which reads pipes, the output goes straight to the result file, so the file is polled;
 * stop() reads once more so onDelta gets everything.
 */
function streamOutput(
  path: string,
  onUpdate?: (text: string) => void,
  onDelta?: (delta: string) => void,
): { stop(): Promise<void> } {
  let sent = 0
  const decoder = new TextDecoder()
  let pending: Promise<void> = Promise.resolve()
  const poll = async (final = false) => {
    const { size } = await stat(path)
    if (size > sent && onDelta) {
      const delta = decoder.decode(await readRange(path, sent, size - sent), {
        stream: !final,
      })
      if (delta) onDelta(delta)
    } else if (final && onDelta) {
      const rest = decoder.decode()
      if (rest) onDelta(rest)
    }
    if (size === sent) return
    sent = size
    // The final read is only for onDelta: the caller gets the tail from the result
    if (onUpdate && !final) onUpdate((await readTail(path, size)).text)
  }
  let busy = false
  const timer = setInterval(() => {
    // Skip a tick while the previous read is still running; a read error only skips an update
    if (busy) return
    busy = true
    pending = poll()
      .catch(() => {})
      .finally(() => {
        busy = false
      })
  }, BASH_UPDATE_INTERVAL_MS)
  return {
    stop: async () => {
      clearInterval(timer)
      await pending
      if (onDelta) await poll(true).catch(() => {})
    },
  }
}

/**
 * The last output of the file, cut at line starts. Only the bytes that can be part of the tail are
 * read, so a huge log costs one bounded read.
 */
async function readTail(path: string, size: number): Promise<OutputTailFit> {
  const start = Math.max(0, size - OUTPUT_MAX_BYTES)
  const bytes = await readRange(path, start, size - start)
  return fitOutputTail(new TextDecoder().decode(bytes), start > 0)
}

async function readRange(
  path: string,
  position: number,
  length: number,
): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    const buffer = new Uint8Array(length)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
