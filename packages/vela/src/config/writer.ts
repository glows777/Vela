import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { isPlainObject } from '../shared/interpolate.ts'

const LEGACY_CONFIG_FILES = [
  'settings.json',
  'models.json',
  'mcp.json',
] as const

/** Read `<agentDir>/config.json` as an uninterpolated raw JSON object (empty object when missing). */
export function readRawConfigFile(agentDir: string): Record<string, unknown> {
  const path = join(agentDir, 'config.json')
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    })
  }
  if (!isPlainObject(parsed))
    throw new Error(`${path} must contain a JSON object`)
  return parsed
}

/** Atomically write `<agentDir>/config.json` with `0700` dir and `0600` file permissions. */
export function writeRawConfigFile(
  agentDir: string,
  data: Record<string, unknown>,
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
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
  return path
}

/** Read, transform, and atomically write `<agentDir>/config.json` with `0600` permissions. */
export function updateConfigFile(
  agentDir: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): string {
  const current = readRawConfigFile(agentDir)
  const next = updater(current)
  return writeRawConfigFile(agentDir, next)
}

/**
 * When `<agentDir>/config.json` does not exist yet, checks whether legacy v0.8 config files
 * (`settings.json`, `models.json`, `mcp.json`) are present.
 */
export function detectLegacyConfigFiles(agentDir: string): string[] {
  if (existsSync(join(agentDir, 'config.json'))) return []
  return LEGACY_CONFIG_FILES.filter((name) => existsSync(join(agentDir, name)))
}
