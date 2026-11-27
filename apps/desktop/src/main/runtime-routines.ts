import type {
  LocalVelaRuntime,
  SessionRecord,
  TimerRecord,
} from '@glows777/vela/legacy-desktop'
import {
  localRoutineInstant,
  nextOccurrence,
  routineLocalTime,
  routineTimezone,
} from '@glows777/vela/legacy-desktop'
import type { Request, Routine } from '../shared/bridge.ts'

const localCreator = { id: 'local-user', name: 'You' }

function formatRoutineScheduleText(timer: TimerRecord): string {
  if ('at' in timer.schedule) {
    const ms = Date.parse(timer.schedule.at)
    return Number.isFinite(ms)
      ? routineLocalTime(ms, timer.timezone)
      : timer.schedule.at
  }
  return timer.schedule.days?.length
    ? `${timer.schedule.days.join(',')} at ${timer.schedule.time}`
    : `Daily at ${timer.schedule.time}`
}

function toDesktopRoutine(
  timer: TimerRecord,
  sessionsById: ReadonlyMap<string, SessionRecord>,
): Routine {
  const zone = routineTimezone(timer.timezone)
  const session = timer.sessionId
    ? sessionsById.get(timer.sessionId)
    : undefined
  const target =
    !session || session.kind === 'hub'
      ? 'Group channel'
      : `Topic: ${session.name?.trim() || 'Untitled'}`
  let nextRun: string | null = null
  if (timer.nextFireAt) {
    const ms = Date.parse(timer.nextFireAt)
    if (Number.isFinite(ms)) nextRun = routineLocalTime(ms, zone)
  } else {
    const nextMs = nextOccurrence(timer.schedule, Date.now(), zone)
    if (nextMs !== undefined) nextRun = routineLocalTime(nextMs, zone)
  }
  return {
    id: timer.id,
    message: timer.message,
    schedule: timer.schedule,
    creator: {
      id: timer.creatorId ?? 'local-user',
      name: timer.creatorName ?? 'You',
    },
    timezone: zone,
    scheduleText: formatRoutineScheduleText(timer),
    target,
    nextRun,
  }
}

async function resolveRoutineScope(
  runtime: LocalVelaRuntime,
  channel: string,
  chatId: string,
): Promise<{ projectId: string; hubSessionId: string | null }> {
  const bindings = await runtime.bindings.list({ channel: 'lark' })
  if (channel === 'local') {
    const project = await runtime.projects.get(chatId)
    if (
      !project ||
      project.archived ||
      bindings.some((b) => b.projectId === project.id)
    ) {
      throw new Error(`Unknown project ${chatId}`)
    }
    return { projectId: project.id, hubSessionId: project.hubSessionId }
  }
  const root = bindings.find(
    (b) =>
      b.channel === channel &&
      b.externalId === chatId &&
      !b.threadId &&
      b.enabled,
  )
  if (!root?.projectId) throw new Error('Unknown or disabled channel target')
  const project = await runtime.projects.get(root.projectId)
  if (!project || project.archived) {
    throw new Error('Unknown or disabled channel target')
  }
  return {
    projectId: root.projectId,
    hubSessionId: project.hubSessionId ?? null,
  }
}

function normalizeDesktopRoutineSchedule(
  schedule:
    | { at: string }
    | {
        time: string
        days?: ('mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun')[]
      },
  zone: string,
) {
  if (!('at' in schedule)) return schedule
  const at = localRoutineInstant(schedule.at, zone)
  const atMs = Date.parse(at)
  if (!Number.isFinite(atMs) || atMs <= Date.now()) {
    throw new Error('A one-off routine must be in the future')
  }
  return { at }
}

/** Handles desktop Routine CRUD RPCs via `runtime.timers`. */
export async function handleDesktopRoutineRequest(
  runtime: LocalVelaRuntime,
  larkSettings: Record<string, unknown>,
  request: Extract<
    Request,
    {
      method: 'listRoutines' | 'createRoutine' | 'editRoutine' | 'cancelRoutine'
    }
  >,
) {
  switch (request.method) {
    case 'listRoutines': {
      const { projectId } = await resolveRoutineScope(
        runtime,
        request.channel,
        request.chatId,
      )
      const project = await runtime.projects.get(projectId)
      const timezone = routineTimezone(
        (typeof project?.config?.timezone === 'string'
          ? project.config.timezone
          : undefined) ??
          (request.channel === 'lark' &&
          typeof larkSettings.timezone === 'string'
            ? larkSettings.timezone
            : undefined),
      )
      const timers = await runtime.timers.list({
        projectId,
        kind: 'routine',
        enabledOnly: true,
      })
      const sessionList = await runtime.sessions.list({ projectId })
      const byId = new Map(sessionList.map((s) => [s.id, s]))
      return {
        timezone,
        routines: timers.map((t) => toDesktopRoutine(t, byId)),
      }
    }
    case 'createRoutine': {
      const { projectId, hubSessionId } = await resolveRoutineScope(
        runtime,
        request.channel,
        request.target.chatId,
      )
      let sessionId = hubSessionId
      if (request.target.rootId) {
        const targetSession = await runtime.sessions.get(request.target.rootId)
        if (!targetSession || targetSession.projectId !== projectId) {
          throw new Error('Unknown or disabled channel target')
        }
        sessionId = targetSession.id
      }
      if (!sessionId) throw new Error('Unknown or disabled channel target')
      const zone = routineTimezone(
        request.channel === 'lark' && typeof larkSettings.timezone === 'string'
          ? larkSettings.timezone
          : undefined,
      )
      const schedule = normalizeDesktopRoutineSchedule(
        request.input.schedule,
        zone,
      )
      const timer = await runtime.timers.createRoutine({
        projectId,
        sessionId,
        channel: request.channel === 'lark' ? 'lark' : null,
        ...(request.channel === 'lark'
          ? {
              target: {
                channel: 'lark',
                externalChatId: request.target.chatId,
                ...(request.target.rootId
                  ? { threadId: request.target.rootId }
                  : {}),
              },
            }
          : {}),
        creatorId: localCreator.id,
        creatorName: localCreator.name,
        message: request.input.message,
        schedule,
        timezone: zone,
      })
      const sessionList = await runtime.sessions.list({ projectId })
      return toDesktopRoutine(timer, new Map(sessionList.map((s) => [s.id, s])))
    }
    case 'editRoutine': {
      const { projectId } = await resolveRoutineScope(
        runtime,
        request.channel,
        request.chatId,
      )
      const existing = (
        await runtime.timers.list({ projectId, kind: 'routine' })
      ).find((t) => t.id === request.id)
      if (!existing) return undefined
      const zone = routineTimezone(existing.timezone)
      const schedule =
        request.input.schedule === undefined
          ? undefined
          : normalizeDesktopRoutineSchedule(request.input.schedule, zone)
      const updated = await runtime.timers.update(request.id, {
        ...(request.input.message !== undefined
          ? { message: request.input.message }
          : {}),
        ...(schedule ? { schedule } : {}),
      })
      if (!updated) return undefined
      const sessionList = await runtime.sessions.list({ projectId })
      return toDesktopRoutine(
        updated,
        new Map(sessionList.map((s) => [s.id, s])),
      )
    }
    case 'cancelRoutine': {
      const { projectId } = await resolveRoutineScope(
        runtime,
        request.channel,
        request.chatId,
      )
      return runtime.timers.delete(request.id, { projectId, kind: 'routine' })
    }
  }
}
