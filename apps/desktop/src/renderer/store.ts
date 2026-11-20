import { useSyncExternalStore } from 'react'
import type {
  Event,
  Message,
  ModelSetup,
  Project,
  Session,
  SettingsState,
} from '../shared/bridge.ts'
import { vela } from './vela.ts'

/** The last progress a session reported while it ran. */
type Progress = {
  stage: 'tool' | 'retry' | 'compaction'
  tool?: string
  state?: 'started' | 'finished' | 'failed'
}

export interface Snapshot {
  ready: boolean
  /** What Settings and the setup gate show; absent until the first read. */
  settings?: SettingsState
  projects: Project[]
  /** Every Local session, by id. One project chat plus one session per started task. */
  sessions: Record<string, Session>
  /** Visible history per session id, loaded on demand. */
  messages: Record<string, Message[]>
  /** Latest progress per running session, from the Local `progress` events. */
  progress: Record<string, Progress>
  /**
   * A failed run per session, shown as one card. `replyId` is the recorded reply the
   * channel wrote for that run; it stays hidden while the card is up and comes back
   * when the card goes, so the failure is never lost or said twice.
   */
  failures: Record<string, { message: string; replyId?: string }>
  /** Replies that repeat a failure the card already shows. */
  hidden: Record<string, true>
  /** The last action that failed, for the page to show. */
  error: string
}

const initial: Snapshot = {
  ready: false,
  projects: [],
  sessions: {},
  messages: {},
  progress: {},
  failures: {},
  hidden: {},
  error: '',
}
let snapshot = initial
const listeners = new Set<() => void>()
let starting: Promise<void> | undefined
/**
 * The error a live run reported and the reply it wrote, until `run_finished` says
 * whether that run failed. Only a started session has a card to show it in.
 */
const attempts = new Map<string, { message: string; replyId?: string }>()
/** Sessions whose whole history is already in the snapshot. */
const complete = new Set<string>()
/** The read in flight per session, so a full read can queue behind a title read. */
const loading = new Map<string, Promise<boolean>>()

const publish = (change: Partial<Snapshot>) => {
  snapshot = { ...snapshot, ...change }
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const current = () => snapshot
export const useStore = () => useSyncExternalStore(subscribe, current)
/** A bridge failure without Electron's transport wording; the reason is what the person needs. */
export const errorMessage = (cause: unknown) =>
  (cause instanceof Error ? cause.message : String(cause)).replace(
    /^Error invoking remote method '[^']*': *([A-Za-z]*Error: )?/,
    '',
  )

const byTime = (messages: Message[]) =>
  messages.sort((one, other) =>
    one.createdAt === other.createdAt
      ? one.id.localeCompare(other.id)
      : one.createdAt.localeCompare(other.createdAt),
  )

/** Adds new messages, replaces an optimistic bubble with its recorded copy, and keeps time order. */
function mergeMessages(sessionId: string, incoming: Message[]) {
  const merged = new Map(
    (snapshot.messages[sessionId] ?? []).map((message) => [
      message.id,
      message,
    ]),
  )
  for (const message of incoming) {
    if (message.clientMessageId)
      for (const [id, existing] of merged)
        if (
          id !== message.id &&
          existing.clientMessageId === message.clientMessageId
        )
          merged.delete(id)
    merged.set(message.id, message)
  }
  publish({
    messages: {
      ...snapshot.messages,
      [sessionId]: byTime([...merged.values()]),
    },
  })
}

function mergeSessions(sessions: Session[]) {
  const merged = { ...snapshot.sessions }
  for (const session of sessions) merged[session.sessionId] = session
  publish({ sessions: merged })
}

/** One forward page walk: true when the read returned the history it asked for. */
async function readHistory(
  projectId: string,
  sessionId: string,
  firstOnly: boolean,
) {
  try {
    const collected: Message[] = []
    let after: string | undefined
    do {
      const page = await vela.messages({
        projectId,
        sessionId,
        after,
        limit: firstOnly ? 1 : 100,
      })
      collected.push(...page.messages)
      after = firstOnly ? undefined : page.nextCursor
      if (page.messages.length === 0) break
    } while (after)
    mergeMessages(sessionId, collected)
    return true
  } catch (cause) {
    publish({ error: errorMessage(cause) })
    return false
  }
}

/**
 * One forward page walks the whole history: the host has no "latest N" cursor, so a
 * conversation is read in full once per app run and then kept by the event stream.
 * `firstOnly` reads the title message that anchors a session card.
 *
 * A session card is read as a title first and in full when it opens. Those two reads
 * can overlap — the panel opens while `loadProject` is still fetching titles — and the
 * full read must wait for the title read rather than be dropped, which would leave the
 * session showing only its title.
 */
async function loadMessages(
  projectId: string,
  sessionId: string,
  firstOnly = false,
) {
  const key = `${projectId}/${sessionId}`
  const ready = () =>
    firstOnly
      ? (snapshot.messages[sessionId] ?? []).length > 0
      : complete.has(key)
  while (!ready()) {
    const pending = loading.get(key)
    if (pending) {
      if (firstOnly) return
      await pending
      continue
    }
    const read = readHistory(projectId, sessionId, firstOnly)
      .then((done) => {
        if (done && !firstOnly) complete.add(key)
        return done
      })
      .finally(() => {
        if (loading.get(key) === read) loading.delete(key)
      })
    loading.set(key, read)
    if (!(await read) || firstOnly) return
  }
}

/** Reads one session's whole history; the panel needs it when a session opens. */
export function loadSession(projectId: string, sessionId: string) {
  void loadMessages(projectId, sessionId)
}

/** Reads the project chat and the first message of every started session, which anchors its card. */
export async function loadProject(projectId: string) {
  try {
    const sessions = await vela.sessions('local', projectId)
    mergeSessions(sessions)
    const project = snapshot.projects.find((item) => item.id === projectId)
    if (!project) return
    await loadMessages(projectId, project.sessionId)
    for (const session of sessions)
      if (session.topic) await loadMessages(projectId, session.sessionId, true)
  } catch (cause) {
    publish({ error: errorMessage(cause) })
  }
}

async function reload() {
  try {
    const [settings, projects, sessions] = await Promise.all([
      vela.settings(),
      vela.projects(),
      vela.sessions('local'),
    ])
    publish({
      ready: true,
      settings,
      projects,
      sessions: Object.fromEntries(
        sessions.map((session) => [session.sessionId, session]),
      ),
      error: '',
    })
  } catch (cause) {
    publish({ error: errorMessage(cause) })
  }
}

/** Checks and saves a model choice; a failed check throws its reason. */
export async function saveModel(input: ModelSetup): Promise<SettingsState> {
  const settings = await vela.saveModel(input)
  publish({ settings })
  return settings
}

export async function openProject(input: { cwd: string; name?: string }) {
  const project = await vela.openProject(input)
  await reload()
  await loadProject(project.id)
  return project
}

/** True when the host accepted the message; a draft stays restorable on false. */
export async function send(
  projectId: string,
  sessionId: string,
  text: string,
): Promise<boolean> {
  const body = text.trim()
  if (!body) return false
  const clientMessageId = crypto.randomUUID()
  mergeMessages(sessionId, [
    {
      id: `pending:${clientMessageId}`,
      sessionId,
      role: 'user',
      text: body,
      createdAt: new Date().toISOString(),
      clientMessageId,
    },
  ])
  try {
    await vela.submit('local', {
      projectId,
      sessionId,
      text: body,
      clientMessageId,
    })
    publish({ error: '' })
    return true
  } catch (cause) {
    publish({
      messages: {
        ...snapshot.messages,
        [sessionId]: (snapshot.messages[sessionId] ?? []).filter(
          (message) => message.clientMessageId !== clientMessageId,
        ),
      },
      error: errorMessage(cause),
    })
    return false
  }
}

const withoutKey = <Value>(record: Record<string, Value>, key?: string) => {
  if (key === undefined || record[key] === undefined) return record
  const next = { ...record }
  delete next[key]
  return next
}

function apply(value: Extract<Event, { type: 'local' }>['value']) {
  const sessionId = value.sessionId
  if (value.type === 'session') {
    mergeSessions([value.data])
    if (
      value.data.topic &&
      value.projectId &&
      (snapshot.messages[value.data.sessionId] ?? []).length === 0
    )
      void loadMessages(value.projectId, value.data.sessionId, true)
    return
  }
  if (value.type === 'message') {
    const message = value.data
    const attempt = attempts.get(message.sessionId)
    // The reply recorded for a failed run would say the card's message twice; hide
    // it now and keep it hidden only if the run really fails.
    if (message.role === 'assistant' && attempt && !attempt.replyId) {
      attempt.replyId = message.id
      publish({ hidden: { ...snapshot.hidden, [message.id]: true } })
    }
    mergeMessages(message.sessionId, [message])
    return
  }
  if (value.type === 'progress') {
    if (sessionId)
      publish({ progress: { ...snapshot.progress, [sessionId]: value.data } })
    return
  }
  if (value.type === 'run_started') {
    if (sessionId) attempts.delete(sessionId)
    const shown = sessionId ? snapshot.failures[sessionId] : undefined
    publish({
      progress: withoutKey(snapshot.progress, sessionId),
      failures: withoutKey(snapshot.failures, sessionId),
      // The next run replaces the card, so the reply it was standing in for returns.
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
      // A run that ends any other way keeps its reply.
      hidden:
        attempt?.replyId && !finished
          ? withoutKey(snapshot.hidden, attempt.replyId)
          : snapshot.hidden,
    })
    return
  }
  if (value.type === 'error' && sessionId) {
    const session = snapshot.sessions[sessionId]
    if (!session?.topic) return
    attempts.set(sessionId, { message: value.data.message })
  }
}

/** Stops the run this session is in, if it still has one. */
export async function stop(session: Session) {
  if (!session.runId) return
  try {
    await vela.stop(
      'local',
      {
        chatId: session.chatId,
        ...(session.topic ? { rootId: session.topic.rootId } : {}),
      },
      session.runId,
    )
  } catch (cause) {
    publish({ error: errorMessage(cause) })
  }
}

/** Subscribes once and reads the recorded projects and sessions. Safe to call on every mount. */
export async function start() {
  starting ??= (async () => {
    vela.onEvent((event) => {
      if (event.type === 'local') apply(event.value)
    })
    await reload()
  })()
  return starting
}

/** Refresh the Local frame and the settings after the main process replaces the host. */
export async function saveLark(input: Parameters<typeof vela.saveLark>[0]) {
  try {
    publish({ settings: await vela.saveLark(input) })
  } finally {
    await reload()
  }
}
