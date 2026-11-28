import type {
  Connection,
  Event,
  LarkSubmit,
  Message,
  Project,
  Session,
  SettingsState,
  SubmitReceipt,
} from '../shared/bridge.ts'
import type { SessionProgress } from './session/progress.ts'

type Progress = SessionProgress

export interface Snapshot {
  ready: boolean
  /** What Settings and the setup gate show; absent until the first read. */
  settings?: SettingsState
  projects: Project[]
  /** Every session the app hosts, by id. */
  sessions: Record<string, Session>
  /** Visible history per session id, loaded on demand. */
  messages: Record<string, Message[]>
  /** Latest progress per running session, from Local `progress` events. */
  progress: Record<string, Progress>
  /**
   * A failed run per session, shown as one card. `replyId` stays hidden while
   * the card is up and comes back if a newer run replaces it.
   */
  failures: Record<string, { message: string; replyId?: string }>
  /** Replies that repeat a failure the card already shows. */
  hidden: Record<string, true>
  /** The last status line a Lark topic recorded, by session id. */
  statuses: Record<string, string>
  /** Connection state per hosted channel. */
  connections: Record<string, Connection>
  /** Group/topic sessions with older history behind a cursor. */
  earlier: Record<string, true>
  /** The last action that failed, for the page to show. */
  error: string
}

export const initialSnapshot: Snapshot = {
  ready: false,
  projects: [],
  sessions: {},
  messages: {},
  progress: {},
  failures: {},
  hidden: {},
  statuses: {},
  connections: {},
  earlier: {},
  error: '',
}

export const withoutKey = <Value>(
  record: Record<string, Value>,
  key?: string,
) => {
  if (key === undefined || record[key] === undefined) return record
  const next = { ...record }
  delete next[key]
  return next
}

export const sessionMap = (sessions: Session[]) =>
  Object.fromEntries(sessions.map((session) => [session.sessionId, session]))

export const topicTitle = (text: string) =>
  text
    .split('\n')
    .find((line) => line.trim() !== '')
    ?.trim() ?? text.trim()

const larkNotice = (result: SubmitReceipt, place: string) => {
  const reason = result.error
    ? ` ${result.error.trim().replace(/\.$/, '')}.`
    : ''
  if (result.outcome === 'posted') {
    return `Vela posted it in the ${place}, but the rest of the submission failed.${reason} It did not send it again; check the ${place}.`
  }
  return `It may have been posted.${reason} Vela did not send it again; check the ${place} before sending.`
}

const byTime = (messages: Message[]) =>
  messages.toSorted((one, other) =>
    one.createdAt.localeCompare(other.createdAt),
  )

function isUncertainSubmitError(cause: unknown): boolean {
  const msg = cause instanceof Error ? cause.message : String(cause ?? '')
  return /Disconnected from Vela daemon|ECONNRESET|EPIPE|socket hang up|IPC/i.test(
    msg,
  )
}

const larkPlaceOf = (
  projects: readonly Project[],
  sessionId: string | undefined,
) =>
  sessionId !== undefined &&
  projects.some(
    (project) => project.channel === 'lark' && project.sessionId === sessionId,
  )
    ? 'group'
    : 'topic'

export async function submitLarkFlow(params: {
  input: LarkSubmit
  projects: readonly Project[]
  sessions: Record<string, Session>
  submit: Window['vela']['submit']
  fetchLarkSessions: (chatId: string) => Promise<Session[]>
  loadGroupPage: (
    project: Extract<Project, { channel: 'lark' }>,
  ) => Promise<string | undefined>
  loadTopicMessages: (sessionId: string) => Promise<string | undefined>
  mergeSessions: (sessions: Session[]) => void
  onAccepted?: (notice: string) => void
  report: (notice: string) => void
  formatError: (cause: unknown) => string
}): Promise<boolean> {
  const { input } = params
  try {
    const result = await params.submit('lark', input)
    if (result.outcome === 'not-sent') {
      params.report(result.error ?? 'Lark did not accept the message.')
      return false
    }
    const project = params.projects.find(
      (item): item is Extract<Project, { channel: 'lark' }> =>
        item.channel === 'lark' && item.id === input.chatId,
    )
    let refreshError: string | undefined
    if (project) {
      refreshError = await params.loadGroupPage(project)
      if ('sessionId' in input && params.sessions[input.sessionId]?.topic) {
        refreshError =
          (await params.loadTopicMessages(input.sessionId)) ?? refreshError
      }
      try {
        params.mergeSessions(await params.fetchLarkSessions(input.chatId))
      } catch (cause) {
        refreshError ??= params.formatError(cause)
      }
    }
    const notice = result.error
      ? larkNotice(
          result,
          'newTopic' in input
            ? 'group'
            : larkPlaceOf(params.projects, input.sessionId),
        )
      : (refreshError ?? '')
    if (params.onAccepted) params.onAccepted(notice)
    else params.report(notice)
    return true
  } catch (cause) {
    params.report(params.formatError(cause))
    return false
  }
}

function reloadAfterChannelReset(params: {
  snapshot: Snapshot
  visibleLocal?: { place: string; sessionId: string }
  visibleGroup?: Extract<Project, { channel: 'lark' }>
  visibleTopic?: {
    projectId: string
    session: Session
    report: (notice: string) => void
  }
  loadLocal: (place: string, sessionId: string) => Promise<unknown>
  loadGroupPage: (
    project: Extract<Project, { channel: 'lark' }>,
  ) => Promise<string | undefined>
  loadTopicMessages: (sessionId: string) => Promise<string | undefined>
  pageError: (view?: string) => (notice: string) => void
  isCurrentGroup: (id: string) => boolean
  isCurrentTopic: () => boolean
}): void {
  const { visibleLocal, visibleGroup, visibleTopic, snapshot } = params
  if (visibleLocal && snapshot.sessions[visibleLocal.sessionId]) {
    void params.loadLocal(visibleLocal.place, visibleLocal.sessionId)
  }
  if (visibleGroup) {
    const refreshedGroup = snapshot.projects.find(
      (item): item is Extract<Project, { channel: 'lark' }> =>
        item.channel === 'lark' && item.id === visibleGroup.id,
    )
    if (refreshedGroup) {
      const report = params.pageError(`project:${refreshedGroup.id}`)
      void params.loadGroupPage(refreshedGroup).then((error) => {
        if (error && params.isCurrentGroup(refreshedGroup.id)) report(error)
      })
    }
  }
  if (visibleTopic && snapshot.sessions[visibleTopic.session.sessionId]) {
    void params
      .loadTopicMessages(visibleTopic.session.sessionId)
      .then((error) => {
        if (error && params.isCurrentTopic()) visibleTopic.report(error)
      })
  }
}

export async function readDesktopFrame(
  api: Pick<
    Window['vela'],
    'channels' | 'projects' | 'sessions' | 'connection'
  >,
  formatError: (cause: unknown) => string,
) {
  const channels = await api.channels()
  const names = channels.map((channel) => channel.name)
  const projects = await api.projects()
  const sessions = [
    ...(names.includes('local') ? await api.sessions('local') : []),
    ...(names.includes('lark') ? await api.sessions('lark') : []),
  ]
  const connectionChannels =
    projects.some((p) => p.channel === 'lark') && !names.includes('lark')
      ? [...names, 'lark']
      : names
  const connections = Object.fromEntries(
    await Promise.all(
      connectionChannels.map(async (name) => {
        try {
          return [name, await api.connection(name)] as const
        } catch (cause) {
          return [
            name,
            { connected: false, error: formatError(cause) },
          ] as const
        }
      }),
    ),
  )
  return { projects, sessions, connections }
}

export function mergeSessionMessages(
  existingList: Message[],
  incoming: Message[],
): Message[] {
  if (incoming.length === 0) return existingList
  const merged = new Map<string, Message>()
  for (const message of existingList) merged.set(message.id, message)
  for (const message of incoming) {
    if (message.clientMessageId) {
      for (const [id, existing] of merged) {
        if (
          id !== message.id &&
          existing.clientMessageId === message.clientMessageId
        ) {
          merged.delete(id)
        }
      }
    }
    merged.set(message.id, message)
  }
  return byTime([...merged.values()])
}

export function reconcileLocalMessages(
  existingList: Message[],
  incoming: Message[],
  liveSinceReadStart?: ReadonlySet<string>,
): Message[] {
  if (incoming.length === 0) {
    return existingList.filter(
      (m) => m.id.startsWith('pending:') || liveSinceReadStart?.has(m.id),
    )
  }
  const incomingClientIds = new Set(
    incoming
      .map((m) => m.clientMessageId)
      .filter((id): id is string => Boolean(id)),
  )
  const existingNonPendingIds = new Set(
    existingList.filter((m) => !m.id.startsWith('pending:')).map((m) => m.id),
  )
  const newIncomingUsers = incoming.filter(
    (m) =>
      m.role === 'user' &&
      !m.clientMessageId &&
      !existingNonPendingIds.has(m.id),
  )
  const usedUserIndices = new Set<number>()
  const pendingUnmatched: Message[] = []
  for (const m of existingList) {
    if (!m.id.startsWith('pending:')) continue
    if (m.clientMessageId && incomingClientIds.has(m.clientMessageId)) {
      continue
    }
    if (m.role === 'user') {
      const trimmed = m.text.trim()
      const idx = newIncomingUsers.findIndex(
        (inc, i) =>
          !usedUserIndices.has(i) &&
          inc.text.trim() === trimmed &&
          inc.createdAt >= m.createdAt,
      )
      if (idx !== -1) {
        usedUserIndices.add(idx)
        continue
      }
    }
    pendingUnmatched.push(m)
  }
  const latestIncomingTime = incoming.at(-1)?.createdAt
  const incomingIds = new Set(incoming.map((m) => m.id))
  const newerLive = existingList.filter(
    (m) =>
      !m.id.startsWith('pending:') &&
      !incomingIds.has(m.id) &&
      (liveSinceReadStart?.has(m.id) ||
        (latestIncomingTime !== undefined && m.createdAt > latestIncomingTime)),
  )
  return byTime([...incoming, ...pendingUnmatched, ...newerLive])
}

export function applyLocalEventState(params: {
  value: Extract<Event, { type: 'local' }>['value']
  snapshot: Snapshot
  attempts: Map<string, { message: string; replyId?: string }>
  publish: (change: Partial<Snapshot>) => void
  mergeSessions: (sessions: Session[]) => void
  mergeMessages: (sessionId: string, incoming: Message[]) => void
  onSessionReset?: (sessionId: string) => void
}) {
  const {
    value,
    snapshot,
    attempts,
    publish,
    mergeSessions,
    mergeMessages,
    onSessionReset,
  } = params
  const sessionId = value.sessionId
  if (value.type === 'session') {
    mergeSessions([value.data])
    return
  }
  if (value.type === 'session_reset' && sessionId) {
    attempts.delete(sessionId)
    onSessionReset?.(sessionId)
    const shown = snapshot.failures[sessionId]
    publish({
      messages: withoutKey(snapshot.messages, sessionId),
      failures: withoutKey(snapshot.failures, sessionId),
      progress: withoutKey(snapshot.progress, sessionId),
      hidden: shown?.replyId
        ? withoutKey(snapshot.hidden, shown.replyId)
        : snapshot.hidden,
    })
    return
  }
  if (value.type === 'message') {
    const message = value.data
    const attempt = attempts.get(message.sessionId)
    if (message.role === 'assistant' && attempt && !attempt.replyId) {
      attempt.replyId = message.id
      publish({ hidden: { ...snapshot.hidden, [message.id]: true } })
    }
    mergeMessages(message.sessionId, [message])
    return
  }
  if (value.type === 'progress') {
    if (sessionId) {
      publish({ progress: { ...snapshot.progress, [sessionId]: value.data } })
    }
    return
  }
  if (value.type === 'run_started') {
    if (sessionId) attempts.delete(sessionId)
    const shown = sessionId ? snapshot.failures[sessionId] : undefined
    publish({
      progress: withoutKey(snapshot.progress, sessionId),
      failures: withoutKey(snapshot.failures, sessionId),
      hidden: shown?.replyId
        ? withoutKey(snapshot.hidden, shown.replyId)
        : snapshot.hidden,
    })
    return
  }
  if (value.type === 'run_finished') {
    const attempt = sessionId ? attempts.get(sessionId) : undefined
    if (sessionId) attempts.delete(sessionId)
    const finished = value.data.outcome === 'failed' && attempt !== undefined
    publish({
      progress: withoutKey(snapshot.progress, sessionId),
      failures: finished
        ? {
            ...snapshot.failures,
            [sessionId!]: {
              message: attempt.message,
              ...(attempt.replyId ? { replyId: attempt.replyId } : {}),
            },
          }
        : snapshot.failures,
      hidden:
        attempt?.replyId && !finished
          ? withoutKey(snapshot.hidden, attempt.replyId)
          : snapshot.hidden,
    })
    return
  }
  if (value.type === 'error' && sessionId) {
    const session = snapshot.sessions[sessionId]
    if (!session) return
    attempts.set(sessionId, { message: value.data.message })
  }
}

export type LocalSendOutcome = 'accepted' | 'rejected' | 'unknown'

export async function submitLocalFlow(params: {
  projectId: string | null
  sessionId: string
  text: string
  getSnapshot: () => Snapshot
  publish: (change: Partial<Snapshot>) => void
  mergeMessages: (sessionId: string, incoming: Message[]) => void
  onUnknown: (sessionId: string) => void
  submit: Window['vela']['submit']
  report: (notice: string) => void
  formatError: (cause: unknown) => string
}): Promise<LocalSendOutcome> {
  const { projectId, sessionId, text } = params
  const clientMessageId = crypto.randomUUID()
  params.mergeMessages(sessionId, [
    {
      id: `pending:${clientMessageId}`,
      sessionId,
      role: 'user',
      text,
      createdAt: new Date().toISOString(),
      clientMessageId,
    },
  ])
  try {
    await params.submit('local', {
      projectId,
      sessionId,
      text,
      clientMessageId,
    })
    params.report('')
    return 'accepted'
  } catch (cause) {
    if (isUncertainSubmitError(cause)) {
      params.onUnknown(sessionId)
      params.report(params.formatError(cause))
      return 'unknown'
    }
    const current = params.getSnapshot()
    params.publish({
      messages: {
        ...current.messages,
        [sessionId]: (current.messages[sessionId] ?? []).filter(
          (message) => message.clientMessageId !== clientMessageId,
        ),
      },
    })
    params.report(params.formatError(cause))
    return 'rejected'
  }
}

export function syncVisibleLarkState(params: {
  visibleGroup?: Extract<Project, { channel: 'lark' }>
  visibleTopic?: {
    projectId: string
    session: Session
    report: (notice: string) => void
  }
  fetchLarkSessions: (chatId: string) => Promise<Session[]>
  loadGroupPage: (
    project: Extract<Project, { channel: 'lark' }>,
  ) => Promise<string | undefined>
  loadTopicMessages: (sessionId: string) => Promise<string | undefined>
  mergeSessions: (sessions: Session[]) => void
  pageError: (view?: string) => (notice: string) => void
  isCurrentGroup: (id: string) => boolean
  isCurrentTopic: (topic: {
    projectId: string
    session: Session
    report: (notice: string) => void
  }) => boolean
}): void {
  const { visibleGroup, visibleTopic } = params
  if (visibleGroup) {
    const report = params.pageError(`project:${visibleGroup.id}`)
    void params
      .fetchLarkSessions(visibleGroup.id)
      .then((sessions) => params.mergeSessions(sessions))
      .catch(() => {})
    void params.loadGroupPage(visibleGroup).then((error) => {
      if (error && params.isCurrentGroup(visibleGroup.id)) report(error)
    })
  }
  if (visibleTopic) {
    void params
      .loadTopicMessages(visibleTopic.session.sessionId)
      .then((error) => {
        if (error && params.isCurrentTopic(visibleTopic)) {
          visibleTopic.report(error)
        }
      })
  }
}

export function applyChannelEventState(params: {
  channel: string
  value: Extract<Event, { type: 'channel' }>['value']
  getSnapshot: () => Snapshot
  publish: (change: Partial<Snapshot>) => void
  invalidateAllLocalHistory: () => void
  clearLarkCursors: () => void
  refresh: () => Promise<void>
  visibleLocal?: { place: string; sessionId: string }
  visibleGroup?: Extract<Project, { channel: 'lark' }>
  visibleTopic?: {
    projectId: string
    session: Session
    report: (notice: string) => void
  }
  loadLocal: (place: string, sessionId: string) => Promise<unknown>
  loadGroupPage: (
    project: Extract<Project, { channel: 'lark' }>,
  ) => Promise<string | undefined>
  loadTopicMessages: (sessionId: string) => Promise<string | undefined>
  fetchLarkSessions: (chatId: string) => Promise<Session[]>
  mergeSessions: (sessions: Session[]) => void
  pageError: (view?: string) => (notice: string) => void
  isCurrentGroup: (id: string) => boolean
  isCurrentTopic: (topic: {
    projectId: string
    session: Session
    report: (notice: string) => void
  }) => boolean
}): void {
  const { channel, value } = params
  const snapshot = params.getSnapshot()
  if (channel === 'local' && value.type === 'channel_status') {
    const prevConnected = snapshot.connections.local?.connected
    params.publish({
      connections: {
        ...snapshot.connections,
        local: {
          connected: value.connected,
          ...(value.error ? { error: value.error } : {}),
        },
      },
    })
    if (!value.connected && value.error) {
      params.publish({ error: value.error })
    } else if (value.connected && prevConnected === false && snapshot.error) {
      params.publish({ error: '' })
    }
  }
  const reset = value.type === 'channel_status' && value.reset === true
  if (reset) {
    params.invalidateAllLocalHistory()
    params.clearLarkCursors()
    const { visibleLocal, visibleGroup, visibleTopic } = params
    void params.refresh().then(() => {
      reloadAfterChannelReset({
        snapshot: params.getSnapshot(),
        visibleLocal,
        visibleGroup,
        visibleTopic,
        loadLocal: params.loadLocal,
        loadGroupPage: params.loadGroupPage,
        loadTopicMessages: params.loadTopicMessages,
        pageError: params.pageError,
        isCurrentGroup: params.isCurrentGroup,
        isCurrentTopic: () =>
          visibleTopic !== undefined && params.isCurrentTopic(visibleTopic),
      })
    })
    return
  }
  if (channel !== 'lark' || value.type === 'channel_status') return

  const chatId =
    value.type === 'channel_history_changed' ? value.chatId : undefined
  const targetSessionId =
    value.type === 'channel_history_changed' ? value.sessionId : undefined

  const group = params.visibleGroup
  if (group && chatId === group.id) {
    const report = params.pageError(`project:${group.id}`)
    void params.loadGroupPage(group).then((error) => {
      if (error && params.isCurrentGroup(group.id)) report(error)
    })
  }

  const topic = params.visibleTopic
  if (
    topic &&
    chatId === topic.projectId &&
    targetSessionId === topic.session.sessionId
  ) {
    void params.loadTopicMessages(topic.session.sessionId).then((error) => {
      if (error && params.isCurrentTopic(topic)) topic.report(error)
    })
  }
}
