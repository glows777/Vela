import type { RoutineSchedule } from './types.ts'

const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const formatters = new Map<string, Intl.DateTimeFormat>()

export function routineTimezone(value?: unknown): string {
  if (
    value !== undefined &&
    (typeof value !== 'string' || !value.trim() || /^[+-]/.test(value))
  )
    throw new Error('Routine timezone must be an IANA timezone name')
  const zone =
    value === undefined
      ? new Intl.DateTimeFormat().resolvedOptions().timeZone
      : (value as string)
  try {
    formatter(zone)
  } catch (cause) {
    throw new Error(`Invalid routine timezone ${zone}`, { cause })
  }
  return zone
}

function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatters.get(zone)
  if (!value) {
    value = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(zone, value)
  }
  return value
}

function localWall(at: number, zone: string): number {
  const parts = Object.fromEntries(
    formatter(zone)
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  )
  return Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  )
}

function localDay(at: number, zone: string): number {
  const day = new Date(localWall(at, zone))
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())
}

/** Resolve a local wall clock using offsets on both sides of a transition. */
function occurrence(day: number, time: string, zone: string): number {
  const [hour, minute] = time.split(':').map(Number)
  const wall = day + hour! * 3_600_000 + minute! * 60_000
  const offsets = new Set<number>()
  for (let hours = -36; hours <= 36; hours += 12) {
    const at = wall + hours * 3_600_000
    offsets.add(localWall(at, zone) - at)
  }
  const candidates = [...offsets].map((offset) => wall - offset)
  const exact = candidates.filter((at) => localWall(at, zone) === wall)
  // A fold chooses the first instant. A gap advances by the offset gap, retaining minutes.
  if (exact.length) return Math.min(...exact)
  return candidates
    .filter((at) => localWall(at, zone) > wall)
    .sort((a, b) => localWall(a, zone) - localWall(b, zone) || a - b)[0]!
}

function matches(
  day: number,
  schedule: Extract<RoutineSchedule, { time: string }>,
): boolean {
  return (
    !schedule.days ||
    schedule.days.includes(
      weekdays[new Date(day).getUTCDay()] as NonNullable<
        typeof schedule.days
      >[number],
    )
  )
}

export function nextOccurrence(
  schedule: RoutineSchedule,
  after: number,
  zone: string,
): number | undefined {
  if ('at' in schedule) {
    const at = Date.parse(schedule.at)
    return at > after ? at : undefined
  }
  const start = localDay(after, zone)
  for (let i = 0; i <= 8; i++) {
    const day = start + i * 86_400_000
    if (!matches(day, schedule)) continue
    const at = occurrence(day, schedule.time, zone)
    if (at > after) return at
  }
}

export function latestOccurrence(
  schedule: RoutineSchedule,
  after: number,
  through: number,
  zone: string,
): number | undefined {
  if ('at' in schedule) {
    const at = Date.parse(schedule.at)
    return at > after && at <= through ? at : undefined
  }
  const start = localDay(through, zone)
  for (let i = 0; i <= 8; i++) {
    const day = start - i * 86_400_000
    if (!matches(day, schedule)) continue
    const at = occurrence(day, schedule.time, zone)
    if (at > after && at <= through) return at
  }
}
