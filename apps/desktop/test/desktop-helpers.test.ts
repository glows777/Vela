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
import {
  initialSnapshot,
  submitLocalFlow,
} from '../src/renderer/store-state.ts'

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

test('submitLocalFlow rejects disconnected preflight errors and preserves mid-flight transport uncertainty', async () => {
  let snapshot = {
    ...initialSnapshot,
    messages: {} as typeof initialSnapshot.messages,
  }
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch }
  }
  const mergeMessages = (
    sid: string,
    incoming: (typeof initialSnapshot.messages)[string],
  ) => {
    snapshot = {
      ...snapshot,
      messages: {
        ...snapshot.messages,
        [sid]: [...(snapshot.messages[sid] ?? []), ...incoming],
      },
    }
  }

  let preflightUnknown = false
  let preflightError = ''
  const preflightOutcome = await submitLocalFlow({
    projectId: null,
    sessionId: 's-preflight',
    text: 'draft stays',
    getSnapshot: () => snapshot,
    publish,
    mergeMessages,
    onUnknown: () => {
      preflightUnknown = true
    },
    submit: async () => {
      throw new Error(
        'Background service disconnected and is reconnecting. Please try again.',
      )
    },
    report: (err) => {
      preflightError = err
    },
    formatError: (e) => (e instanceof Error ? e.message : String(e)),
  })
  expect(preflightOutcome).toBe('rejected')
  expect(preflightUnknown).toBe(false)
  expect(preflightError).toContain('reconnecting')
  expect(snapshot.messages['s-preflight']).toEqual([])

  let midflightUnknown = false
  const midflightOutcome = await submitLocalFlow({
    projectId: null,
    sessionId: 's-midflight',
    text: 'may have landed',
    getSnapshot: () => snapshot,
    publish,
    mergeMessages,
    onUnknown: () => {
      midflightUnknown = true
    },
    submit: async () => {
      throw new Error('Disconnected from Vela daemon')
    },
    report: () => {},
    formatError: (e) => (e instanceof Error ? e.message : String(e)),
  })
  expect(midflightOutcome).toBe('unknown')
  expect(midflightUnknown).toBe(true)
  expect(snapshot.messages['s-midflight']).toHaveLength(1)
  expect(snapshot.messages['s-midflight']?.[0]?.text).toBe('may have landed')
})
