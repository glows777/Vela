import { useSyncExternalStore } from 'react'
import type { Event, Message, Project, Session } from '../shared/bridge.ts'
import { vela } from './vela.ts'

export interface Snapshot {
  ready: boolean
  projects: Project[]
  /** Every Local session, by id. One project chat plus one session per started task. */
  sessions: Record<string, Session>
  /** Visible history per session id, loaded on demand. */
  messages: Record<string, Message[]>
  /** The last action that failed, for the page to show. */
  error: string
}

const initial: Snapshot = {
  ready: false,
  projects: [],
  sessions: {},
  messages: {},
  error: '',
}
let snapshot = initial
const listeners = new Set<() => void>()
let starting: Promise<void> | undefined
/** Sessions whose whole history is already in the snapshot. */
const complete = new Set<string>()
const loading = new Set<string>()

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
export const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

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

/**
 * One forward page walks the whole history: the host has no "latest N" cursor, so a
 * conversation is read in full once per app run and then kept by the event stream.
 * `firstOnly` reads the title message that anchors a session card.
 */
async function loadMessages(
  projectId: string,
  sessionId: string,
  firstOnly = false,
) {
  const key = `${projectId}/${sessionId}`
  if (
    firstOnly
      ? (snapshot.messages[sessionId] ?? []).length > 0
      : complete.has(key)
  )
    return
  if (loading.has(key)) return
  loading.add(key)
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
    if (!firstOnly) complete.add(key)
  } catch (cause) {
    publish({ error: errorMessage(cause) })
  } finally {
    loading.delete(key)
  }
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
    const [projects, sessions] = await Promise.all([
      vela.projects(),
      vela.sessions('local'),
    ])
    publish({
      ready: true,
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

export async function openProject(input: { cwd: string; name?: string }) {
  const project = await vela.openProject(input)
  await reload()
  await loadProject(project.id)
  return project
}

export async function send(projectId: string, sessionId: string, text: string) {
  const body = text.trim()
  if (!body) return
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
  }
}

function apply(value: Extract<Event, { type: 'local' }>['value']) {
  if (value.type === 'session') {
    mergeSessions([value.data])
    if (
      value.data.topic &&
      value.projectId &&
      (snapshot.messages[value.data.sessionId] ?? []).length === 0
    )
      void loadMessages(value.projectId, value.data.sessionId, true)
  } else if (value.type === 'message') {
    mergeMessages(value.data.sessionId, [value.data])
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
