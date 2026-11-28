import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export interface DesktopPreferences {
  stopDaemonOnQuit: boolean
}

const DEFAULT_PREFERENCES: DesktopPreferences = {
  stopDaemonOnQuit: false,
}

function resolvePreferencesPath(userDataDir?: string): string {
  const override = process.env.VELA_DESKTOP_PREFERENCES_PATH?.trim()
  if (override) return override
  const dir = userDataDir ?? process.env.VELA_DIR ?? process.cwd()
  return join(dir, 'desktop-preferences.json')
}

export function loadPreferences(userDataDir?: string): DesktopPreferences {
  const filePath = resolvePreferencesPath(userDataDir)
  if (!existsSync(filePath)) return { ...DEFAULT_PREFERENCES }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
      stopDaemonOnQuit?: unknown
    }
    return {
      stopDaemonOnQuit: parsed?.stopDaemonOnQuit === true,
    }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

export function savePreferences(
  patch: Partial<DesktopPreferences>,
  userDataDir?: string,
): DesktopPreferences {
  const current = loadPreferences(userDataDir)
  const next: DesktopPreferences = {
    stopDaemonOnQuit:
      typeof patch.stopDaemonOnQuit === 'boolean'
        ? patch.stopDaemonOnQuit
        : current.stopDaemonOnQuit,
  }
  const filePath = resolvePreferencesPath(userDataDir)
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  try {
    writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(tmpPath, filePath)
  } catch (error) {
    rmSync(tmpPath, { force: true })
    throw error
  }
  return next
}
