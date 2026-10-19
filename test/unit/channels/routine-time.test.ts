import { expect, test } from 'bun:test'
import {
  latestOccurrence,
  nextOccurrence,
  routineTimezone,
} from '../../../src/channels/routine-time.ts'

test('the deployment timezone accepts IANA names and rejects offsets and unknown zones', () => {
  expect(routineTimezone('UTC')).toBe('UTC')
  expect(() => routineTimezone('+02:00')).toThrow('IANA')
  expect(() => routineTimezone('Unknown/Zone')).toThrow('timezone')
})

test('local schedules shift a DST gap forward and take the first repeated time', () => {
  expect(
    nextOccurrence(
      { time: '02:30' },
      Date.parse('2026-03-08T05:00:00Z'),
      'America/New_York',
    ),
  ).toBe(Date.parse('2026-03-08T07:30:00Z'))
  const first = Date.parse('2026-11-01T05:30:00Z')
  expect(
    nextOccurrence(
      { time: '01:30' },
      Date.parse('2026-11-01T04:00:00Z'),
      'America/New_York',
    ),
  ).toBe(first)
  expect(nextOccurrence({ time: '01:30' }, first, 'America/New_York')).toBe(
    Date.parse('2026-11-02T06:30:00Z'),
  )
})

test('weekdays use the deployment calendar and catch-up selects only the latest occurrence', () => {
  const schedule = { time: '09:00', days: ['mon', 'fri'] as ('mon' | 'fri')[] }
  expect(
    nextOccurrence(schedule, Date.parse('2026-01-02T09:00:00Z'), 'UTC'),
  ).toBe(Date.parse('2026-01-05T09:00:00Z'))
  expect(
    latestOccurrence(
      schedule,
      Date.parse('2026-01-01T00:00:00Z'),
      Date.parse('2026-01-12T10:00:00Z'),
      'UTC',
    ),
  ).toBe(Date.parse('2026-01-12T09:00:00Z'))
})
