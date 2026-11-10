import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** Rename a private sibling file so failed writes cannot truncate the saved settings. */
export function saveUserSettings(agentDir: string, settings: unknown): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  chmodSync(agentDir, 0o700)
  const temporary = join(
    agentDir,
    `.settings-${randomBytes(12).toString('hex')}.tmp`,
  )
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temporary, join(agentDir, 'settings.json'))
  } finally {
    rmSync(temporary, { force: true })
  }
}
