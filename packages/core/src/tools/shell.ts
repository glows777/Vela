import { type ChildProcess, spawn } from 'node:child_process'
import { type FileHandle, open, stat } from 'node:fs/promises'
import { constants } from 'node:os'
import z from 'zod'
import type { ExecutionMetadata } from '../session/tool-history.ts'
import { ToolResultStore } from '../session/tool-results.ts'
import {
  fitOutputTail,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_LINES,
  type OutputTailFit,
} from './output-tail.ts'
import { signalProcessTree } from './process-tree.ts'
import type { ToolDefinition } from './registry.ts'
import type { RunningShell, ShellRun } from './running-shell.ts'

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000 // setTimeout's limit
/** How often a running command's output tail is sent to onUpdate (pi's BASH_UPDATE_THROTTLE_MS) */
const BASH_UPDATE_INTERVAL_MS = 100

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
      'Run the command in the background and return at once with its id and output file. Its output arrives here when it exits; read the file to see output so far. Use it for a server, a watch build or a long test run instead of blocking the turn.',
    ),
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
  description: `Runs a shell command in the working directory. Returns the combined stdout/stderr, truncated to the last ${OUTPUT_MAX_LINES} lines or ${OUTPUT_MAX_BYTES / 1024}KB (whichever is hit first); the full output is saved to a file that read_file can page through. Optionally provide a timeout in seconds; there is no default timeout. With run_in_background the command starts as a background task: the call returns at once with its id and output file, its result arrives here when it exits, and the command dies with this session.`,
  inputSchema: bashToolParamSchema,
  annotations: { destructiveHint: true, openWorldHint: true },
  promptSnippet: 'Run a shell command',
  promptGuidelines: [
    'A command that may keep running (a dev server, a watch build, a long test run) starts with bash and run_in_background: true instead of blocking the turn, where the session has the background tools.',
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
    const commands = runInBackground ? context?.background : undefined
    if (runInBackground && !commands)
      throw new Error(
        'Background commands are not enabled in this session: it has no background tools. Run the command without run_in_background, or enable the background extension and its tools for this session.',
      )
    const results = context?.results ?? new ToolResultStore()
    // Open before executing: storage failure must not lead to rerunning a command.
    const { path, file } = await results.createFile(context?.callId)
    let status: string | undefined
    const execution: ExecutionMetadata = {}
    try {
      const shell = await startShell(command, file, path, {
        cwd,
        shellPath: shellPath ?? defaultShellPath(),
        timeout,
        // A background command belongs to the session, not to this run: the job ends it, not Stop.
        signal: runInBackground ? undefined : context?.signal,
        onUpdate:
          !runInBackground && context?.onUpdate
            ? (text) =>
                context.onUpdate?.({ content: [{ type: 'text', text }] })
            : undefined,
      })
      if (commands) {
        const id = commands.adopt(shell)
        execution.backgroundTaskId = id
        status = `Command running in background with ID: ${id}. Output is being written to: ${path}.\nYou will be notified when it completes; do not poll the file or start a second copy.`
      } else {
        const run = await shell.exited
        execution.exitCode = run.exitCode
        execution.signal = run.signal
        execution.timedOut = run.timedOut || undefined
        execution.isError = run.exitCode !== 0 || run.timedOut
        if (run.timedOut) status = `Command timed out after ${timeout} seconds`
        else if (run.cancelled) status = 'Command aborted'
        else if (run.exitCode !== 0)
          status = `Command exited with code ${run.exitCode}${run.signal ? ` (signal ${run.signal})` : ''}`
      }
    } catch (error) {
      execution.isError = true
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined
      let workingDirectoryError: string | undefined
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        const workingDirectory = cwd ?? process.cwd()
        try {
          if (!(await stat(workingDirectory)).isDirectory())
            workingDirectoryError = `Working directory is not a directory: ${workingDirectory}`
        } catch (directoryError) {
          const directoryErrorCode =
            directoryError &&
            typeof directoryError === 'object' &&
            'code' in directoryError
              ? directoryError.code
              : undefined
          if (
            directoryErrorCode === 'ENOENT' ||
            directoryErrorCode === 'ENOTDIR'
          )
            workingDirectoryError = `Working directory not found: ${workingDirectory}`
        }
      }
      const resolvedShell = shellPath ?? defaultShellPath()
      const shellUnavailable = code === 'ENOENT' && !workingDirectoryError
      execution.toolUnavailable = shellUnavailable || undefined
      execution.error =
        workingDirectoryError ??
        (shellUnavailable
          ? `Shell not found: ${resolvedShell}. The command did not run. Bash is disabled for this session; ${process.platform === 'win32' ? 'install Git for Windows or set shellPath to its bin\\bash.exe' : 'install Bash or set shellPath to a Bash-compatible executable'}. Read-only fallback tools may now be available.`
          : error instanceof Error
            ? error.message
            : String(error))
      status = execution.error
    }
    const { size } = await stat(path)
    const tail = await readTail(path, size)
    let preview =
      tail.text || (size ? '' : commands ? '(no output so far)' : '(no output)')
    if (tail.truncated)
      preview += `\n\n[Showing the last ${tail.lines} lines${tail.partialLine ? ' (the last line is cut)' : ''} of ${size} bytes of output. Full output: ${path}]`
    if (status) preview += `${preview ? '\n\n' : ''}${status}`
    return results.reference(path, preview, context?.callId, execution)
  },
})

/** Options for a shell run; the bash tool and a background job pass the same ones. */
export interface ShellRunOptions {
  cwd?: string
  shellPath?: string
  timeout?: number
  signal?: AbortSignal
  /** The output tail while the command runs */
  onUpdate?: (text: string) => void
  /** Each new piece of output, all of it, in order */
  onDelta?: (delta: string) => void
}

/**
 * Starts a command with stdout and stderr going to `file`, which it closes when the command exits.
 * The process group is killed on timeout or abort. Throws if the command cannot start, after
 * closing the file.
 */
export async function startShell(
  command: string,
  file: FileHandle,
  path: string,
  options: ShellRunOptions,
): Promise<RunningShell> {
  let proc: ChildProcess
  try {
    proc = spawn(options.shellPath ?? defaultShellPath(), ['-lc', command], {
      cwd: options.cwd,
      stdio: ['ignore', file.fd, file.fd],
      // POSIX process groups and Windows taskkill /T stop pipelines and descendants.
      detached: process.platform !== 'win32',
    })
  } catch (error) {
    // spawn throws synchronously for an invalid command; the caller must not inherit an open file.
    await file.close().catch(() => {})
    throw error
  }
  try {
    await new Promise<void>((resolve, reject) => {
      proc.once('spawn', () => resolve())
      proc.once('error', reject)
    })
  } catch (error) {
    await file.close().catch(() => {})
    throw error
  }
  const { signal: abortSignal } = options
  const streaming =
    options.onUpdate || options.onDelta
      ? streamOutput(path, options.onUpdate, options.onDelta)
      : undefined
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
  const exited = (async (): Promise<ShellRun> => {
    try {
      const result = await new Promise<{
        code: number | null
        signal: NodeJS.Signals | null
      }>((resolve) =>
        proc.once('exit', (code, signal) => resolve({ code, signal })),
      )
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
      await streaming?.stop()
      try {
        await file.sync()
      } finally {
        await file.close()
      }
    }
  })()
  return {
    command,
    path,
    pid: proc.pid,
    exited,
    signal: (signal) => {
      void signalProcessTree(proc, signal).catch(() => {
        try {
          proc.kill(signal)
        } catch {}
      })
    },
  }
}

/**
 * Runs a command to completion: the foreground path of the `bash` tool and of `!` commands.
 */
async function runShell(
  command: string,
  file: FileHandle,
  path: string,
  options: ShellRunOptions,
): Promise<ShellRun> {
  const shell = await startShell(command, file, path, options)
  return shell.exited
}

export type { RunningShell, ShellRun } from './running-shell.ts'

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

/** The tail of a command's output file: the last OUTPUT_MAX_LINES lines or OUTPUT_MAX_BYTES bytes. */
export async function readOutputTail(path: string): Promise<OutputTailFit> {
  const { size } = await stat(path)
  return readTail(path, size)
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
