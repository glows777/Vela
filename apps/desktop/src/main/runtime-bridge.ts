import { Buffer } from 'node:buffer'
import { realpathSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type {
  ChannelBinding,
  LocalVelaRuntime,
  ProjectRecord,
  RuntimeEvent,
  SessionRecord,
  SessionStatusInfo,
} from '@glows777/vela/legacy-desktop'
import type {
  Event,
  LarkSubmit,
  Message,
  Project,
  Request,
  Session,
} from '../shared/bridge.ts'
import {
  DesktopClientIdTracker,
  extractMessageText,
  fetchLocalDesktopMessages,
  formatFailedTaskReply,
  toDesktopMessage,
} from './runtime-history.ts'

type LocalProject = Extract<Project, { channel: 'local' }>

export {
  DesktopClientIdTracker,
  extractMessageText,
  fetchLocalDesktopMessages,
  toDesktopMessage,
}

export type SessionOwnership = {
  channel: 'local' | 'lark'
  chatId: string
  chatKind: 'group' | 'direct'
  topic?: { rootId: string; threadId: string }
}

/** Resolve which desktop channel (`local` vs `lark`) and chat owns a Runtime session. */
export function resolveSessionOwnership(
  session: SessionRecord,
  bindings: readonly ChannelBinding[],
  larkProjectIds: ReadonlySet<string>,
  projectsById?: ReadonlyMap<string, ProjectRecord>,
): SessionOwnership | undefined {
  const direct = bindings.find(
    (b) => b.channel === 'lark' && b.sessionId === session.id,
  )
  if (direct) {
    const root = direct.threadId
      ? bindings.find(
          (b) =>
            b.channel === 'lark' &&
            b.externalId === direct.externalId &&
            !b.threadId,
        )
      : direct
    if (!direct.enabled || !root?.enabled) return undefined
    const rootId =
      typeof direct.config?.rootId === 'string' && direct.config.rootId
        ? direct.config.rootId
        : (direct.threadId ?? session.id)
    return {
      channel: 'lark',
      chatId: direct.externalId,
      chatKind: direct.kind,
      ...(direct.threadId
        ? { topic: { rootId, threadId: direct.threadId } }
        : {}),
    }
  }
  if (session.projectId && larkProjectIds.has(session.projectId)) {
    const root = bindings.find(
      (b) =>
        b.channel === 'lark' &&
        b.projectId === session.projectId &&
        !b.threadId,
    )
    const project = projectsById?.get(session.projectId)
    const isHub = project
      ? session.id === project.hubSessionId
      : session.kind === 'hub'
    if (!root?.enabled || !isHub) return undefined
    return {
      channel: 'lark',
      chatId: root.externalId,
      chatKind: root.kind,
    }
  }
  const chatId = session.projectId ?? session.id
  return {
    channel: 'local',
    chatId,
    chatKind: 'group',
    ...(session.kind === 'topic' || session.kind === 'work'
      ? { topic: { rootId: session.id, threadId: session.id } }
      : {}),
  }
}

function mapSessionState(
  session: SessionRecord,
  status?: SessionStatusInfo,
  lastRunStatus?: string | null,
): Session['state'] {
  if (status?.activeRunId || session.state === 'running') return 'running'
  if (session.state === 'waiting_human') return 'waiting'
  if (session.state === 'stopped' || lastRunStatus === 'stopped') {
    return 'stopped'
  }
  return 'done'
}

export function toDesktopSession(
  session: SessionRecord,
  ownership: SessionOwnership,
  status?: SessionStatusInfo,
  fallbackTask?: string,
  lastRunStatus?: string | null,
): Session {
  return {
    channel: ownership.channel,
    sessionId: session.id,
    chatId: ownership.chatId,
    chatKind: ownership.chatKind,
    ...(ownership.topic ? { topic: ownership.topic } : {}),
    task: session.name?.trim() || fallbackTask || '',
    state: mapSessionState(session, status, lastRunStatus),
    requester:
      ownership.channel === 'lark'
        ? { id: 'lark', name: 'Lark' }
        : { id: 'local-user', name: 'You' },
    updatedAt: session.updatedAt,
    ...(session.waitingReason ? { waitingReason: session.waitingReason } : {}),
    ...(status?.activeRunId ? { runId: status.activeRunId } : {}),
  }
}

export function mapLocalRuntimeEvent(
  event: RuntimeEvent,
  chatId: string,
  desktopSession: Session,
  desktopMessage?: Message,
): Event[] {
  const base = {
    version: 1 as const,
    id: `evt-${event.seq}`,
    time: event.timestamp,
    projectId: chatId,
    sessionId: event.sessionId,
    ...('runId' in event && event.runId ? { runId: event.runId } : {}),
  }
  switch (event.type) {
    case 'run_started':
      return [
        {
          type: 'session',
          channel: 'local',
          value: {
            session: desktopSession,
            run: { type: 'started', runId: event.runId },
          },
        },
        {
          type: 'local',
          channel: 'local',
          value: { ...base, type: 'session', data: desktopSession },
        },
        {
          type: 'local',
          channel: 'local',
          value: { ...base, type: 'run_started', data: {} },
        },
      ]
    case 'message_committed': {
      const events: Event[] = []
      if (desktopMessage) {
        events.push({
          type: 'local',
          channel: 'local',
          value: { ...base, type: 'message', data: desktopMessage },
        })
      }
      if (desktopSession.topic && desktopSession.task) {
        events.push({
          type: 'local',
          channel: 'local',
          value: { ...base, type: 'session', data: desktopSession },
        })
      }
      return events
    }
    case 'tool_started':
      return [
        {
          type: 'local',
          channel: 'local',
          value: {
            ...base,
            type: 'progress',
            data: { stage: 'tool', tool: event.toolName, state: 'started' },
          },
        },
      ]
    case 'tool_finished':
      return [
        {
          type: 'local',
          channel: 'local',
          value: {
            ...base,
            type: 'progress',
            data: {
              stage: 'tool',
              tool: event.toolName,
              state: event.isError ? 'failed' : 'finished',
            },
          },
        },
      ]
    case 'auto_retry_start':
      return [
        {
          type: 'local',
          channel: 'local',
          value: {
            ...base,
            type: 'progress',
            data: { stage: 'retry', state: 'started' },
          },
        },
      ]
    case 'auto_retry_end':
      return [
        {
          type: 'local',
          channel: 'local',
          value: {
            ...base,
            type: 'progress',
            data: {
              stage: 'retry',
              state: event.success ? 'finished' : 'failed',
            },
          },
        },
      ]
    case 'compaction_started':
      return [
        {
          type: 'local',
          channel: 'local',
          value: {
            ...base,
            type: 'progress',
            data: { stage: 'compaction', state: 'started' },
          },
        },
      ]
    case 'compaction_finished':
      return [
        {
          type: 'local',
          channel: 'local',
          value: {
            ...base,
            type: 'progress',
            data: { stage: 'compaction', state: 'finished' },
          },
        },
      ]
    case 'compaction_failed':
      return [
        {
          type: 'local',
          channel: 'local',
          value: {
            ...base,
            type: 'progress',
            data: { stage: 'compaction', state: 'failed' },
          },
        },
      ]
    case 'run_finished': {
      const outcome =
        event.status === 'failed' || event.status === 'interrupted'
          ? 'failed'
          : event.status === 'stopped'
            ? 'stopped'
            : event.silent
              ? 'silent'
              : 'done'
      const events: Event[] = []
      if (outcome === 'failed' && event.error) {
        events.push(
          {
            type: 'local',
            channel: 'local',
            value: {
              ...base,
              type: 'error',
              data: {
                code: event.errorKind ?? 'failed',
                message: event.error,
              },
            },
          },
          {
            type: 'local',
            channel: 'local',
            value: {
              ...base,
              id: `evt-${event.seq}-failed-msg`,
              type: 'message',
              data: {
                id: `failed-${event.runId}`,
                sessionId: event.sessionId,
                role: 'assistant',
                text: formatFailedTaskReply(event.error, event.errorHint),
                createdAt: event.timestamp,
              },
            },
          },
        )
      }
      events.push(
        {
          type: 'session',
          channel: 'local',
          value: {
            session: desktopSession,
            run: { type: 'finished', runId: event.runId, outcome },
          },
        },
        {
          type: 'local',
          channel: 'local',
          value: { ...base, type: 'session', data: desktopSession },
        },
        {
          type: 'local',
          channel: 'local',
          value: { ...base, type: 'run_finished', data: { outcome } },
        },
      )
      return events
    }
    default:
      return []
  }
}

function getLarkProjectIds(bindings: readonly ChannelBinding[]): Set<string> {
  return new Set(
    bindings
      .filter((b) => b.channel === 'lark')
      .map((b) => b.projectId)
      .filter((id): id is string => Boolean(id)),
  )
}

async function requireLocalProjectSession(
  runtime: LocalVelaRuntime,
  projectId: string,
  sessionId: string,
): Promise<{ project: ProjectRecord; session: SessionRecord }> {
  const bindings = await runtime.bindings.list({ channel: 'lark' })
  const larkProjectIds = getLarkProjectIds(bindings)
  const project = await runtime.projects.get(projectId)
  if (!project || project.archived || larkProjectIds.has(project.id)) {
    throw new Error(`Unknown project ${projectId}`)
  }
  const session = await runtime.sessions.get(sessionId)
  if (
    !session ||
    (session.projectId !== project.id && session.id !== project.hubSessionId)
  ) {
    throw new Error(
      `Session ${sessionId} does not belong to project ${projectId}`,
    )
  }
  return { project, session }
}

function resolveLocalTargetSession(
  target: { chatId: string; rootId?: string },
  projects: readonly ProjectRecord[],
  sessions: readonly SessionRecord[],
  larkProjectIds: ReadonlySet<string>,
): SessionRecord | undefined {
  const project = projects.find(
    (p) => p.id === target.chatId && !p.archived && !larkProjectIds.has(p.id),
  )
  if (!project) return undefined
  if (target.rootId) {
    return sessions.find(
      (s) =>
        s.id === target.rootId &&
        (s.projectId === project.id || s.id === project.hubSessionId),
    )
  }
  if (!project.hubSessionId) return undefined
  return sessions.find((s) => s.id === project.hubSessionId)
}

const larkAuthor = { id: 'vela-app', name: 'Vela app' }

function validateLocalText(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('Message text is required')
  if (trimmed.length > 100_000) {
    throw new Error('Message is too long (max 100000 characters)')
  }
  return trimmed
}

const openProjectLocksByRuntime = new WeakMap<
  LocalVelaRuntime,
  Map<string, Promise<LocalProject>>
>()

export async function submitDesktopMessage(
  runtime: LocalVelaRuntime,
  loadLark: boolean,
  clientIdTracker: DesktopClientIdTracker,
  request: Extract<Request, { method: 'submit' }>,
) {
  if (request.channel === 'local' && 'projectId' in request.message) {
    const { projectId, sessionId, clientMessageId } = request.message
    const { session } = await requireLocalProjectSession(
      runtime,
      projectId,
      sessionId,
    )
    const text = validateLocalText(request.message.text)
    if (session.kind !== 'hub') {
      const status = await runtime.sessions
        .status(sessionId)
        .catch(() => undefined)
      if (status?.activeRunId) {
        const cancelSteerTrack = clientMessageId
          ? clientIdTracker.trackSteer(sessionId, text, clientMessageId)
          : undefined
        try {
          await runtime.steer(sessionId, text)
        } catch (error) {
          cancelSteerTrack?.()
          throw error
        }
        return {
          outcome: 'posted' as const,
          sessionId,
          messageId: clientMessageId ?? sessionId,
        }
      }
    }
    const res = await runtime.prompt(sessionId, {
      text,
      dedupeKey: clientMessageId,
      source: 'user',
      metadata: { projectId },
    })
    if (clientMessageId && res.inserted) {
      clientIdTracker.trackPrompt(res.eventId, clientMessageId)
    }
    return {
      outcome: 'posted' as const,
      sessionId,
      messageId: res.eventId,
    }
  }
  if (request.channel === 'local' && 'channelId' in request.message) {
    const msg = request.message
    const text = validateLocalText(msg.text)
    const bindings = await runtime.bindings.list({ channel: 'lark' })
    const larkProjectIds = getLarkProjectIds(bindings)
    const project = await runtime.projects.get(msg.channelId)
    if (!project || project.archived || larkProjectIds.has(project.id)) {
      throw new Error(`Unknown project ${msg.channelId}`)
    }
    const sessionId = msg.topic?.threadId ?? project.hubSessionId
    if (!sessionId) {
      throw new Error(`Project ${msg.channelId} has no hub session`)
    }
    const targetSession = await runtime.sessions.get(sessionId)
    if (
      !targetSession ||
      (targetSession.projectId !== project.id &&
        targetSession.id !== project.hubSessionId)
    ) {
      throw new Error(
        `Session ${sessionId} does not belong to project ${project.id}`,
      )
    }
    if (targetSession.kind !== 'hub') {
      const status = await runtime.sessions
        .status(sessionId)
        .catch(() => undefined)
      if (status?.activeRunId) {
        const steerImages = msg.images?.map((img) => ({
          data: img.data,
          mimeType: img.mimeType,
        }))
        await runtime.steer(sessionId, text, steerImages)
        return {
          outcome: 'posted' as const,
          sessionId,
          messageId: sessionId,
        }
      }
    }
    const attachments = msg.images?.length
      ? await Promise.all(
          msg.images.map(async (img, i) => {
            const ext = img.mimeType.split('/')[1] || 'png'
            const blob = await runtime.blobs.storeInbound({
              sessionId,
              projectId: project.id,
              filename: `image-${i + 1}.${ext}`,
              mimeType: img.mimeType,
              bytes: Buffer.from(img.data, 'base64'),
            })
            return {
              blobId: blob.id,
              name: blob.filename,
              mimeType: img.mimeType,
              inlineOnly: true,
            }
          }),
        )
      : undefined
    const res = await runtime.prompt(sessionId, {
      text,
      attachments,
      source: 'user',
      metadata: { projectId: project.id },
    })
    return {
      outcome: 'posted' as const,
      sessionId,
      messageId: res.eventId,
    }
  }
  if (request.channel === 'lark' && 'chatId' in request.message) {
    if (!loadLark) throw new Error('Lark is not available in this app')
    const input: LarkSubmit = request.message
    return runtime.channels.submit('lark', {
      chatId: input.chatId,
      text: input.text,
      author: larkAuthor,
      ...('newTopic' in input
        ? { newTopic: input.newTopic }
        : { sessionId: input.sessionId }),
    })
  }
  throw new Error('Invalid channel message')
}

export async function stopDesktopTarget(
  runtime: LocalVelaRuntime,
  request: Extract<Request, { method: 'stop' }>,
): Promise<boolean> {
  if (request.channel === 'local') {
    const bindings = await runtime.bindings.list({ channel: 'lark' })
    const target = resolveLocalTargetSession(
      request.target,
      await runtime.projects.list({ includeArchived: true }),
      await runtime.sessions.list({ includeArchived: true }),
      getLarkProjectIds(bindings),
    )
    if (!target) return false
    const status = await runtime.sessions
      .status(target.id)
      .catch(() => undefined)
    if (!status?.activeRunId || status.activeRunId !== request.runId) {
      return false
    }
    return runtime.stop(target.id, 'Stopped by user', {
      expectedRunId: request.runId,
    })
  }
  if (request.channel === 'lark') {
    const bindings = await runtime.bindings.list({ channel: 'lark' })
    const rootBinding = bindings.find(
      (b) => b.externalId === request.target.chatId && !b.threadId && b.enabled,
    )
    if (!rootBinding) return false
    let sessionId: string | undefined
    if (request.target.rootId) {
      const topicBinding = bindings.find(
        (b) =>
          b.externalId === request.target.chatId &&
          b.enabled &&
          b.threadId &&
          (b.threadId === request.target.rootId ||
            b.config?.rootId === request.target.rootId),
      )
      sessionId = topicBinding?.sessionId ?? undefined
    } else {
      sessionId =
        rootBinding.sessionId ??
        (rootBinding.projectId
          ? ((await runtime.projects.get(rootBinding.projectId))
              ?.hubSessionId ?? undefined)
          : undefined)
    }
    if (!sessionId) return false
    const status = await runtime.sessions
      .status(sessionId)
      .catch(() => undefined)
    if (!status?.activeRunId || status.activeRunId !== request.runId) {
      return false
    }
    return runtime.stop(sessionId, 'Stopped by user', {
      expectedRunId: request.runId,
    })
  }
  return false
}

export async function openLocalDesktopProject(
  runtime: LocalVelaRuntime,
  input: Extract<Request, { method: 'openProject' }>['input'],
  _larkProjectIds?: ReadonlySet<string>,
): Promise<LocalProject> {
  const rawCwd = input.cwd.trim()
  if (!rawCwd) throw new Error('Project must be an existing directory')
  let canonicalCwd: string
  try {
    canonicalCwd = realpathSync(rawCwd)
    if (!statSync(canonicalCwd).isDirectory()) {
      throw new Error('Project must be an existing directory')
    }
  } catch {
    throw new Error('Project must be an existing directory')
  }

  let locks = openProjectLocksByRuntime.get(runtime)
  if (!locks) {
    locks = new Map()
    openProjectLocksByRuntime.set(runtime, locks)
  }
  const existingLock = locks.get(canonicalCwd)
  if (existingLock) return existingLock

  const opening = (async (): Promise<LocalProject> => {
    const bindings = await runtime.bindings.list({ channel: 'lark' })
    const larkProjectIds = getLarkProjectIds(bindings)
    const allProjects = await runtime.projects.list({ includeArchived: false })
    const existing = allProjects.find(
      (p) =>
        p.cwd === canonicalCwd &&
        !larkProjectIds.has(p.id) &&
        Boolean(p.hubSessionId),
    )
    if (existing?.hubSessionId) {
      return {
        id: existing.id,
        channel: 'local' as const,
        cwd: existing.cwd ?? canonicalCwd,
        name: existing.name,
        sessionId: existing.hubSessionId,
      }
    }
    const trimmedName = input.name?.trim()
    const name = trimmedName || basename(canonicalCwd) || canonicalCwd
    const created = await runtime.projects.create({
      name,
      cwd: canonicalCwd,
      hubSessionId: true,
    })
    return {
      id: created.id,
      channel: 'local' as const,
      cwd: created.cwd ?? canonicalCwd,
      name: created.name,
      sessionId: created.hubSessionId!,
    }
  })()

  locks.set(canonicalCwd, opening)
  try {
    return await opening
  } finally {
    if (locks.get(canonicalCwd) === opening) {
      locks.delete(canonicalCwd)
    }
  }
}

export async function fetchLarkDesktopMessages(
  runtime: LocalVelaRuntime,
  input: Extract<Request, { method: 'larkMessages' }>['input'],
): Promise<{ messages: Message[]; nextCursor?: string }> {
  const bindings = await runtime.bindings.list({ channel: 'lark' })
  const rootBinding = bindings.find(
    (b) => b.externalId === input.chatId && !b.threadId && b.enabled,
  )
  if (!rootBinding) {
    throw new Error(`Unknown or disabled Lark chat ${input.chatId}`)
  }
  const sessionMatchesBinding = bindings.some(
    (b) =>
      b.externalId === input.chatId &&
      b.enabled &&
      b.sessionId === input.sessionId,
  )
  let sessionMatchesHub = false
  if (!sessionMatchesBinding && rootBinding.projectId) {
    const project = await runtime.projects.get(rootBinding.projectId)
    if (project?.hubSessionId === input.sessionId) {
      sessionMatchesHub = true
    }
  }
  if (!sessionMatchesBinding && !sessionMatchesHub) {
    throw new Error(
      `Session ${input.sessionId} does not belong to Lark chat ${input.chatId}`,
    )
  }

  const page = await runtime.sessions.messages({
    sessionId: input.sessionId,
    cursor: input.cursor,
    limit: input.limit,
  })
  return {
    messages: page.messages
      .map((row) => {
        if (
          row.role === 'user' &&
          !row.senderId &&
          row.senderName === larkAuthor.name
        ) {
          return {
            id: row.id,
            sessionId: row.sessionId,
            role: 'assistant' as const,
            text: `${row.senderName}: ${row.text}`,
            createdAt: row.createdAt,
            senderName: 'Vela',
          }
        }
        return toDesktopMessage(row)
      })
      .filter((m): m is Message => Boolean(m)),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  }
}
