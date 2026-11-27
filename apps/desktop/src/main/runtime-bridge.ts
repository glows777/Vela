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
  Request,
  Session,
} from '../shared/bridge.ts'

export type BridgedMessage = {
  id: string
  sessionId: string
  runId: string | null
  kind: string
  role: 'user' | 'assistant' | 'tool' | 'system' | null
  text: string
  content: unknown
  senderName?: string
  display?: boolean
  createdAt: string
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
): SessionOwnership | undefined {
  const direct = bindings.find(
    (b) => b.channel === 'lark' && b.sessionId === session.id,
  )
  if (direct) {
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
    if (root) {
      return {
        channel: 'lark',
        chatId: root.externalId,
        chatKind: root.kind,
        ...(session.kind === 'topic' || session.kind === 'work'
          ? { topic: { rootId: session.id, threadId: session.id } }
          : {}),
      }
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

export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('\n')
}

export function toDesktopMessage(
  msg: BridgedMessage,
  clientMessageId?: string,
): Message | undefined {
  if (msg.role === 'tool' || !msg.role) return undefined
  if (msg.role === 'system' && msg.display !== true) return undefined
  if (msg.kind === 'custom_message' && msg.display !== true) return undefined
  if (!msg.text && msg.role === 'assistant') return undefined
  return {
    id: msg.id,
    sessionId: msg.sessionId,
    role: msg.role,
    text: msg.text,
    createdAt: msg.createdAt,
    ...(msg.senderName ? { senderName: msg.senderName } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
  }
}

function formatFailedTaskReply(error: string, errorHint?: string): string {
  return errorHint
    ? `Task failed: ${error}\n\n${errorHint}`
    : `Task failed: ${error}`
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

function resolveLocalTargetSession(
  target: { chatId: string; rootId?: string },
  projects: readonly ProjectRecord[],
  sessions: readonly SessionRecord[],
): SessionRecord | undefined {
  if (target.rootId) {
    return sessions.find((s) => s.id === target.rootId)
  }
  const project = projects.find((p) => p.id === target.chatId)
  if (project?.hubSessionId) {
    return sessions.find((s) => s.id === project.hubSessionId)
  }
  return sessions.find((s) => s.id === target.chatId)
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

export async function submitDesktopMessage(
  runtime: LocalVelaRuntime,
  loadLark: boolean,
  pendingClientIds: Map<string, { text: string; clientMessageId: string }[]>,
  request: Extract<Request, { method: 'submit' }>,
) {
  if (request.channel === 'local' && 'projectId' in request.message) {
    const { projectId, sessionId, clientMessageId } = request.message
    const text = validateLocalText(request.message.text)
    if (clientMessageId) {
      const queue = pendingClientIds.get(sessionId) ?? []
      queue.push({ text, clientMessageId })
      pendingClientIds.set(sessionId, queue)
    }
    const res = await runtime.prompt(sessionId, {
      text,
      dedupeKey: clientMessageId,
      source: 'user',
      metadata: { projectId },
    })
    return {
      outcome: 'posted' as const,
      sessionId,
      messageId: res.eventId,
    }
  }
  if (request.channel === 'local' && 'channelId' in request.message) {
    const msg = request.message
    const text = validateLocalText(msg.text)
    const project = await runtime.projects.get(msg.channelId)
    const sessionId =
      msg.topic?.threadId ?? project?.hubSessionId ?? msg.channelId
    const attachments = msg.images?.length
      ? await Promise.all(
          msg.images.map(async (img, i) => {
            const ext = img.mimeType.split('/')[1] || 'png'
            const blob = await runtime.blobs.storeInbound({
              sessionId,
              projectId: project?.id ?? null,
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
    const target = resolveLocalTargetSession(
      request.target,
      await runtime.projects.list({ includeArchived: true }),
      await runtime.sessions.list({ includeArchived: true }),
    )
    if (!target) return false
    const status = await runtime.sessions
      .status(target.id)
      .catch(() => undefined)
    if (!status?.activeRunId || status.activeRunId !== request.runId) {
      return false
    }
    return runtime.stop(target.id, 'Stopped by user')
  }
  if (request.channel === 'lark') {
    const bindings = await runtime.bindings.list({ channel: 'lark' })
    const binding = request.target.rootId
      ? bindings.find(
          (b) =>
            b.externalId === request.target.chatId &&
            (b.threadId === request.target.rootId ||
              b.config?.rootId === request.target.rootId),
        )
      : bindings.find(
          (b) => b.externalId === request.target.chatId && !b.threadId,
        )
    const sessionId =
      binding?.sessionId ??
      (binding?.projectId
        ? (await runtime.projects.get(binding.projectId))?.hubSessionId
        : undefined)
    if (!sessionId) return false
    const status = await runtime.sessions
      .status(sessionId)
      .catch(() => undefined)
    if (!status?.activeRunId || status.activeRunId !== request.runId) {
      return false
    }
    return runtime.stop(sessionId, 'Stopped by user')
  }
  return false
}

export async function openLocalDesktopProject(
  runtime: LocalVelaRuntime,
  input: Extract<Request, { method: 'openProject' }>['input'],
  larkProjectIds: ReadonlySet<string>,
) {
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
  const existing = await runtime.projects.getByCwd(canonicalCwd)
  if (existing && !larkProjectIds.has(existing.id) && existing.hubSessionId) {
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
}

export async function fetchLocalDesktopMessages(
  runtime: LocalVelaRuntime,
  input: Extract<Request, { method: 'messages' }>['input'],
  clientIdsByMessage: ReadonlyMap<string, string>,
): Promise<{ messages: Message[]; nextCursor?: string }> {
  const collected: Message[] = []
  let hasMoreVisible = false
  let lastCollectedSeq: number | undefined
  let cursor = input.after
  const want = input.limit ?? 100
  while (collected.length <= want) {
    const page = await runtime.sessions.messages({
      sessionId: input.sessionId,
      cursor,
      limit: Math.max(want - collected.length + 1, 20),
    })
    for (const row of page.messages) {
      const mapped = toDesktopMessage(row, clientIdsByMessage.get(row.id))
      if (!mapped) continue
      if (collected.length < want) {
        collected.push(mapped)
        lastCollectedSeq = row.seq
      } else {
        hasMoreVisible = true
        break
      }
    }
    if (hasMoreVisible || !page.nextCursor) break
    cursor = page.nextCursor
  }
  if (!input.after && !hasMoreVisible && collected.length < want) {
    const events = await runtime.events
      .list({ sessionId: input.sessionId, limit: 200 })
      .catch(() => [])
    const existingIds = new Set(collected.map((m) => m.id))
    for (const evt of events) {
      if (
        evt.type === 'run_finished' &&
        (evt.status === 'failed' || evt.status === 'interrupted') &&
        evt.error &&
        !existingIds.has(`failed-${evt.runId}`)
      ) {
        collected.push({
          id: `failed-${evt.runId}`,
          sessionId: input.sessionId,
          role: 'assistant',
          text: formatFailedTaskReply(evt.error, evt.errorHint),
          createdAt: evt.timestamp,
        })
        if (collected.length >= want) break
      }
    }
    collected.sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt.localeCompare(b.createdAt),
    )
  }
  return {
    messages: collected,
    ...(hasMoreVisible && lastCollectedSeq !== undefined
      ? { nextCursor: `db:${lastCollectedSeq}` }
      : {}),
  }
}

export async function fetchLarkDesktopMessages(
  runtime: LocalVelaRuntime,
  input: Extract<Request, { method: 'larkMessages' }>['input'],
): Promise<{ messages: Message[]; nextCursor?: string }> {
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
