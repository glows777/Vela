import { randomUUID } from 'node:crypto'
import type { VelaDatabase } from '../db/index.ts'
import {
  latestOccurrence,
  nextOccurrence,
  type RoutineSchedule,
  routineTimezone,
} from '../shared/routine-time.ts'
import { enqueueInboxEvent } from './inbox.ts'

export const MAX_ROUTINES_PER_PROJECT = 20
export const MAX_FOLLOWUP_STREAK = 3

export type TimerKind = 'routine' | 'followup'

export interface TimerTarget {
  channel: string
  externalChatId: string
  threadId?: string
}

export interface TimerRecord {
  id: string
  kind: TimerKind
  projectId: string | null
  sessionId: string | null
  channel: string | null
  creatorId: string | null
  creatorName: string | null
  message: string
  schedule: RoutineSchedule
  timezone: string
  enabled: boolean
  nextFireAt: string | null
  lastFiredAt: string | null
  scheduleUpdatedAt: string | null
  createdAt: string
  updatedAt: string
}

interface TimerRow {
  id: string
  kind: string
  project_id: string | null
  session_id: string | null
  channel: string | null
  creator_id: string | null
  creator_name: string | null
  message: string
  schedule_json: string
  timezone: string | null
  enabled: number
  next_fire_at: string | null
  last_fired_at: string | null
  schedule_updated_at: string | null
  created_at: string
  updated_at: string
}

function rowToTimer(row: TimerRow): TimerRecord {
  return {
    id: row.id,
    kind: row.kind as TimerKind,
    projectId: row.project_id,
    sessionId: row.session_id,
    channel: row.channel,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    message: row.message,
    schedule: JSON.parse(row.schedule_json) as RoutineSchedule,
    timezone: row.timezone ?? routineTimezone(),
    enabled: row.enabled === 1,
    nextFireAt: row.next_fire_at,
    lastFiredAt: row.last_fired_at,
    scheduleUpdatedAt: row.schedule_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function validateSchedule(schedule: RoutineSchedule): void {
  if ('at' in schedule) {
    if (!Number.isFinite(Date.parse(schedule.at))) {
      throw new Error(`Invalid one-shot timer timestamp "${schedule.at}"`)
    }
    return
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
    throw new Error(`Invalid routine time "${schedule.time}"; expected HH:MM`)
  }
  if (schedule.days !== undefined && schedule.days.length === 0) {
    throw new Error('Routine days array must not be empty')
  }
}

/**
 * Durable scheduler for `timers` (`routine` schedules + model `followup` self-wakes).
 * Due timers only enqueue `inbox_events` (single-catchup on downtime for routines,
 * and a hard 3-streak self-wake guardrail for followups).
 */
export class TimerScheduler {
  constructor(
    private readonly db: VelaDatabase,
    private readonly onWakeSession?: (sessionId: string) => void,
    private readonly onScheduleChanged?: () => void,
  ) {}

  createRoutine(input: {
    id?: string
    projectId?: string | null
    sessionId?: string | null
    channel?: string | null
    target?: TimerTarget
    creatorId?: string | null
    creatorName?: string | null
    message: string
    schedule: RoutineSchedule
    timezone?: string
    nowMs?: number
  }): TimerRecord {
    validateSchedule(input.schedule)
    const zone = routineTimezone(input.timezone)
    const nowMs = input.nowMs ?? Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const nextMs = nextOccurrence(input.schedule, nowMs, zone)
    if (nextMs === undefined) {
      throw new Error('Routine schedule has no future occurrence')
    }

    const id = input.id ?? randomUUID()
    const created = this.db.transaction(() => {
      let resolvedProjectId = input.projectId ?? null
      if (input.sessionId) {
        const session = this.db.get<{ project_id: string | null }>(
          'SELECT project_id FROM sessions WHERE id = ?',
          input.sessionId,
        )
        if (!session) throw new Error(`Session ${input.sessionId} not found`)
        if (
          input.projectId &&
          session.project_id &&
          input.projectId !== session.project_id
        ) {
          throw new Error(
            `Session ${input.sessionId} belongs to project ${session.project_id}, not ${input.projectId}`,
          )
        }
        resolvedProjectId ??= session.project_id
      }
      if (resolvedProjectId) {
        const count =
          this.db.get<{ n: number }>(
            `SELECT count(*) AS n FROM timers WHERE project_id = ? AND kind = 'routine' AND enabled = 1`,
            resolvedProjectId,
          )?.n ?? 0
        if (count >= MAX_ROUTINES_PER_PROJECT) {
          throw new Error(
            `Project ${resolvedProjectId} already has the maximum of ${MAX_ROUTINES_PER_PROJECT} routines`,
          )
        }
      } else if (input.sessionId) {
        const count =
          this.db.get<{ n: number }>(
            `SELECT count(*) AS n FROM timers WHERE session_id = ? AND project_id IS NULL AND kind = 'routine' AND enabled = 1`,
            input.sessionId,
          )?.n ?? 0
        if (count >= MAX_ROUTINES_PER_PROJECT) {
          throw new Error(
            `Session ${input.sessionId} already has the maximum of ${MAX_ROUTINES_PER_PROJECT} routines`,
          )
        }
      }
      this.db.run(
        `INSERT INTO timers (
           id, kind, project_id, session_id, channel, creator_id, creator_name,
           message, schedule_json, timezone, enabled, next_fire_at,
           schedule_updated_at, created_at, updated_at
         ) VALUES (?, 'routine', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        id,
        resolvedProjectId,
        input.sessionId ?? null,
        input.target?.channel ?? input.channel ?? null,
        input.creatorId ?? null,
        input.creatorName ?? null,
        input.message,
        JSON.stringify(input.schedule),
        zone,
        new Date(nextMs).toISOString(),
        nowIso,
        nowIso,
        nowIso,
      )
      if (input.target) {
        this.db.run(
          'INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
          `timer_target:${id}`,
          JSON.stringify(input.target),
          nowIso,
        )
      }
      return this.get(id)!
    })
    this.onScheduleChanged?.()
    return created
  }

  createFollowup(input: {
    id?: string
    sessionId: string
    projectId?: string | null
    channel?: string | null
    target?: TimerTarget
    message: string
    fireAt: string
    creatorId?: string | null
    creatorName?: string | null
  }): TimerRecord {
    const fireMs = Date.parse(input.fireAt)
    if (!Number.isFinite(fireMs)) {
      throw new Error(`Invalid followup fireAt timestamp "${input.fireAt}"`)
    }
    const id = input.id ?? randomUUID()
    const nowIso = new Date().toISOString()
    const zone = routineTimezone()

    const created = this.db.transaction(() => {
      const session = this.db.get<{
        project_id: string | null
        followup_streak: number
      }>(
        'SELECT project_id, followup_streak FROM sessions WHERE id = ?',
        input.sessionId,
      )
      if (!session) throw new Error(`Session ${input.sessionId} not found`)
      if (session.followup_streak >= MAX_FOLLOWUP_STREAK) {
        throw new Error(
          `Followup guardrail reached: session ${input.sessionId} already ran ${MAX_FOLLOWUP_STREAK} consecutive self-wakes without new human input`,
        )
      }
      this.db.run(
        `INSERT INTO timers (
           id, kind, project_id, session_id, channel, creator_id, creator_name,
           message, schedule_json, timezone, enabled, next_fire_at,
           schedule_updated_at, created_at, updated_at
         ) VALUES (?, 'followup', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        id,
        input.projectId ?? session.project_id ?? null,
        input.sessionId,
        input.target?.channel ?? input.channel ?? null,
        input.creatorId ?? null,
        input.creatorName ?? null,
        input.message,
        JSON.stringify({ at: new Date(fireMs).toISOString() }),
        zone,
        new Date(fireMs).toISOString(),
        nowIso,
        nowIso,
        nowIso,
      )
      if (input.target) {
        this.db.run(
          'INSERT INTO kv_meta (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
          `timer_target:${id}`,
          JSON.stringify(input.target),
          nowIso,
        )
      }
      return this.get(id)!
    })
    this.onScheduleChanged?.()
    return created
  }

  get(id: string): TimerRecord | undefined {
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM timers WHERE id = ?',
      id,
    ) as TimerRow | undefined
    return row ? rowToTimer(row) : undefined
  }

  list(
    filter: {
      projectId?: string
      sessionId?: string
      kind?: TimerKind
      enabledOnly?: boolean
    } = {},
  ): TimerRecord[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (filter.projectId !== undefined) {
      where.push('project_id = ?')
      params.push(filter.projectId)
    }
    if (filter.sessionId !== undefined) {
      where.push('session_id = ?')
      params.push(filter.sessionId)
    }
    if (filter.kind !== undefined) {
      where.push('kind = ?')
      params.push(filter.kind)
    }
    if (filter.enabledOnly) {
      where.push('enabled = 1')
    }
    const sql = `SELECT * FROM timers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC`
    const rows = this.db.all<Record<string, unknown>>(
      sql,
      ...params,
    ) as unknown as TimerRow[]
    return rows.map(rowToTimer)
  }

  update(
    id: string,
    patch: {
      message?: string
      schedule?: RoutineSchedule
      timezone?: string
      enabled?: boolean
      nowMs?: number
    },
  ): TimerRecord | undefined {
    const existing = this.get(id)
    if (!existing) return undefined
    const schedule = patch.schedule ?? existing.schedule
    validateSchedule(schedule)
    const zone = patch.timezone
      ? routineTimezone(patch.timezone)
      : existing.timezone
    const nowMs = patch.nowMs ?? Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const enabled = patch.enabled ?? existing.enabled
    const scheduleChanged =
      patch.schedule !== undefined || patch.timezone !== undefined
    const preserveExistingDeadline =
      !scheduleChanged &&
      existing.enabled &&
      enabled &&
      existing.nextFireAt !== null
    let nextFireAt: string | null = null
    if (enabled) {
      if (preserveExistingDeadline) {
        nextFireAt = existing.nextFireAt
      } else {
        const ms = nextOccurrence(schedule, nowMs, zone)
        if (ms === undefined) {
          throw new Error('Timer schedule has no future occurrence')
        }
        nextFireAt = new Date(ms).toISOString()
      }
    }
    this.db.run(
      `UPDATE timers
       SET message = ?, schedule_json = ?, timezone = ?, enabled = ?,
           next_fire_at = ?, schedule_updated_at = ?, updated_at = ?
       WHERE id = ?`,
      patch.message ?? existing.message,
      JSON.stringify(schedule),
      zone,
      enabled ? 1 : 0,
      nextFireAt,
      scheduleChanged ? nowIso : existing.scheduleUpdatedAt,
      nowIso,
      id,
    )
    this.onScheduleChanged?.()
    return this.get(id)
  }

  delete(id: string): boolean {
    const res = this.db.transaction(() => {
      const deleted = this.db.run('DELETE FROM timers WHERE id = ?', id)
      this.db.run('DELETE FROM kv_meta WHERE key = ?', `timer_target:${id}`)
      return deleted
    })
    if (res.changes > 0) this.onScheduleChanged?.()
    return res.changes > 0
  }

  cancelFollowupsForSession(sessionId: string): number {
    const now = new Date().toISOString()
    const cancelled = this.db.transaction(() => {
      const rows = this.db.all<{ id: string }>(
        `SELECT id FROM timers WHERE session_id = ? AND kind = 'followup' AND enabled = 1`,
        sessionId,
      )
      if (rows.length === 0) return 0
      const res = this.db.run(
        `UPDATE timers
         SET enabled = 0, next_fire_at = NULL, updated_at = ?
         WHERE session_id = ? AND kind = 'followup' AND enabled = 1`,
        now,
        sessionId,
      )
      for (const r of rows) {
        this.db.run('DELETE FROM kv_meta WHERE key = ?', `timer_target:${r.id}`)
      }
      return res.changes
    })
    if (cancelled > 0) this.onScheduleChanged?.()
    return cancelled
  }

  private readTimerTarget(id: string): TimerTarget | undefined {
    const row = this.db.get<{ value_json: string }>(
      'SELECT value_json FROM kv_meta WHERE key = ?',
      `timer_target:${id}`,
    )
    if (!row) return undefined
    try {
      const parsed = JSON.parse(row.value_json) as Partial<TimerTarget>
      if (
        typeof parsed.channel === 'string' &&
        typeof parsed.externalChatId === 'string'
      ) {
        return {
          channel: parsed.channel,
          externalChatId: parsed.externalChatId,
          ...(typeof parsed.threadId === 'string'
            ? { threadId: parsed.threadId }
            : {}),
        }
      }
    } catch {
      /* ignore malformed timer target */
    }
    return undefined
  }

  tick(nowMs = Date.now()): { fired: string[]; guardrailBlocked: string[] } {
    const nowIso = new Date(nowMs).toISOString()
    const fired: string[] = []
    const guardrailBlocked: string[] = []
    const wakeSessions = new Set<string>()

    this.db.transaction(() => {
      const dueRows = this.db.all<Record<string, unknown>>(
        `SELECT * FROM timers
         WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?
         ORDER BY next_fire_at ASC`,
        nowIso,
      ) as unknown as TimerRow[]

      for (const raw of dueRows) {
        const timer = rowToTimer(raw)
        const targetSessionId = this.resolveTargetSessionId(timer)
        if (!targetSessionId) {
          if (timer.kind === 'followup') {
            this.db.run(
              `UPDATE timers SET enabled = 0, next_fire_at = NULL, updated_at = ? WHERE id = ?`,
              nowIso,
              timer.id,
            )
          } else {
            const nextMs = nextOccurrence(timer.schedule, nowMs, timer.timezone)
            this.db.run(
              `UPDATE timers SET next_fire_at = ?, enabled = ?, updated_at = ? WHERE id = ?`,
              nextMs === undefined ? null : new Date(nextMs).toISOString(),
              nextMs === undefined ? 0 : 1,
              nowIso,
              timer.id,
            )
          }
          continue
        }

        if (timer.kind === 'followup') {
          const session = this.db.get<{ followup_streak: number }>(
            'SELECT followup_streak FROM sessions WHERE id = ?',
            targetSessionId,
          )
          if (!session || session.followup_streak >= MAX_FOLLOWUP_STREAK) {
            this.db.run(
              `UPDATE timers SET enabled = 0, next_fire_at = NULL, updated_at = ? WHERE id = ?`,
              nowIso,
              timer.id,
            )
            guardrailBlocked.push(timer.id)
            continue
          }
          this.db.run(
            `UPDATE sessions SET followup_streak = followup_streak + 1, updated_at = ? WHERE id = ?`,
            nowIso,
            targetSessionId,
          )
          this.db.run(
            `UPDATE timers SET enabled = 0, last_fired_at = ?, next_fire_at = NULL, updated_at = ? WHERE id = ?`,
            nowIso,
            nowIso,
            timer.id,
          )
          const target = this.readTimerTarget(timer.id)
          this.db.run(
            'DELETE FROM kv_meta WHERE key = ?',
            `timer_target:${timer.id}`,
          )
          enqueueInboxEvent(this.db, {
            sessionId: targetSessionId,
            projectId: timer.projectId,
            source: 'timer',
            dedupeKey: `followup:${timer.id}:${nowIso}`,
            wake: true,
            payload: {
              type: 'timer',
              kind: 'followup',
              timerId: timer.id,
              scheduledAt: timer.nextFireAt,
              firedAt: nowIso,
              message: timer.message,
              followupStreak: session.followup_streak + 1,
              ...(target
                ? {
                    channel: target.channel,
                    externalChatId: target.externalChatId,
                    ...(target.threadId ? { threadId: target.threadId } : {}),
                  }
                : {}),
            },
          })
          fired.push(timer.id)
          wakeSessions.add(targetSessionId)
          continue
        }

        // Routine: catch up at most once across downtime using latestOccurrence.
        const afterAnchor = Math.max(
          Date.parse(timer.lastFiredAt ?? timer.createdAt),
          timer.scheduleUpdatedAt
            ? Date.parse(timer.scheduleUpdatedAt)
            : Number.NEGATIVE_INFINITY,
        )
        const fireMs =
          latestOccurrence(
            timer.schedule,
            afterAnchor,
            nowMs,
            timer.timezone,
          ) ?? Date.parse(timer.nextFireAt!)
        const fireIso = new Date(fireMs).toISOString()
        const nextMs = nextOccurrence(timer.schedule, nowMs, timer.timezone)

        this.db.run(
          `UPDATE timers
           SET last_fired_at = ?,
               next_fire_at = ?,
               enabled = ?,
               updated_at = ?
           WHERE id = ?`,
          fireIso,
          nextMs === undefined ? null : new Date(nextMs).toISOString(),
          nextMs === undefined ? 0 : 1,
          nowIso,
          timer.id,
        )
        const target = this.readTimerTarget(timer.id)
        if (nextMs === undefined) {
          this.db.run(
            'DELETE FROM kv_meta WHERE key = ?',
            `timer_target:${timer.id}`,
          )
        }
        enqueueInboxEvent(this.db, {
          sessionId: targetSessionId,
          projectId: timer.projectId,
          source: 'timer',
          dedupeKey: `timer:${timer.id}:${fireIso}`,
          wake: true,
          payload: {
            type: 'timer',
            kind: 'routine',
            timerId: timer.id,
            scheduledAt: fireIso,
            firedAt: nowIso,
            message: timer.message,
            creatorId: timer.creatorId,
            creatorName: timer.creatorName,
            ...(target
              ? {
                  channel: target.channel,
                  externalChatId: target.externalChatId,
                  ...(target.threadId ? { threadId: target.threadId } : {}),
                }
              : {}),
          },
        })
        fired.push(timer.id)
        wakeSessions.add(targetSessionId)
      }
    })

    for (const sessionId of wakeSessions) {
      this.onWakeSession?.(sessionId)
    }
    this.onScheduleChanged?.()
    return { fired, guardrailBlocked }
  }

  private resolveTargetSessionId(timer: TimerRecord): string | undefined {
    if (timer.sessionId) return timer.sessionId
    if (!timer.projectId) return undefined
    const project = this.db.get<{
      hub_session_id: string | null
      cwd: string | null
      default_driver: string
      default_location_json: string | null
      default_model: string | null
      default_thinking_level: string | null
    }>(
      `SELECT hub_session_id, cwd, default_driver, default_location_json, default_model, default_thinking_level
       FROM projects WHERE id = ?`,
      timer.projectId,
    )
    if (!project) return undefined
    if (project.hub_session_id) return project.hub_session_id
    const latest = this.db.get<{ id: string }>(
      'SELECT id FROM sessions WHERE project_id = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 1',
      timer.projectId,
    )
    if (latest) return latest.id
    if (timer.kind !== 'routine') return undefined
    const sessionId = randomUUID()
    const now = new Date().toISOString()
    const locationJson =
      project.default_location_json ??
      (project.cwd
        ? JSON.stringify({ environment: 'local', cwd: project.cwd })
        : null)
    this.db.run(
      `INSERT INTO sessions (
         id, project_id, kind, driver, model, thinking_level, location_json,
         state, created_at, updated_at
       ) VALUES (?, ?, 'work', ?, ?, ?, ?, 'idle', ?, ?)`,
      sessionId,
      timer.projectId,
      project.default_driver,
      project.default_model,
      project.default_thinking_level,
      locationJson,
      now,
      now,
    )
    return sessionId
  }
}
