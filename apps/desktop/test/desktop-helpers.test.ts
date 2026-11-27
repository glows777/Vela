import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPreferences, savePreferences } from '../src/main/preferences.ts'
import {
  localRoutineInstant,
  nextOccurrence,
  routineLocalTime,
  routineTimezone,
} from '../src/main/routine-time.ts'

const dirs: string[] = []
afterEach(() => {
  delete process.env.VELA_DESKTOP_PREFERENCES_PATH
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('preferences default stopDaemonOnQuit to false, persist edits, and ignore corrupt JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vela-prefs-'))
  dirs.push(dir)
  expect(loadPreferences(dir)).toEqual({ stopDaemonOnQuit: false })

  const saved = savePreferences({ stopDaemonOnQuit: true }, dir)
  expect(saved).toEqual({ stopDaemonOnQuit: true })
  expect(loadPreferences(dir)).toEqual({ stopDaemonOnQuit: true })

  writeFileSync(join(dir, 'desktop-preferences.json'), '{not-json')
  expect(loadPreferences(dir)).toEqual({ stopDaemonOnQuit: false })
})

test('routine-time resolves IANA timezones, wall clock instants, and next occurrence', () => {
  expect(routineTimezone('UTC')).toBe('UTC')
  expect(() => routineTimezone('+08:00')).toThrow()

  const utc = localRoutineInstant('2026-11-28T09:30', 'Asia/Shanghai')
  expect(utc).toBe('2026-11-28T01:30:00.000Z')
  expect(routineLocalTime(Date.parse(utc), 'Asia/Shanghai')).toBe(
    '2026-11-28 09:30',
  )

  const after = Date.parse('2026-11-28T00:00:00.000Z')
  const next = nextOccurrence({ time: '09:30' }, after, 'Asia/Shanghai')
  expect(next).toBe(Date.parse('2026-11-28T01:30:00.000Z'))
})
