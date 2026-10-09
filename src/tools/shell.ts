import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { constants } from 'node:os'
import z from 'zod'
import type { ExecutionMetadata } from '../session/tool-history.ts'
import { ToolResultStore } from '../session/tool-results.ts'
import type { ToolDefinition } from './registry.ts'

/** What the model gets of the output, same as pi: the last 2000 lines or 50KB, whichever is smaller */
export const BASH_MAX_LINES = 2000
export const BASH_MAX_BYTES = 50 * 1024
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000 // setTimeout's limit

const bashToolParamSchema = z.object({
  command: z.string().describe('Shell command to run'),
  timeout: z
    .number()
    .optional()
    .describe('Timeout in seconds (optional, no default timeout)'),
})

export interface BashToolOptions {
  /** Shell to run commands with (settings `shellPath`). Default: bash on PATH */
  shellPath?: string
}

export const createBashTool = (
  cwd?: string,
  { shellPath }: BashToolOptions = {},
): ToolDefinition => ({
  name: 'bash',
  description: `Runs a shell command in the working directory. Returns the combined stdout/stderr, truncated to the last ${BASH_MAX_LINES} lines or ${BASH_MAX_BYTES / 1024}KB (whichever is hit first); the full output is saved to a file that read_file can page through. Optionally provide a timeout in seconds; there is no default timeout.`,
  inputSchema: bashToolParamSchema,
  isReadOnly: false,
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
    // A configured shell that doesn't exist is a setup error: fail loudly, like pi
    if (shellPath && !existsSync(shellPath))
      throw new Error(
        `Shell not found: ${shellPath}. Fix or remove shellPath in settings.json.`,
      )
    const results = context?.results ?? new ToolResultStore()
    // Open before executing: storage failure must not lead to rerunning a command.
    const { path, file } = await results.createFile(context?.callId)
    let status: string | undefined
    const execution: ExecutionMetadata = {}
    try {
      const proc = spawn(shellPath ?? 'bash', ['-lc', command], {
        cwd,
        stdio: ['ignore', file.fd, file.fd],
        // POSIX process group lets timeout/cancellation stop pipelines and descendants.
        detached: process.platform !== 'win32',
      })
      const exited = new Promise<{
        code: number | null
        signal: NodeJS.Signals | null
      }>((resolve, reject) => {
        proc.once('error', reject)
        proc.once('exit', (code, signal) => resolve({ code, signal }))
      })
      const terminate = () => {
        try {
          if (process.platform === 'win32') proc.kill('SIGKILL')
          else if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGKILL')
        } catch (error) {
          if (
            !(
              error &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === 'ESRCH'
            )
          )
            throw error
        }
      }
      const timer =
        timeout === undefined
          ? undefined
          : setTimeout(() => {
              execution.timedOut = true
              terminate()
            }, timeout * 1000)
      context?.signal?.addEventListener('abort', terminate, { once: true })
      if (context?.signal?.aborted) terminate()
      let exitCode: number
      let signal: NodeJS.Signals | null
      try {
        const result = await exited
        signal = result.signal
        // Killed by a signal: 128 + signal number, as shells report it
        exitCode =
          result.code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)
      } finally {
        clearTimeout(timer)
        context?.signal?.removeEventListener('abort', terminate)
      }
      execution.exitCode = exitCode
      execution.signal = signal
      execution.isError = exitCode !== 0 || !!execution.timedOut
      if (execution.timedOut)
        status = `Command timed out after ${timeout} seconds`
      else if (context?.signal?.aborted) status = 'Command aborted'
      else if (exitCode !== 0)
        status = `Command exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}`
    } catch (error) {
      execution.isError = true
      execution.error = error instanceof Error ? error.message : String(error)
      status = `Command failed: ${error}`
    } finally {
      try {
        await file.sync()
      } finally {
        await file.close()
      }
    }
    const { size } = await stat(path)
    const tail = await readTail(path, size)
    let preview = tail.text || (size ? '' : '(no output)')
    if (tail.truncated)
      preview += `\n\n[Showing the last ${tail.lines} lines${tail.partialLine ? ' (the last line is cut)' : ''} of ${size} bytes of output. Full output: ${path}]`
    if (status) preview += `${preview ? '\n\n' : ''}${status}`
    return results.reference(
      path,
      'bash',
      preview,
      context?.toolCallId,
      execution,
      context?.callId,
    )
  },
})

export const bashTool = createBashTool()

/** The last BASH_MAX_LINES lines / BASH_MAX_BYTES bytes of the output file, cut at line starts */
async function readTail(
  path: string,
  size: number,
): Promise<{
  text: string
  lines: number
  truncated: boolean
  partialLine: boolean
}> {
  const start = Math.max(0, size - BASH_MAX_BYTES)
  const bytes = await readRange(path, start, size - start)
  let text = new TextDecoder().decode(bytes)
  let truncated = start > 0
  let partialLine = false
  if (start > 0) {
    // Drop the partial first line; one huge line is kept as its cut end (like pi)
    const newline = text.indexOf('\n')
    if (newline === -1 || newline === text.length - 1) {
      partialLine = true
      // A cut may land inside a UTF-8 sequence; drop the replacement character it decodes to
      text = text.replace(/^\uFFFD+/, '')
    } else text = text.slice(newline + 1)
  }
  const endsWithNewline = text.endsWith('\n')
  const lines = text.split('\n')
  if (endsWithNewline) lines.pop()
  if (lines.length > BASH_MAX_LINES) {
    lines.splice(0, lines.length - BASH_MAX_LINES)
    truncated = true
    text = lines.join('\n') + (endsWithNewline ? '\n' : '')
  }
  return { text, lines: lines.length, truncated, partialLine }
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
