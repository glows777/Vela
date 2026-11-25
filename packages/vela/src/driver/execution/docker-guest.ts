import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import {
  type GuestCredentialConfig,
  prepareGuestCredentials,
} from '../../shared/docker-guest-credentials.ts'
import { readEnvironmentInventory } from '../session/environment-inventory.ts'
import { LocalExecutionEnv } from './local.ts'
import type { BinaryReader, Result, ShellExecOptions } from './types.ts'

// This program is supplied by the host on docker exec's argv. Each process owns one operation or reader.
async function main() {
  const [op, cwd, tempRoot, credentialConfig] = process.argv.slice(1)
  const env = new LocalExecutionEnv({ cwd: cwd!, tempRoot: tempRoot! })
  const input = createInterface({ input: process.stdin, terminal: false })
  const lines = input[Symbol.asyncIterator]()
  let cancel = new AbortController()
  let closed = false
  input.on('line', (line) => {
    if (line === 'cancel') cancel.abort()
    else cancel = new AbortController()
  })
  input.on('close', () => {
    closed = true
    cancel.abort()
  })
  const emit = (data: unknown) =>
    process.stdout.write(`${JSON.stringify(data)}\n`)
  function reply(result: Result<unknown, Error>) {
    if (!result.ok) {
      const e = result.error
      emit({ ok: false, error: { ...e, name: e.name, message: e.message } })
    } else
      emit({
        ok: true,
        value:
          result.value instanceof Uint8Array
            ? Buffer.from(result.value).toString('base64')
            : result.value,
      })
  }
  const first = await lines.next()
  if (first.done) return
  const args = JSON.parse(first.value)
  let reader: BinaryReader | undefined
  let credentials:
    | Awaited<ReturnType<typeof prepareGuestCredentials>>
    | undefined
  try {
    if (op === 'exec') {
      const [command, options] = args as [string | string[], ShellExecOptions]
      if (credentialConfig) {
        const inherited = options.inheritEnv === false ? undefined : process.env
        credentials = await prepareGuestCredentials(
          JSON.parse(credentialConfig) as GuestCredentialConfig,
          resolve(cwd!, options.cwd ?? '.'),
          {
            SSL_CERT_FILE:
              options.env?.SSL_CERT_FILE ?? inherited?.SSL_CERT_FILE,
            GIT_SSL_CAINFO:
              options.env?.GIT_SSL_CAINFO ?? inherited?.GIT_SSL_CAINFO,
          },
        )
      }
      const result = await env.exec(
        command,
        {
          ...options,
          ...(credentials && { env: { ...options.env, ...credentials.env } }),
          onOutput: (text, _signal, { stream }) => {
            emit({ stream, text })
          },
        },
        cancel.signal,
      )
      reply(result)
      // A finished foreground shell can still own background children. Keep only its own
      // short-lived process handle available for environment cleanup until they exit.
      while (!closed && env.hasActiveGroups()) await delay(100)
    } else if (op === 'openBinaryReader') {
      const opened = await env.openBinaryReader(args[0], args[1], cancel.signal)
      if (!opened.ok) {
        reply(opened)
        return
      }
      reader = opened.value
      reply({ ok: true, value: null })
      for await (const line of lines) {
        if (line === 'cancel') continue
        if (closed) break
        const [method, a, b] = JSON.parse(line)
        if (method === 'info') reply(await reader.info(cancel.signal))
        else if (method === 'read')
          reply(await reader.read(a, b, cancel.signal))
        else if (method === 'scanLines')
          reply(await reader.scanLines(a, cancel.signal))
        else throw Error('Unknown reader operation')
      }
    } else {
      const signal = cancel.signal
      switch (op) {
        case 'discoverWorkspace':
          try {
            reply({
              ok: true,
              value: await readEnvironmentInventory(
                env,
                args[0],
                signal,
                Array.isArray(args[1]) ? args[1] : [],
                Array.isArray(args[2]) ? args[2] : [],
              ),
            })
          } catch (cause) {
            reply({
              ok: false,
              error: signal.aborted
                ? Object.assign(Error('Operation aborted'), { code: 'aborted' })
                : cause instanceof Error
                  ? cause
                  : Error(String(cause)),
            })
          }
          break
        case 'insideGitRepo': {
          const abs = await env.absolutePath(args[0], signal)
          if (!abs.ok) {
            reply(abs)
            break
          }
          let current = abs.value
          let inside = false
          for (;;) {
            const git = await env.joinPath([current, '.git'], signal)
            if (!git.ok) {
              reply(git)
              current = ''
              break
            }
            const found = await env.exists(git.value, signal)
            if (!found.ok) {
              reply(found)
              current = ''
              break
            }
            if (found.value) {
              inside = true
              break
            }
            const parent = await env.joinPath([current, '..'], signal)
            if (!parent.ok) {
              reply(parent)
              current = ''
              break
            }
            if (parent.value === current) break
            current = parent.value
          }
          if (current !== '') reply({ ok: true, value: inside })
          break
        }
        case 'absolutePath':
          reply(await env.absolutePath(args[0], signal))
          break
        case 'canonicalPath':
          reply(await env.canonicalPath(args[0], signal))
          break
        case 'exists':
          reply(await env.exists(args[0], signal))
          break
        case 'joinPath':
          reply(await env.joinPath(args[0], signal))
          break
        case 'readTextFile':
          reply(await env.readTextFile(args[0], signal))
          break
        case 'readBinaryFile':
          reply(await env.readBinaryFile(args[0], signal))
          break
        case 'writeFile':
          reply(
            await env.writeFile(
              args[0],
              Buffer.from(args[1], 'base64'),
              signal,
            ),
          )
          break
        case 'renameFile':
          reply(await env.renameFile(args[0], args[1], signal))
          break
        case 'fileInfo':
          reply(await env.fileInfo(args[0], signal))
          break
        case 'listDir':
          reply(await env.listDir(args[0], signal))
          break
        case 'createDir':
          reply(await env.createDir(args[0], args[1], signal))
          break
        case 'createTempFile':
          reply(await env.createTempFile(args[0] ?? {}, signal))
          break
        case 'remove':
          reply(await env.remove(args[0], args[1], signal))
          break
        default:
          throw Error('Unknown file operation')
      }
    }
  } finally {
    await reader?.close()
    try {
      await env.cleanup()
    } finally {
      await credentials?.close()
    }
    input.close()
    process.stdin.destroy()
  }
}
main().catch((e) => {
  console.error(e.message)
  process.exitCode = 1
})
