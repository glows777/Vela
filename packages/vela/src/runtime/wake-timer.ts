import type { VelaDatabase } from '../db/index.ts'
import type { OutboxDispatcher } from './outbox.ts'
import type { TimerScheduler } from './timers.ts'

export function isSessionInChannels(
  db: VelaDatabase,
  sessionId: string,
  channels: ReadonlySet<string>,
): boolean {
  if (channels.size === 0 || !db.open) return false
  const list = [...channels]
  const placeholders = list.map(() => '?').join(', ')
  const direct = db.get<{ ok: number }>(
    `SELECT 1 AS ok FROM channel_bindings
     WHERE session_id = ? AND channel IN (${placeholders})
     LIMIT 1`,
    sessionId,
    ...list,
  )
  if (direct) return true
  const projectBound = db.get<{ ok: number }>(
    `SELECT 1 AS ok
     FROM sessions s
     JOIN channel_bindings cb ON cb.project_id = s.project_id AND cb.thread_id IS NULL
     WHERE s.id = ? AND cb.channel IN (${placeholders})
     LIMIT 1`,
    sessionId,
    ...list,
  )
  return Boolean(projectBound)
}

export function isTimerInChannels(
  db: VelaDatabase,
  timer: {
    channel: string | null
    sessionId: string | null
    projectId?: string | null
  },
  channels: ReadonlySet<string>,
): boolean {
  if (channels.size === 0) return false
  if (timer.channel && channels.has(timer.channel)) return true
  if (timer.sessionId && isSessionInChannels(db, timer.sessionId, channels)) {
    return true
  }
  if (timer.projectId && db.open) {
    const list = [...channels]
    const placeholders = list.map(() => '?').join(', ')
    const projectBound = db.get<{ ok: number }>(
      `SELECT 1 AS ok FROM channel_bindings
       WHERE project_id = ? AND thread_id IS NULL AND channel IN (${placeholders})
       LIMIT 1`,
      timer.projectId,
      ...list,
    )
    if (projectBound) return true
  }
  return false
}

function computeNextWakeDelayMs(
  db: VelaDatabase,
  outboxDue: string | undefined,
  ignoredChannels?: ReadonlySet<string>,
): number | undefined {
  if (!db.open) return undefined
  const timerRows = db.all<{
    channel: string | null
    session_id: string | null
    project_id: string | null
    next_fire_at: string
  }>(
    `SELECT channel, session_id, project_id, next_fire_at FROM timers
     WHERE enabled = 1 AND next_fire_at IS NOT NULL
     ORDER BY next_fire_at ASC`,
  )
  let timerDue: string | undefined
  for (const row of timerRows) {
    if (
      ignoredChannels?.size &&
      isTimerInChannels(
        db,
        {
          channel: row.channel,
          sessionId: row.session_id,
          projectId: row.project_id,
        },
        ignoredChannels,
      )
    ) {
      continue
    }
    timerDue = row.next_fire_at
    break
  }
  let earliestMs = Number.POSITIVE_INFINITY
  for (const candidate of [timerDue, outboxDue]) {
    if (!candidate) continue
    const ms = Date.parse(candidate)
    if (Number.isFinite(ms) && ms < earliestMs) earliestMs = ms
  }
  if (!Number.isFinite(earliestMs)) return undefined
  return Math.max(0, Math.min(earliestMs - Date.now(), 2_147_483_647))
}

export function scheduleRuntimeWakeTimer(input: {
  db: VelaDatabase
  timers: TimerScheduler
  outbox: OutboxDispatcher
  registeredChannels: readonly string[]
  ignoredChannels: ReadonlySet<string>
  hasChannels: boolean
  onFire: () => boolean
  onSync: () => void
  onFlushError: (error: unknown) => void
}): ReturnType<typeof setTimeout> | undefined {
  const delayMs = computeNextWakeDelayMs(
    input.db,
    input.outbox.nextPendingWakeAt(input.registeredChannels) ?? undefined,
    input.ignoredChannels,
  )
  if (delayMs === undefined) return undefined
  const timer = setTimeout(() => {
    if (!input.onFire()) return
    const now = Date.now()
    input.timers.tick(now, (t) =>
      isTimerInChannels(input.db, t, input.ignoredChannels),
    )
    if (input.hasChannels) {
      void input.outbox
        .flushOnce(now)
        .catch(input.onFlushError)
        .finally(input.onSync)
    } else {
      input.onSync()
    }
  }, delayMs)
  timer.unref?.()
  return timer
}
