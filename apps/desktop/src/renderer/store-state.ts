import type {
  Connection,
  Event,
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

export const larkNotice = (result: SubmitReceipt, place: string) => {
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
