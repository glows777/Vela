import { Buffer } from 'node:buffer'
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import type {
  ChannelBinding,
  ProjectRecord,
  SessionRecord,
  SessionStatusInfo,
  VelaRuntime,
} from '@glows777/vela'
import type {
  LarkSubmit,
  LocalProject,
  LocalSubmit,
  Request,
  Session,
} from '../shared/bridge.ts'
import { mapLocalRuntimeEvent } from './runtime-events.ts'
import {
  DesktopClientIdTracker,
  extractMessageText,
  fetchDesktopMessages,
  toDesktopMessage,
} from './runtime-history.ts'

export {
  DesktopClientIdTracker,
  extractMessageText,
  fetchDesktopMessages,
  mapLocalRuntimeEvent,
  toDesktopMessage,
}

export type SessionOwnership = {
  channel: 'local' | 'lark'
  chatId: string | null
  chatKind: 'group' | 'direct' | 'quick'
  projectId: string | null
  topic?: { rootId: string; threadId: string }
}

/** Resolve which desktop channel (`local` vs `lark`) and scope owns a Runtime session. */
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
      projectId: direct.projectId ?? session.projectId ?? null,
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
      projectId: session.projectId,
    }
  }
  if (!session.projectId) {
    return {
      channel: 'local',
      chatId: null,
      chatKind: 'quick',
      projectId: null,
    }
  }
  return {
    channel: 'local',
    chatId: session.projectId,
    chatKind: 'direct',
    projectId: session.projectId,
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
  if (session.state === 'idle' && !lastRunStatus) return 'done'
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
    projectId: ownership.projectId,
    ...(ownership.topic ? { topic: ownership.topic } : {}),
    ...(ownership.channel === 'local' && session.kind === 'hub'
      ? { isHub: true }
      : {}),
    ...(session.location ? { location: session.location } : {}),
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

export function getLarkProjectIds(
  bindings: readonly ChannelBinding[],
): Set<string> {
  return new Set(
    bindings
      .filter((b) => b.channel === 'lark')
      .map((b) => b.projectId)
      .filter((id): id is string => Boolean(id)),
  )
}

async function requireLocalSession(
  runtime: VelaRuntime,
  sessionId: string,
  expectedProjectId?: string | null,
): Promise<{ project?: ProjectRecord; session: SessionRecord }> {
  const session = await runtime.sessions.get(sessionId)
  if (!session) {
    throw new Error(`Session ${sessionId} not found`)
  }
  const bindings = await runtime.bindings.list({ channel: 'lark' })
  const larkProjectIds = getLarkProjectIds(bindings)
  const isLarkSession =
    bindings.some((b) => b.sessionId === session.id) ||
    (session.projectId ? larkProjectIds.has(session.projectId) : false)
  if (isLarkSession) {
    throw new Error(`Session ${sessionId} does not belong to Local`)
  }
  if (
    expectedProjectId !== undefined &&
    session.projectId !== expectedProjectId
  ) {
    throw new Error(
      `Session ${sessionId} does not belong to project ${expectedProjectId ?? 'quick'}`,
    )
  }
  if (session.projectId) {
    const project = await runtime.projects.get(session.projectId)
    if (!project || project.archived) {
      throw new Error(`Unknown project ${session.projectId}`)
    }
    return { project, session }
  }
  return { session }
}

function resolveLocalTargetSession(
  target: { sessionId?: string; chatId?: string; rootId?: string },
  projects: readonly ProjectRecord[],
  sessions: readonly SessionRecord[],
  bindings: readonly ChannelBinding[],
  larkProjectIds: ReadonlySet<string>,
): SessionRecord | undefined {
  const projectsById = new Map(projects.map((p) => [p.id, p]))
  if (target.sessionId) {
    const direct = sessions.find((s) => s.id === target.sessionId)
    if (!direct) return undefined
    const ownership = resolveSessionOwnership(
      direct,
      bindings,
      larkProjectIds,
      projectsById,
    )
    if (ownership?.channel !== 'local') return undefined
    if (target.chatId !== undefined) {
      if (target.chatId === 'quick') {
        if (direct.projectId !== null) return undefined
      } else if (direct.projectId !== target.chatId) {
        return undefined
      }
    }
    return direct
  }
  const project = target.chatId
    ? projects.find(
        (p) =>
          p.id === target.chatId && !p.archived && !larkProjectIds.has(p.id),
      )
    : undefined
  if (!project) return undefined
  if (target.rootId) {
    return sessions.find(
      (s) =>
        s.id === target.rootId &&
        (s.projectId === project.id || s.id === project.hubSessionId),
    )
  }
  if (project.hubSessionId) {
    return sessions.find((s) => s.id === project.hubSessionId)
  }
  return sessions.find((s) => s.projectId === project.id && !s.archived)
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
  VelaRuntime,
  Map<string, Promise<LocalProject>>
>()

export async function createDesktopSession(
  runtime: VelaRuntime,
  input: { projectId?: string | null; name?: string },
): Promise<Session> {
  const projectId = input.projectId ?? null
  const name = input.name?.trim() || undefined
  if (projectId) {
    const bindings = await runtime.bindings.list({ channel: 'lark' })
    const larkProjectIds = getLarkProjectIds(bindings)
    const project = await runtime.projects.get(projectId)
    if (!project || project.archived || larkProjectIds.has(project.id)) {
      throw new Error(`Unknown project ${projectId}`)
    }
    const created = await runtime.sessions.create({
      projectId: project.id,
      kind: 'work',
      ...(name ? { name } : {}),
    })
    return toDesktopSession(created, {
      channel: 'local',
      chatId: project.id,
      chatKind: 'direct',
      projectId: project.id,
    })
  }

  const created = await runtime.sessions.create({
    projectId: null,
    kind: 'work',
    location: {
      environment: 'local',
      cwd: process.env.VELA_DESKTOP_HOME || homedir(),
    },
    ...(name ? { name } : {}),
  })
  return toDesktopSession(created, {
    channel: 'local',
    chatId: null,
    chatKind: 'quick',
    projectId: null,
  })
}

export async function renameDesktopSession(
  runtime: VelaRuntime,
  input: { sessionId: string; name: string },
): Promise<Session | undefined> {
  const { session } = await requireLocalSession(runtime, input.sessionId)
  const renamed = await runtime.sessions.rename(
    session.id,
    input.name.trim() || null,
  )
  const ownership: SessionOwnership = session.projectId
    ? {
        channel: 'local',
        chatId: session.projectId,
        chatKind: 'direct',
        projectId: session.projectId,
      }
    : {
        channel: 'local',
        chatId: null,
        chatKind: 'quick',
        projectId: null,
      }
  const status = await runtime.sessions
    .status(renamed.id)
    .catch(() => undefined)
  return toDesktopSession(renamed, ownership, status)
}

export async function deleteDesktopSession(
  runtime: VelaRuntime,
  input: { sessionId: string },
): Promise<boolean> {
  const { session } = await requireLocalSession(runtime, input.sessionId)
  const status = await runtime.sessions
    .status(session.id)
    .catch(() => undefined)
  if (status?.activeRunId) {
    await runtime.stop(session.id, 'Session deleted', {
      expectedRunId: status.activeRunId,
    })
  }
  return runtime.sessions.delete(session.id)
}

export async function removeDesktopProject(
  runtime: VelaRuntime,
  input: { projectId: string },
): Promise<boolean> {
  const bindings = await runtime.bindings.list({ channel: 'lark' })
  const larkProjectIds = getLarkProjectIds(bindings)
  const project = await runtime.projects.get(input.projectId)
  if (!project || project.archived || larkProjectIds.has(project.id)) {
    throw new Error(`Unknown project ${input.projectId}`)
  }
  return runtime.projects.remove(project.id)
}

export async function submitDesktopMessage(
  runtime: VelaRuntime,
  loadLark: boolean,
  clientIdTracker: DesktopClientIdTracker,
  request: Extract<Request, { method: 'submit' }>,
) {
  if (
    request.channel === 'local' &&
    'text' in request.message &&
    !('chatId' in request.message)
  ) {
    const msg = request.message as LocalSubmit
    const text = validateLocalText(msg.text)
    let session: SessionRecord
    let resolvedProjectId: string | null = msg.projectId ?? null
    if (msg.sessionId) {
      const checked = await requireLocalSession(
        runtime,
        msg.sessionId,
        msg.projectId !== undefined ? msg.projectId : undefined,
      )
      if (checked.session.kind === 'hub') {
        resolvedProjectId = checked.session.projectId ?? null
        session = await runtime.sessions.create({
          projectId: resolvedProjectId,
          kind: 'work',
          name: text.slice(0, 60),
        })
      } else {
        session = checked.session
        resolvedProjectId = session.projectId ?? null
      }
    } else if (resolvedProjectId) {
      const bindings = await runtime.bindings.list({ channel: 'lark' })
      const project = await runtime.projects.get(resolvedProjectId)
      if (
        !project ||
        project.archived ||
        getLarkProjectIds(bindings).has(project.id)
      ) {
        throw new Error(`Unknown project ${resolvedProjectId}`)
      }
      const existingSessions = await runtime.sessions.list({
        projectId: project.id,
        includeArchived: false,
      })
      session =
        existingSessions.find((s) => s.kind !== 'hub') ??
        (await runtime.sessions.create({
          projectId: project.id,
          kind: 'work',
        }))
    } else {
      session = await runtime.sessions.create({
        projectId: null,
        kind: 'work',
        location: {
          environment: 'local',
          cwd: process.env.VELA_DESKTOP_HOME || homedir(),
        },
      })
    }

    if (session.kind !== 'hub') {
      const status = await runtime.sessions
        .status(session.id)
        .catch(() => undefined)
      if (status?.activeRunId) {
        const steerImages = msg.images?.length
          ? msg.images.map(({ data, mimeType }) => ({ data, mimeType }))
          : undefined
        const cancelSteerTrack = msg.clientMessageId
          ? clientIdTracker.trackSteer(session.id, text, msg.clientMessageId)
          : undefined
        try {
          await runtime.steer(session.id, text, steerImages)
        } catch (error) {
          cancelSteerTrack?.()
          throw error
        }
        return {
          outcome: 'posted' as const,
          sessionId: session.id,
          messageId: msg.clientMessageId ?? session.id,
        }
      }
    }

    const attachments = msg.images?.length
      ? await Promise.all(
          msg.images.map(async (img, i) => {
            const ext = img.mimeType.split('/')[1] || 'png'
            const blob = await runtime.blobs.storeInbound({
              sessionId: session.id,
              ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
              filename: `image-${i + 1}.${ext}`,
              mimeType: img.mimeType,
              bytes: Buffer.from(img.data, 'base64'),
            })
            return {
              kind: 'image' as const,
              blobId: blob.id,
              name: blob.filename,
              mimeType: img.mimeType,
              inlineOnly: true,
            }
          }),
        )
      : undefined

    const res = await runtime.prompt(session.id, {
      text,
      attachments,
      dedupeKey: msg.clientMessageId,
      source: 'user',
      metadata: resolvedProjectId ? { projectId: resolvedProjectId } : {},
    })
    if (msg.clientMessageId && res.inserted) {
      clientIdTracker.trackPrompt(res.eventId, msg.clientMessageId)
    }
    return {
      outcome: 'posted' as const,
      sessionId: session.id,
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
  runtime: VelaRuntime,
  request: Extract<Request, { method: 'stop' }>,
): Promise<boolean> {
  if (request.channel === 'local') {
    const bindings = await runtime.bindings.list({ channel: 'lark' })
    const target = resolveLocalTargetSession(
      request.target,
      await runtime.projects.list({ includeArchived: true }),
      await runtime.sessions.list({ includeArchived: true }),
      bindings,
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
    if (!request.target.chatId) return false
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
  runtime: VelaRuntime,
  input: { cwd: string; name?: string },
): Promise<LocalProject> {
  const rawCwd = typeof input.cwd === 'string' ? input.cwd.trim() : ''
  if (!rawCwd) throw new Error('Folder path is required')
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
  const inflight = locks.get(canonicalCwd)
  if (inflight) return inflight

  const opening = (async (): Promise<LocalProject> => {
    const bindings = await runtime.bindings.list({ channel: 'lark' })
    const larkProjectIds = getLarkProjectIds(bindings)
    const allProjects = await runtime.projects.list({ includeArchived: false })
    const existing = allProjects.find(
      (p) => p.cwd === canonicalCwd && !larkProjectIds.has(p.id),
    )
    if (existing) {
      return {
        id: existing.id,
        channel: 'local' as const,
        cwd: existing.cwd ?? canonicalCwd,
        name: existing.name,
      }
    }
    const trimmedName = input.name?.trim()
    const name = trimmedName || basename(canonicalCwd) || canonicalCwd
    const created = await runtime.projects.create({
      name,
      cwd: canonicalCwd,
      hubSessionId: false,
    })
    return {
      id: created.id,
      channel: 'local' as const,
      cwd: created.cwd ?? canonicalCwd,
      name: created.name,
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
