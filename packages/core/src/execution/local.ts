import { type ChildProcess, spawn } from 'node:child_process'
import { access, appendFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:os'
import { signalProcessTree } from '../tools/process-tree.ts'
import { StreamDecoder } from './decode.ts'
import { LocalFiles } from './local-files.ts'
import type {
  ExecutionEnv,
  ExecutionError,
  ExecutionErrorCode,
  Result,
  ShellExecOptions,
  ShellExecResult,
} from './types.ts'

function error(
  code: ExecutionErrorCode,
  message: string,
  cause?: unknown,
): ExecutionError {
  return Object.assign(new Error(message, { cause }), {
    name: 'ExecutionError',
    code,
  })
}
class LocalExecutionEnv extends LocalFiles implements ExecutionEnv {
  constructor(options: {
    cwd: string
    shellPath?: string
    tempRoot?: string
    loginShell?: boolean
  }) {
    super(options.cwd, options.tempRoot)
    this.shellPath = options.shellPath
    this.loginShell = options.loginShell ?? false
  }
  private readonly shellPath?: string
  private readonly loginShell: boolean
  private readonly active = new Set<ChildProcess>()
  async exec(
    command: string | readonly string[],
    options: ShellExecOptions = {},
    signal?: AbortSignal,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (signal?.aborted)
      return { ok: false, error: error('aborted', 'aborted') }
    if (process.platform !== 'win32')
      for (const child of this.active)
        if (
          (child.exitCode !== null || child.signalCode !== null) &&
          !this.groupAlive(child)
        )
          this.active.delete(child)
    if (
      options.timeout !== undefined &&
      (!Number.isFinite(options.timeout) ||
        options.timeout <= 0 ||
        options.timeout * 1000 > 2147483647)
    )
      return { ok: false, error: error('timeout', 'Invalid timeout') }
    const argv =
      typeof command === 'string'
        ? [
            this.shellPath ??
              (process.platform === 'win32' ? 'bash.exe' : 'bash'),
            this.loginShell ? '-lc' : '-c',
            command,
          ]
        : [...command]
    if (!argv[0])
      return { ok: false, error: error('spawn_error', 'Empty command') }
    const resolvedCwd = options.cwd
      ? await this.absolutePath(options.cwd, signal)
      : { ok: true as const, value: this.cwd }
    if (!resolvedCwd.ok)
      return {
        ok: false,
        error: error(
          signal?.aborted ? 'aborted' : 'spawn_error',
          resolvedCwd.error.message,
          resolvedCwd.error,
        ),
      }
    try {
      await access(resolvedCwd.value)
    } catch (cause) {
      return {
        ok: false,
        error: error(
          'spawn_error',
          `Working directory unavailable: ${resolvedCwd.value}`,
          cause,
        ),
      }
    }
    if (signal?.aborted)
      return { ok: false, error: error('aborted', 'aborted') }
    let child: ChildProcess
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: resolvedCwd.value,
        // Like the MCP stdio transport, command execution must preserve the inherited
        // environment while applying per-command overrides; it does not read settings.
        env: {
          // vela-boundary: allow
          ...(options.inheritEnv === false ? {} : process.env),
          ...options.env,
        },
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (cause) {
      return { ok: false, error: error('spawn_error', String(cause), cause) }
    }
    this.active.add(child)
    let stopped:
      | 'aborted'
      | 'timeout'
      | 'callback_error'
      | 'unknown'
      | undefined
    let streamError: unknown
    let spillPath: string | undefined
    let bytes = 0,
      lines = 0
    let retained: Buffer[] = []
    let queue = Promise.resolve()
    let pending = 0
    const stop = (reason: typeof stopped) => {
      if (stopped) return
      stopped = reason
      void signalProcessTree(child, 'SIGKILL').catch(() => {})
    }
    const abort = () => stop('aborted')
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = options.timeout
      ? setTimeout(() => stop('timeout'), options.timeout * 1000)
      : undefined
    const decoders = {
      stdout: new StreamDecoder(),
      stderr: new StreamDecoder(),
    }
    const bind = (stream: NodeJS.ReadableStream, name: 'stdout' | 'stderr') => {
      const decoder = decoders[name]
      stream.on('data', (raw: Buffer) => {
        child.stdout?.pause()
        child.stderr?.pause()
        const chunk = Buffer.from(raw)
        pending++
        queue = queue
          .then(async () => {
            const text = decoder.decode(chunk)
            if (text && !stopped) {
              try {
                options.onOutput?.(text, signal, { stream: name })
              } catch (cause) {
                streamError = cause
                stop('callback_error')
              }
            }
            if (options.spill) {
              bytes += chunk.length
              for (const byte of chunk) if (byte === 10) lines++
              if (!spillPath) {
                retained.push(chunk)
                if (
                  bytes > options.spill.afterBytes ||
                  lines +
                    (chunk.length && chunk[chunk.length - 1] !== 10 ? 1 : 0) >
                    options.spill.afterLines
                ) {
                  const result = await this.createTempFile(
                    { prefix: 'vela-output-', suffix: '.log' },
                    signal,
                  )
                  if (!result.ok) throw result.error
                  spillPath = result.value
                  await writeFile(spillPath, Buffer.concat(retained))
                  retained = []
                }
              } else await appendFile(spillPath, chunk)
            }
          })
          .catch((cause) => {
            streamError = cause
            stop('unknown')
          })
          .finally(() => {
            pending--
            child.stdout?.resume()
            child.stderr?.resume()
          })
      })
    }
    bind(child.stdout!, 'stdout')
    bind(child.stderr!, 'stderr')
    try {
      const result = await new Promise<{
        code: number | null
        signal: NodeJS.Signals | null
      }>((accept, reject) => {
        let settled = false
        let exited = false
        let exitCode: number | null = null
        let exitSignal: NodeJS.Signals | null = null
        let grace: ReturnType<typeof setTimeout> | undefined
        const finish = () => {
          if (settled) return
          settled = true
          if (grace) clearTimeout(grace)
          child.stdout?.destroy()
          child.stderr?.destroy()
          accept({ code: exitCode, signal: exitSignal })
        }
        const arm = () => {
          if (grace) clearTimeout(grace)
          grace = setTimeout(() => {
            if (pending) arm()
            else finish()
          }, 100)
        }
        child.once('error', (cause) => {
          if (!settled) {
            settled = true
            if (grace) clearTimeout(grace)
            reject(cause)
          }
        })
        child.once('exit', (code, sig) => {
          exited = true
          exitCode = code
          exitSignal = sig
          arm()
        })
        child.once('close', (code, sig) => {
          exitCode = code
          exitSignal = sig
          finish()
        })
        child.stdout?.on('data', () => {
          if (exited && !settled) arm()
        })
        child.stderr?.on('data', () => {
          if (exited && !settled) arm()
        })
      })
      await queue
      for (const name of ['stdout', 'stderr'] as const) {
        const text = decoders[name].decode()
        if (text && !stopped) {
          try {
            options.onOutput?.(text, signal, { stream: name })
          } catch (cause) {
            streamError = cause
            stop('callback_error')
          }
        }
      }
      if (stopped) {
        const message =
          stopped === 'unknown'
            ? `Failed to preserve complete shell output: ${String(streamError)}`
            : stopped
        const e = error(stopped, message, streamError)
        if (spillPath) {
          if (stopped === 'unknown')
            await this.remove(spillPath, { force: true })
          else e.spillPath = spillPath
        }
        return { ok: false, error: e }
      }
      return {
        ok: true,
        value: {
          exitCode:
            result.code ??
            (result.signal ? 128 + (constants.signals[result.signal] ?? 0) : 1),
          ...(spillPath ? { spillPath } : {}),
        },
      }
    } catch (cause) {
      return {
        ok: false,
        error: error(
          typeof command === 'string' &&
            (cause as NodeJS.ErrnoException)?.code === 'ENOENT'
            ? 'shell_unavailable'
            : 'spawn_error',
          String(cause),
          cause,
        ),
      }
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      // The shell may exit while a background descendant still owns its group.
      // Keep that group reachable until cleanup; otherwise drop the finished child.
      if (process.platform === 'win32' || !this.groupAlive(child))
        this.active.delete(child)
    }
  }
  async cleanup(): Promise<void> {
    await Promise.all(
      [...this.active].map(async (child) => {
        try {
          await signalProcessTree(child, 'SIGKILL')
        } catch (cause) {
          // Darwin may return EPERM after the shell and its group have exited.
          // Only tolerate that refusal for a shell whose exit we have observed.
          const exited = child.exitCode !== null || child.signalCode !== null
          if (!exited || (cause as NodeJS.ErrnoException)?.code !== 'EPERM')
            throw cause
        }
      }),
    )
    this.active.clear()
  }
  withResultRoot(root: string): LocalExecutionEnv {
    // A resolver may reuse its adapter across sessions. Preserve its overrides
    // and active children without changing the result directory of another call.
    if (this.tempRoot !== undefined) return this
    const scoped: LocalExecutionEnv = Object.create(this)
    scoped.tempRoot = root
    return scoped
  }
  private groupAlive(child: ChildProcess): boolean {
    if (child.pid === undefined) return false
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }
}
export function createLocalExecutionEnv(options: {
  cwd: string
  shellPath?: string
}): ExecutionEnv {
  return new LocalExecutionEnv(options)
}

/** @internal Scope the stock local adapter's files to their owning session. */
export function scopeLocalResults(
  env: ExecutionEnv,
  root: string,
): ExecutionEnv {
  return env instanceof LocalExecutionEnv ? env.withResultRoot(root) : env
}

/** @internal Use the session-owned result root for local spill files. */
export function createSessionLocalExecutionEnv(options: {
  cwd: string
  shellPath?: string
  tempRoot: string
}): ExecutionEnv {
  return new LocalExecutionEnv({ ...options, loginShell: true })
}
