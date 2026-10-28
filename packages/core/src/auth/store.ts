import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { isPlainObject } from '../config/interpolate.ts'
import type { Credential, CredentialStore } from './types.ts'

/** Runs writes for one key in order, so `modify` calls in this process never overlap. */
function serializer() {
  const chains = new Map<string, Promise<unknown>>()
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const run = (chains.get(key) ?? Promise.resolve()).then(task, task)
    const tail = run.catch(() => {})
    chains.set(key, tail)
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key)
    })
    return run
  }
}

/** Credentials kept in memory only (the SDK default; nothing is written to disk). */
export function memoryCredentialStore(
  initial: Record<string, Credential> = {},
): CredentialStore {
  const credentials = new Map(Object.entries(initial))
  const serialize = serializer()
  return {
    get: (provider) => credentials.get(provider),
    list: () => [...credentials.keys()],
    modify: (provider, fn) =>
      serialize(provider, async () => {
        const next = await fn(credentials.get(provider))
        if (next) credentials.set(provider, next)
        return credentials.get(provider)
      }),
    delete: (provider) =>
      serialize(provider, async () => {
        credentials.delete(provider)
      }),
  }
}

/** A lock older than this belongs to a process that died mid-write (pi's proper-lockfile uses the same) */
const STALE_LOCK_MS = 30_000
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 20_000

/**
 * Credentials in a JSON file (the CLI's `~/.vela/auth.json`, same format as pi's): `{ "<provider>": credential }`,
 * created with mode 0600 in a 0700 directory. Writes take a lock file next to it (`auth.json.lock`), so several
 * Vela processes (a terminal and a Feishu server) refresh a token once; the file is rewritten atomically.
 */
export function fileCredentialStore(path: string): CredentialStore {
  const serialize = serializer()
  let cache:
    | { mtimeMs: number; size: number; data: Record<string, Credential> }
    | undefined

  const read = (): Record<string, Credential> => {
    if (!existsSync(path)) return {}
    const stat = statSync(path)
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size)
      return cache.data
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'))
    } catch (error) {
      throw new Error(`${path} is not valid JSON: ${(error as Error).message}`)
    }
    if (!isPlainObject(raw)) throw new Error(`${path} must contain an object`)
    for (const [provider, credential] of Object.entries(raw))
      if (
        !isPlainObject(credential) ||
        (credential.type !== 'api_key' && credential.type !== 'oauth')
      )
        throw new Error(
          `${path}: ${provider} must be an object with type "api_key" or "oauth"`,
        )
    cache = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      data: raw as Record<string, Credential>,
    }
    return cache.data
  }

  const write = (data: Record<string, Credential>) => {
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, path)
    cache = undefined
  }

  const withFileLock = async <T>(task: () => Promise<T>): Promise<T> => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const lock = `${path}.lock`
    const started = Date.now()
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx', 0o600))
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS)
            rmSync(lock, { force: true })
        } catch {}
        if (Date.now() - started > LOCK_TIMEOUT_MS)
          throw new Error(
            `Timed out waiting for ${lock}; if no other Vela is signing in, delete it`,
          )
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
      }
    }
    try {
      return await task()
    } finally {
      rmSync(lock, { force: true })
    }
  }

  return {
    get: (provider) => read()[provider],
    list: () => Object.keys(read()),
    modify: (provider, fn) =>
      serialize(provider, () =>
        withFileLock(async () => {
          // Re-read under the lock: another process may have refreshed or signed in meanwhile
          cache = undefined
          const data = read()
          const next = await fn(data[provider])
          if (next) write({ ...read(), [provider]: next })
          return read()[provider]
        }),
      ),
    delete: (provider) =>
      serialize(provider, () =>
        withFileLock(async () => {
          cache = undefined
          const data = read()
          if (!(provider in data)) return
          const { [provider]: _, ...rest } = data
          write(rest)
        }),
      ),
  }
}
