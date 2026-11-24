import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isPlainObject } from '../shared/interpolate.ts'
import {
  latestOccurrence,
  nextOccurrence,
  type RoutineSchedule,
  routineTimezone,
} from '../shared/routine-time.ts'
import {
  legacyChannelSessionId,
  type MigrationOps,
  readJsonStrict,
} from './migrate-legacy-sources.ts'

const VALID_WEEKDAYS = new Set([
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
])

function isValidRoutineSchedule(value: unknown): value is RoutineSchedule {
  if (!isPlainObject(value)) return false
  if ('at' in value) {
    return typeof value.at === 'string' && Number.isFinite(Date.parse(value.at))
  }
  if (
    typeof value.time !== 'string' ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)
  ) {
    return false
  }
  if (value.days !== undefined) {
    if (
      !Array.isArray(value.days) ||
      value.days.some(
        (day) => typeof day !== 'string' || !VALID_WEEKDAYS.has(day),
      )
    ) {
      return false
    }
  }
  return true
}

function resolveChannelTarget(
  ops: MigrationOps,
  dataDir: string,
  channel: string,
  chatId: string,
  explicitTargetKey: unknown,
):
  | {
      resolved: { sessionId: string; projectId: string | null }
      missingExplicit: false
    }
  | { resolved: undefined; missingExplicit: boolean } {
  if (typeof explicitTargetKey === 'string') {
    const hit = ops.channelSessionByKey.get(`${dataDir}\0${explicitTargetKey}`)
    if (hit && hit.channel === channel && hit.chatId === chatId) {
      return {
        resolved: { sessionId: hit.sessionId, projectId: hit.projectId },
        missingExplicit: false,
      }
    }
    return { resolved: undefined, missingExplicit: true }
  }
  const hit = ops.channelSessionByKey.get(
    `${dataDir}\0${legacyChannelSessionId(channel, chatId)}`,
  )
  if (hit && hit.channel === channel && hit.chatId === chatId) {
    return {
      resolved: { sessionId: hit.sessionId, projectId: hit.projectId },
      missingExplicit: false,
    }
  }
  return { resolved: undefined, missingExplicit: false }
}

export function migrateRoutinesAndSubscriptions(
  ops: MigrationOps,
  dataDirs: readonly string[],
): void {
  const nowParsed = Date.parse(ops.now)
  const nowMs = Number.isFinite(nowParsed) ? nowParsed : Date.now()

  for (const dataDir of dataDirs) {
    const routinesFile = join(dataDir, 'channels', 'routines.json')
    if (existsSync(routinesFile)) {
      const parsed = readJsonStrict(routinesFile)
      if (!isPlainObject(parsed) || !Array.isArray(parsed.routines)) {
        throw new Error(`Invalid channel routines ${routinesFile}`)
      }
      for (const r of parsed.routines) {
        if (
          !isPlainObject(r) ||
          typeof r.id !== 'string' ||
          typeof r.channel !== 'string' ||
          typeof r.chatId !== 'string' ||
          typeof r.message !== 'string'
        ) {
          continue
        }
        if (!isValidRoutineSchedule(r.schedule)) {
          ops.warnings.push(
            `Skipped routine "${r.id}" with invalid schedule in ${routinesFile}`,
          )
          continue
        }
        if (ops.unresolvedTimezoneChannels.has(r.channel)) {
          continue
        }
        const { resolved, missingExplicit } = resolveChannelTarget(
          ops,
          dataDir,
          r.channel,
          r.chatId,
          r.targetKey,
        )
        if (missingExplicit) {
          ops.warnings.push(
            `Imported routine "${r.id}" disabled because target "${String(r.targetKey)}" is unavailable`,
          )
        }
        const projectId =
          resolved?.projectId ??
          ops.projectByChat.get(`${r.channel}\0${r.chatId}`) ??
          (ops.localProjectIds.has(r.chatId) ? r.chatId : null)
        const creator = isPlainObject(r.creator) ? r.creator : undefined
        const createdAt =
          typeof r.createdAt === 'string' ? r.createdAt : ops.now
        const timezone =
          ops.channelTimezones.get(r.channel) ?? routineTimezone()
        const createdMs = Date.parse(createdAt)
        const lastFiredMs =
          typeof r.lastFiredAt === 'string'
            ? Date.parse(r.lastFiredAt)
            : Number.NaN
        const editedMs =
          typeof r.scheduleUpdatedAt === 'string'
            ? Date.parse(r.scheduleUpdatedAt)
            : Number.NaN
        const baseCreatedMs = Number.isFinite(createdMs) ? createdMs : 0
        const floorMs = Math.max(
          Number.isFinite(lastFiredMs) ? lastFiredMs : baseCreatedMs,
          Number.isFinite(editedMs) ? editedMs : baseCreatedMs,
        )
        const schedule = r.schedule
        const catchUpMs = latestOccurrence(schedule, floorMs, nowMs, timezone)
        const nextMs =
          catchUpMs !== undefined
            ? catchUpMs
            : nextOccurrence(schedule, Math.max(nowMs, floorMs), timezone)
        const nextFireAt =
          nextMs !== undefined ? new Date(nextMs).toISOString() : null
        const hasTarget =
          projectId !== null || resolved?.sessionId !== undefined
        const enabled =
          !missingExplicit && nextFireAt !== null && hasTarget ? 1 : 0

        const inserted = dbUpsertTimer(ops, {
          id: r.id,
          projectId,
          sessionId: resolved?.sessionId ?? null,
          channel: r.channel,
          creatorId: typeof creator?.id === 'string' ? creator.id : null,
          creatorName: typeof creator?.name === 'string' ? creator.name : null,
          message: r.message,
          scheduleJson: JSON.stringify(r.schedule),
          timezone,
          enabled,
          nextFireAt,
          lastFiredAt: typeof r.lastFiredAt === 'string' ? r.lastFiredAt : null,
          scheduleUpdatedAt:
            typeof r.scheduleUpdatedAt === 'string'
              ? r.scheduleUpdatedAt
              : null,
          createdAt,
        })
        if (inserted) ops.summary.timers += 1
      }
    }

    const subsFile = join(dataDir, 'channels', 'subscriptions.json')
    if (existsSync(subsFile)) {
      const parsed = readJsonStrict(subsFile)
      if (!isPlainObject(parsed) || !Array.isArray(parsed.subscriptions)) {
        throw new Error(`Invalid channel subscriptions ${subsFile}`)
      }
      for (const sub of parsed.subscriptions) {
        if (
          !isPlainObject(sub) ||
          typeof sub.id !== 'string' ||
          typeof sub.source !== 'string' ||
          typeof sub.key !== 'string' ||
          typeof sub.channel !== 'string' ||
          typeof sub.chatId !== 'string'
        ) {
          continue
        }
        const { resolved, missingExplicit } = resolveChannelTarget(
          ops,
          dataDir,
          sub.channel,
          sub.chatId,
          sub.targetKey,
        )
        if (missingExplicit) {
          ops.warnings.push(
            `Skipped subscription "${sub.id}" because target "${String(sub.targetKey)}" is unavailable`,
          )
          continue
        }
        let projectId =
          resolved?.projectId ??
          ops.projectByChat.get(`${sub.channel}\0${sub.chatId}`) ??
          (ops.localProjectIds.has(sub.chatId) ? sub.chatId : null)
        let sessionId = resolved?.sessionId
        if (!sessionId) {
          sessionId = ops.resolveSessionId(
            dataDir,
            legacyChannelSessionId(sub.channel, sub.chatId),
          )
          if (!projectId && sub.channel === 'lark') {
            projectId = `lark-group:${sub.chatId}`
            ops.ensureProject({ id: projectId, name: sub.chatId })
          }
          ops.ensureSession({
            id: sessionId,
            projectId,
            kind: projectId ? 'hub' : 'chat',
            state: 'idle',
          })
        }
        const creator = isPlainObject(sub.creator) ? sub.creator : undefined
        const existed = ops.db.get<{ id: string }>(
          'SELECT id FROM subscriptions WHERE id = ?',
          sub.id,
        )
        ops.db.run(
          `INSERT INTO subscriptions (
            id, source, event_key, project_id, session_id, creator_id, creator_name, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            project_id = COALESCE(subscriptions.project_id, excluded.project_id),
            session_id = COALESCE(subscriptions.session_id, excluded.session_id)`,
          sub.id,
          sub.source,
          sub.key,
          projectId,
          sessionId,
          typeof creator?.id === 'string' ? creator.id : null,
          typeof creator?.name === 'string' ? creator.name : null,
          ops.now,
        )
        if (!existed) ops.summary.subscriptions += 1
      }
    }
  }
}

function dbUpsertTimer(
  ops: MigrationOps,
  row: {
    id: string
    projectId: string | null
    sessionId: string | null
    channel: string
    creatorId: string | null
    creatorName: string | null
    message: string
    scheduleJson: string
    timezone: string
    enabled: number
    nextFireAt: string | null
    lastFiredAt: string | null
    scheduleUpdatedAt: string | null
    createdAt: string
  },
): boolean {
  const existed = ops.db.get<{ id: string }>(
    'SELECT id FROM timers WHERE id = ?',
    row.id,
  )
  ops.db.run(
    `INSERT INTO timers (
      id, kind, project_id, session_id, channel, creator_id, creator_name,
      message, schedule_json, timezone, enabled, next_fire_at, last_fired_at,
      schedule_updated_at, created_at, updated_at
    ) VALUES (?, 'routine', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_id = COALESCE(timers.project_id, excluded.project_id),
      session_id = COALESCE(timers.session_id, excluded.session_id),
      enabled = CASE WHEN excluded.enabled = 1 THEN 1 ELSE timers.enabled END,
      timezone = COALESCE(excluded.timezone, timers.timezone),
      next_fire_at = CASE
        WHEN timers.timezone IS NOT excluded.timezone AND excluded.next_fire_at IS NOT NULL
          THEN excluded.next_fire_at
        ELSE COALESCE(timers.next_fire_at, excluded.next_fire_at)
      END,
      updated_at = excluded.updated_at`,
    row.id,
    row.projectId,
    row.sessionId,
    row.channel,
    row.creatorId,
    row.creatorName,
    row.message,
    row.scheduleJson,
    row.timezone,
    row.enabled,
    row.nextFireAt,
    row.lastFiredAt,
    row.scheduleUpdatedAt,
    row.createdAt,
    ops.now,
  )
  return !existed
}
