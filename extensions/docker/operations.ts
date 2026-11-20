import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type {
  ExecutionEnv,
  ExecutionError,
  FileError,
  Result,
  ShellExecOptions,
} from '@glows777/vela-core'
import type { readEnvironmentInventory } from '../../packages/core/src/session/environment-inventory.ts'
import {
  type InventoryEnv,
  workspaceDiscovery,
} from '../../packages/core/src/session/workspace-discovery.ts'

type Failure = FileError | ExecutionError
function failure<C extends Failure['code']>(code: C, message: string) {
  return {
    ok: false as const,
    error: Object.assign(new Error(message), { code }),
  }
}

// Each docker exec has its own stdin/stdout pair. Process output stays inside labeled JSON
// records, so a command cannot be mistaken for the Docker client's status or control data.
class Exchange {
  private readonly lines
  readonly done: Promise<void>
  private stderr = ''
  private stopping = false
  constructor(
    private child: ChildProcessWithoutNullStreams,
    finished: () => void,
  ) {
    const output = createInterface({ input: child.stdout, terminal: false })
    this.lines = output[Symbol.asyncIterator]()
    child.stderr.on('data', (buf) => {
      this.stderr = (this.stderr + buf.toString()).slice(-4096)
    })
    child.on('error', (err) => {
      this.stderr = err.message
    })
    child.stdin.on('error', (err) => {
      this.stderr ||= err.message
    })
    this.done = new Promise((resolve) =>
      child.once('close', () => {
        // A failed spawn can close stdout without an end event.
        output.close()
        finished()
        resolve()
      }),
    )
  }
  stop() {
    if (!this.stopping) {
      this.stopping = true
      this.child.stdin.end()
    }
    return this.done
  }
  async cleanup() {
    await this.stop()
    if (this.child.exitCode !== 0)
      throw new Error(
        this.stderr.trim() || 'Docker guest cleanup could not be confirmed',
      )
  }
  async request<T, E extends Failure>(
    args: unknown[],
    signal?: AbortSignal,
    onOutput?: ShellExecOptions['onOutput'],
  ): Promise<Result<T, E>> {
    const abort = () => {
      if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded)
        this.child.stdin.write('cancel\n')
    }
    let callbackError: Error | undefined
    try {
      if (signal?.aborted)
        return failure('aborted', 'Operation aborted') as Result<T, E>
      if (this.stopping) throw Error('Docker operation closed')
      this.child.stdin.write(`${JSON.stringify(args)}\n`)
      signal?.addEventListener('abort', abort, { once: true })
      for (;;) {
        const item = await this.lines.next()
        if (item.done) {
          await this.done
          throw Error(
            this.stderr.trim() || 'Docker exec closed without a result',
          )
        }
        const record = JSON.parse(item.value)
        if (record.stream === 'stdout' || record.stream === 'stderr') {
          if (!callbackError && !signal?.aborted)
            try {
              onOutput?.(record.text, signal, { stream: record.stream })
            } catch (e) {
              callbackError = e instanceof Error ? e : new Error(String(e))
              abort()
            }
          continue
        }
        if (typeof record.ok !== 'boolean')
          throw Error('Invalid Docker exec result')
        if (callbackError) {
          await this.cleanup()
          const spillPath = record.ok
            ? record.value.spillPath
            : record.error.spillPath
          return {
            ok: false,
            error: Object.assign(callbackError, {
              name: 'ExecutionError',
              code: 'callback_error',
              ...(spillPath ? { spillPath } : {}),
            }) as E,
          }
        }
        if (!record.ok)
          record.error = Object.assign(
            new Error(record.error.message),
            record.error,
          )
        return record.ok ? { ok: true, value: record.value } : record
      }
    } catch (e) {
      void this.stop()
      return failure('unavailable', String(e)) as Result<T, E>
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }
}

function bytes(
  result: Result<string, FileError>,
): Result<Uint8Array, FileError> {
  return result.ok
    ? { ok: true, value: new Uint8Array(Buffer.from(result.value, 'base64')) }
    : result
}

export function dockerOperations(
  id: string,
  cwd: string,
  spawnGuest: (op: string, cwd: string) => ChildProcessWithoutNullStreams,
): ExecutionEnv {
  const active = new Set<Exchange>()
  function start(op: string) {
    const channel = new Exchange(spawnGuest(op, env.cwd), () =>
      active.delete(channel),
    )
    active.add(channel)
    return channel
  }
  async function file<T>(
    op: string,
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<Result<T, FileError>> {
    if (signal?.aborted) return failure('aborted', 'Operation aborted')
    let channel: Exchange | undefined
    try {
      channel = start(op)
      return await channel.request<T, FileError>(args, signal)
    } catch (e) {
      return failure('unavailable', String(e))
    } finally {
      await channel?.stop()
    }
  }
  const env: InventoryEnv = {
    async [workspaceDiscovery](contextEnabled, signal) {
      const result = await file<
        Awaited<ReturnType<typeof readEnvironmentInventory>>
      >('discoverWorkspace', [contextEnabled], signal)
      if (!result.ok) throw result.error
      return result.value
    },
    id,
    cwd,
    absolutePath: (p, s) => file('absolutePath', [p], s),
    joinPath: (p, s) => file('joinPath', [p], s),
    canonicalPath: (p, s) => file('canonicalPath', [p], s),
    exists: (p, s) => file('exists', [p], s),
    readTextFile: (p, s) => file('readTextFile', [p], s),
    readBinaryFile: async (p, s) => bytes(await file('readBinaryFile', [p], s)),
    writeFile: (p, data, s) =>
      file('writeFile', [p, Buffer.from(data).toString('base64')], s),
    renameFile: (a, b, s) => file('renameFile', [a, b], s),
    fileInfo: (p, s) => file('fileInfo', [p], s),
    listDir: (p, s) => file('listDir', [p], s),
    createDir: (p, o, s) => file('createDir', [p, o ?? {}], s),
    createTempFile: (o, s) => file('createTempFile', [o ?? {}], s),
    remove: (p, o, s) => file('remove', [p, o ?? {}], s),
    async openBinaryReader(p, o, s) {
      if (s?.aborted) return failure('aborted', 'Operation aborted')
      let channel: Exchange
      try {
        channel = start('openBinaryReader')
      } catch (e) {
        return failure('unavailable', String(e))
      }
      const opened = await channel.request<null, FileError>([p, o], s)
      if (!opened.ok) {
        await channel.stop()
        return opened
      }
      let closed = false
      let queue = Promise.resolve()
      function call<T>(
        args: unknown[],
        signal?: AbortSignal,
      ): Promise<Result<T, FileError>> {
        const task = queue.then(() =>
          closed
            ? failure('invalid', 'Binary reader closed')
            : channel.request<T, FileError>(args, signal),
        )
        queue = task.then(() => {})
        return task
      }
      return {
        ok: true,
        value: {
          info: (signal) => call(['info'], signal),
          read: async (offset, length, signal) =>
            bytes(await call(['read', offset, length], signal)),
          scanLines: (opts, signal) =>
            call(
              [
                'scanLines',
                opts.endLine === Infinity
                  ? { startLine: opts.startLine }
                  : opts,
              ],
              signal,
            ),
          async close() {
            closed = true
            await channel.stop()
          },
        },
      }
    },
    async exec(command, options = {}, signal) {
      if (signal?.aborted) return failure('aborted', 'Operation aborted')
      let channel: Exchange
      try {
        channel = start('exec')
      } catch (e) {
        return failure('unavailable', String(e))
      }
      const { onOutput, ...settings } = options
      return channel.request([command, settings], signal, onOutput)
    },
    async cleanup() {
      await Promise.all([...active].map((channel) => channel.cleanup()))
    },
  }
  return env
}
