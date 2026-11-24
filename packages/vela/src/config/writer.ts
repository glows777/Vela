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
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { isPlainObject } from '../shared/interpolate.ts'
import { formatJsonParseError } from './schema.ts'

export const LEGACY_CONFIG_FILES = [
  'settings.json',
  'models.json',
  'mcp.json',
] as const

const CONFIG_LOCK_TIMEOUT_MS = 10_000
const CONFIG_STALE_LOCK_MS = 30_000
const CONFIG_LOCK_RETRY_MS = 15
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

/**
 * Throws if `<dir>` contains legacy v0.8 config files (`settings.json`, `models.json`, `mcp.json`)
 * without `config.json`.
 */
export function assertNoLegacyConfigFiles(dir: string): void {
  const legacy = detectLegacyConfigFiles(dir)
  if (legacy.length > 0) {
    throw new Error(
      `${dir}: found legacy config file(s) (${legacy.join(', ')}) without config.json; v0.9 uses unified config.json`,
    )
  }
}

function withConfigLockSync<T>(
  agentDir: string,
  fn: (assertOwned: () => void) => T,
): T {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  chmodSync(agentDir, 0o700)
  const lock = join(agentDir, 'config.json.lock')
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
        if (Date.now() - statSync(lock).mtimeMs > CONFIG_STALE_LOCK_MS)
          rmSync(lock, { force: true })
      } catch {}
      if (Date.now() - started > CONFIG_LOCK_TIMEOUT_MS)
        throw new Error(
          `Timed out waiting for ${lock}; if no other Vela is modifying config.json, delete it`,
        )
      Atomics.wait(sleepBuffer, 0, 0, CONFIG_LOCK_RETRY_MS)
    }
  }
  const assertOwned = () => {
    let holder: string | undefined
    try {
      holder = readFileSync(lock, 'utf8')
    } catch {}
    if (holder !== token)
      throw new Error(
        `Lost ${lock} ownership before committing config.json update`,
      )
  }
  try {
    return fn(assertOwned)
  } finally {
    try {
      if (readFileSync(lock, 'utf8') === token) rmSync(lock, { force: true })
    } catch {}
  }
}

function readRawConfigUnlocked(agentDir: string): Record<string, unknown> {
  assertNoLegacyConfigFiles(agentDir)
  const path = join(agentDir, 'config.json')
  if (!existsSync(path)) return {}
  const text = readFileSync(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(formatJsonParseError(path, text, error))
  }
  if (!isPlainObject(parsed))
    throw new Error(`${path} must contain a JSON object`)
  return parsed
}

function writeRawConfigUnlocked(
  agentDir: string,
  data: Record<string, unknown>,
  assertOwned: () => void,
): string {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  chmodSync(agentDir, 0o700)
  const path = join(agentDir, 'config.json')
  const temporary = join(
    agentDir,
    `.config-${randomBytes(12).toString('hex')}.tmp`,
  )
  try {
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    chmodSync(temporary, 0o600)
    assertOwned()
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
  return path
}

/** Read `<agentDir>/config.json` as an uninterpolated raw JSON object (empty object when missing). */
export function readRawConfigFile(agentDir: string): Record<string, unknown> {
  return readRawConfigUnlocked(agentDir)
}

/** Atomically write `<agentDir>/config.json` with `0700` dir and `0600` file permissions. */
export function writeRawConfigFile(
  agentDir: string,
  data: Record<string, unknown>,
): string {
  assertNoLegacyConfigFiles(agentDir)
  return withConfigLockSync(agentDir, (assertOwned) =>
    writeRawConfigUnlocked(agentDir, data, assertOwned),
  )
}

/** Read, transform, and atomically write `<agentDir>/config.json` under cross-process lock with `0600` permissions. */
export function updateConfigFile(
  agentDir: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): string {
  assertNoLegacyConfigFiles(agentDir)
  return withConfigLockSync(agentDir, (assertOwned) => {
    const current = readRawConfigUnlocked(agentDir)
    const next = updater(current)
    return writeRawConfigUnlocked(agentDir, next, assertOwned)
  })
}

/**
 * When `<agentDir>/config.json` does not exist yet, checks whether legacy v0.8 config files
 * (`settings.json`, `models.json`, `mcp.json`) are present.
 */
function detectLegacyConfigFiles(agentDir: string): string[] {
  if (existsSync(join(agentDir, 'config.json'))) return []
  return LEGACY_CONFIG_FILES.filter((name) => existsSync(join(agentDir, name)))
}
