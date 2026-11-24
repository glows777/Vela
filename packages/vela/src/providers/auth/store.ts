import { randomBytes, randomUUID } from 'node:crypto'
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
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { formatJsonParseError } from '../../config/index.ts'
import { isPlainObject } from '../../shared/interpolate.ts'
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
    deleteIf: (provider, predicate) =>
      serialize(provider, async () => {
        const current = credentials.get(provider)
        if (!current || !predicate(current)) return false
        credentials.delete(provider)
        return true
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
 * Vela processes (a terminal and a Lark server) refresh a token once; the file is rewritten atomically.
 */
export function fileCredentialStore(path: string): CredentialStore {
  const serialize = serializer()
  let cache:
    | {
        ino: number
        mtimeMs: number
        size: number
        data: Record<string, Credential>
      }
    | undefined

  const read = (): Record<string, Credential> => {
    if (!existsSync(path)) {
      cache = undefined
      return {}
    }
    const stat = statSync(path)
    if (
      cache &&
      cache.ino === stat.ino &&
      cache.mtimeMs === stat.mtimeMs &&
      cache.size === stat.size
    )
      return cache.data
    const text = readFileSync(path, 'utf-8')
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      throw new Error(formatJsonParseError(path, text, error))
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
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      data: raw as Record<string, Credential>,
    }
    return cache.data
  }

  const write = (data: Record<string, Credential>, assertOwned: () => void) => {
    const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      })
      chmodSync(temp, 0o600)
      assertOwned()
      renameSync(temp, path)
      cache = undefined
    } finally {
      rmSync(temp, { force: true })
    }
  }

  const withFileLock = async <T>(
    task: (assertOwned: () => void) => Promise<T>,
  ): Promise<T> => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const lock = `${path}.lock`
    const token = `${process.pid}:${randomUUID()}`
    const started = Date.now()
    for (;;) {
      try {
        const fd = openSync(lock, 'wx', 0o600)
        try {
          writeSync(fd, token)
        } finally {
          closeSync(fd)
        }
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
    const assertOwned = () => {
      let holder: string | undefined
      try {
        holder = readFileSync(lock, 'utf8')
      } catch {}
      if (holder !== token)
        throw new Error(`Lost ${lock} ownership before committing auth update`)
    }
    const heartbeat = setInterval(
      () => {
        try {
          if (readFileSync(lock, 'utf8') === token) {
            const now = new Date()
            utimesSync(lock, now, now)
          }
        } catch {}
      },
      Math.max(1000, Math.floor(STALE_LOCK_MS / 3)),
    )
    heartbeat.unref?.()
    try {
      return await task(assertOwned)
    } finally {
      clearInterval(heartbeat)
      try {
        if (readFileSync(lock, 'utf8') === token) rmSync(lock, { force: true })
      } catch {}
    }
  }

  return {
    get: (provider) => read()[provider],
    list: () => Object.keys(read()),
    modify: (provider, fn) =>
      serialize(provider, () =>
        withFileLock(async (assertOwned) => {
          // Re-read under the lock: another process may have refreshed or signed in meanwhile
          cache = undefined
          const data = read()
          const next = await fn(data[provider])
          if (next) write({ ...read(), [provider]: next }, assertOwned)
          return read()[provider]
        }),
      ),
    deleteIf: (provider, predicate) =>
      serialize(provider, () =>
        withFileLock(async (assertOwned) => {
          cache = undefined
          const data = read()
          const current = data[provider]
          if (!current || !predicate(current)) return false
          const { [provider]: _, ...rest } = data
          write(rest, assertOwned)
          return true
        }),
      ),
    delete: (provider) =>
      serialize(provider, () =>
        withFileLock(async (assertOwned) => {
          cache = undefined
          const data = read()
          if (!(provider in data)) return
          const { [provider]: _, ...rest } = data
          write(rest, assertOwned)
        }),
      ),
  }
}
