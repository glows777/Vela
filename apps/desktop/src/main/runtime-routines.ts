import type { SessionRecord, TimerRecord, VelaRuntime } from '@glows777/vela'
import type { Request, Routine } from '../shared/bridge.ts'
import {
  localRoutineInstant,
  nextOccurrence,
  routineLocalTime,
  routineTimezone,
} from './routine-time.ts'

const localCreator = { id: 'local-user', name: 'You' }
const larkCreator = { id: 'vela-app', name: 'Vela app' }

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

function formatRoutineTarget(
  channel: string,
  timer: TimerRecord,
  session?: SessionRecord,
): string {
  if (channel === 'lark' || timer.channel === 'lark') {
    if (!session || session.kind === 'hub') return 'Group channel'
    return `Topic: ${session.name?.trim() || 'Untitled'}`
  }
  if (!session) return 'Project default'
  if (session.kind === 'hub') return 'Project default'
  return `Session: ${session.name?.trim() || 'Untitled'}`
}

function toDesktopRoutine(
  channel: string,
  timer: TimerRecord,
  sessionsById: ReadonlyMap<string, SessionRecord>,
): Routine {
  const zone = routineTimezone(timer.timezone)
  const session = timer.sessionId
    ? sessionsById.get(timer.sessionId)
    : undefined
  const target = formatRoutineTarget(channel, timer, session)
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
      id: timer.creatorId ?? localCreator.id,
      name: timer.creatorName ?? localCreator.name,
    },
    timezone: zone,
    scheduleText: formatRoutineScheduleText(timer),
    target,
    nextRun,
  }
}

async function resolveRoutineScope(
  runtime: VelaRuntime,
  channel: string,
  chatId: string,
): Promise<{
  projectId: string
  hubSessionId: string | null
  rootBindingId?: string
}> {
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
    hubSessionId: root.sessionId ?? project.hubSessionId ?? null,
    rootBindingId: root.id,
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

function resolveDesktopRoutineTimezone(
  projectConfig: Record<string, unknown> | null | undefined,
  channel: string,
  larkSettings: Record<string, unknown>,
): string {
  return routineTimezone(
    (typeof projectConfig?.timezone === 'string'
      ? projectConfig.timezone
      : undefined) ??
      (channel === 'lark' && typeof larkSettings.timezone === 'string'
        ? larkSettings.timezone
        : undefined),
  )
}

/** Handles desktop Routine CRUD RPCs via `runtime.timers`. */
export async function handleDesktopRoutineRequest(
  runtime: VelaRuntime,
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
      const timezone = resolveDesktopRoutineTimezone(
        project?.config,
        request.channel,
        larkSettings,
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
        routines: timers.map((t) => toDesktopRoutine(request.channel, t, byId)),
      }
    }
    case 'createRoutine': {
      if (request.channel !== 'local' && request.channel !== 'lark') {
        throw new Error(`Unsupported routine channel ${request.channel}`)
      }
      const { projectId, hubSessionId } = await resolveRoutineScope(
        runtime,
        request.channel,
        request.target.chatId,
      )
      let sessionId: string | null = hubSessionId
      let targetThreadId: string | undefined
      if (request.channel === 'lark') {
        if (request.target.rootId) {
          const bindings = await runtime.bindings.list({ channel: 'lark' })
          const topicBinding = bindings.find(
            (b) =>
              b.externalId === request.target.chatId &&
              b.enabled &&
              b.threadId &&
              (b.threadId === request.target.rootId ||
                b.config?.rootId === request.target.rootId ||
                b.sessionId === request.target.rootId),
          )
          if (!topicBinding?.sessionId) {
            throw new Error('Unknown or disabled channel target')
          }
          sessionId = topicBinding.sessionId
          targetThreadId = topicBinding.threadId ?? undefined
        }
        if (!sessionId) throw new Error('Unknown or disabled channel target')
      } else if (request.target.rootId) {
        const targetSession = await runtime.sessions.get(request.target.rootId)
        if (!targetSession || targetSession.projectId !== projectId) {
          throw new Error('Unknown or disabled session target')
        }
        sessionId = targetSession.id
      }

      const project = await runtime.projects.get(projectId)
      const zone = resolveDesktopRoutineTimezone(
        project?.config,
        request.channel,
        larkSettings,
      )
      const schedule = normalizeDesktopRoutineSchedule(
        request.input.schedule,
        zone,
      )
      const isLark = request.channel === 'lark'
      const creator = isLark ? larkCreator : localCreator
      const timer = await runtime.timers.createRoutine({
        projectId,
        sessionId,
        channel: isLark ? 'lark' : null,
        ...(isLark
          ? {
              target: {
                channel: 'lark',
                externalChatId: request.target.chatId,
                ...(targetThreadId ? { threadId: targetThreadId } : {}),
              },
            }
          : {}),
        creatorId: creator.id,
        creatorName: creator.name,
        message: request.input.message,
        schedule,
        timezone: zone,
      })
      const sessionList = await runtime.sessions.list({ projectId })
      return toDesktopRoutine(
        request.channel,
        timer,
        new Map(sessionList.map((s) => [s.id, s])),
      )
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
        request.channel,
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
