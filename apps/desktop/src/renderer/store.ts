import { useSyncExternalStore } from 'react'
import type {
  Connection,
  Event,
  LarkSubmit,
  Message,
  ModelSetup,
  Project,
  Session,
  SettingsState,
  SubmitReceipt,
} from '../shared/bridge.ts'
import { errorMessage } from './errors.ts'
import { larkHistory } from './lark-history.ts'
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
  /** Every session the app hosts, by id. One project chat plus one session per started task. */
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
  /** The last status line a Lark topic recorded, by session id. */
  statuses: Record<string, string>
  /** Connection state per hosted channel. */
  connections: Record<string, Connection>
  /** Group sessions with older history behind a cursor. */
  earlier: Record<string, true>
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
  statuses: {},
  connections: {},
  earlier: {},
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
/** Sessions whose whole Local history is already in the snapshot. */
const complete = new Set<string>()
/** The read in flight per session, so a full read can queue behind a title read. */
const loading = new Map<string, Promise<boolean>>()
/**
 * Lark history paging, with the messages this page shows as its only state: the reads
 * are authoritative for the range they cover and a cursor is the only sign a sequence
 * continues.
 */
const history = larkHistory({
  shown: (sessionId) => snapshot.messages[sessionId] ?? [],
  set: (sessionId, messages) =>
    publish({ messages: { ...snapshot.messages, [sessionId]: messages } }),
  mark: (sessionId, hasOlder) =>
    publish({
      earlier: hasOlder
        ? { ...snapshot.earlier, [sessionId]: true }
        : withoutKey(snapshot.earlier, sessionId),
    }),
  read: (input) => vela.larkMessages(input),
})

const publish = (change: Partial<Snapshot>) => {
  snapshot = { ...snapshot, ...change }
  for (const listener of listeners) listener()
}
let errorView = 'home'
let viewGeneration = 0

export function dismissPageError() {
  if (snapshot.error) publish({ error: '' })
}

export function setErrorView(view: string) {
  if (view === errorView) return
  errorView = view
  viewGeneration++
  dismissPageError()
}

/** Capture the page before the operation can outlive it. */
function pageError(view = errorView) {
  const generation = viewGeneration
  return (error: string) => {
    if (view === errorView && generation === viewGeneration) publish({ error })
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const current = () => snapshot
export const useStore = () => useSyncExternalStore(subscribe, current)
export { errorMessage } from './errors.ts'

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

const withoutKey = <Value>(record: Record<string, Value>, key?: string) => {
  if (key === undefined || record[key] === undefined) return record
  const next = { ...record }
  delete next[key]
  return next
}

/** One forward page walk: true when the read returned the history it asked for. */
async function readHistory(
  projectId: string,
  sessionId: string,
  firstOnly: boolean,
) {
  const report = pageError(`project:${projectId}`)
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
    report(errorMessage(cause))
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

let visibleLarkGroup: Project | undefined
let visibleLarkTopic: { projectId: string; session: Session } | undefined

/** Only the mounted group page receives automatic history refreshes. */
export function watchLarkProject(project: Project) {
  if (project.channel !== 'lark') return
  visibleLarkGroup = project
  return () => {
    if (visibleLarkGroup === project) visibleLarkGroup = undefined
  }
}

/** Reads one session's whole history; the panel needs it when a session opens. */
export function loadSession(projectId: string, sessionId: string) {
  const project = snapshot.projects.find((item) => item.id === projectId)
  const session = snapshot.sessions[sessionId]
  if (project?.channel !== 'lark' || session?.channel !== 'lark') {
    void loadMessages(projectId, sessionId)
    return
  }
  const topic = { projectId, session }
  visibleLarkTopic = topic
  const report = pageError(`project:${projectId}`)
  void history.loadTopic(projectId, session).then((error) => {
    if (error && visibleLarkTopic === topic) report(error)
  })
  return () => {
    if (visibleLarkTopic === topic) visibleLarkTopic = undefined
  }
}

/** Reads the project chat and the first message of every started session, which anchors its card. */
export async function loadProject(projectId: string) {
  const report = pageError(`project:${projectId}`)
  const project = snapshot.projects.find((item) => item.id === projectId)
  if (!project) return
  if (project.channel === 'lark') {
    if (snapshot.connections.lark?.connected !== true) return
    try {
      mergeSessions(await vela.sessions('lark', project.id))
    } catch (cause) {
      report(errorMessage(cause))
      return
    }
    const error = await history.load(project)
    if (error) report(error)
    return
  }
  try {
    const sessions = await vela.sessions('local', projectId)
    mergeSessions(sessions)
    await loadMessages(projectId, project.sessionId)
    for (const session of sessions)
      if (session.topic) await loadMessages(projectId, session.sessionId, true)
  } catch (cause) {
    report(errorMessage(cause))
  }
}

/** One older page of a Lark group's history. */
export function loadEarlierLark(project: Project) {
  const report = pageError(`project:${project.id}`)
  void history.load(project, true).then((error) => {
    if (error) report(error)
  })
}

const connectionFor = async (channel: string): Promise<Connection> => {
  try {
    return await vela.connection(channel)
  } catch (cause) {
    return { connected: false, error: errorMessage(cause) }
  }
}

/** What the frame shows: hosted channels, their connections, projects and sessions. */
async function readFrame() {
  const channels = await vela.channels()
  const names = channels.map((channel) => channel.name)
  const projects = await vela.projects()
  const sessions = [
    ...(names.includes('local') ? await vela.sessions('local') : []),
    ...(names.includes('lark') ? await vela.sessions('lark') : []),
  ]
  const connections = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await connectionFor(name)] as const),
    ),
  )
  return { projects, sessions, connections }
}

const sessionMap = (sessions: Session[]) =>
  Object.fromEntries(sessions.map((session) => [session.sessionId, session]))

/** Re-reads the frame after a channel connects or drops. */
async function refresh() {
  const report = pageError()
  try {
    const { projects, sessions, connections } = await readFrame()
    publish({
      projects,
      sessions: sessionMap(sessions),
      connections,
    })
  } catch (cause) {
    report(errorMessage(cause))
  }
}

async function reload() {
  const report = pageError()
  try {
    const [settings, frame] = await Promise.all([vela.settings(), readFrame()])
    publish({
      ready: true,
      settings,
      projects: frame.projects,
      sessions: sessionMap(frame.sessions),
      connections: frame.connections,
    })
    report('')
  } catch (cause) {
    report(errorMessage(cause))
  }
}

/** Checks and saves a model choice; a failed check throws its reason. */
export async function saveModel(input: ModelSetup): Promise<SettingsState> {
  const settings = await vela.saveModel(input)
  publish({ settings })
  return settings
}

export async function confirmLarkGroup(chatId: string) {
  await vela.confirmLarkGroup()
  const projects = await vela.projects()
  publish({ projects })
  const project = projects.find(
    (project) => project.channel === 'lark' && project.id === chatId,
  )
  if (!project)
    throw new Error(
      'Group saved, but it is missing from the active Lark configuration.',
    )
  return project
}

export async function openProject(input: { cwd: string; name?: string }) {
  const project = await vela.openProject(input)
  await reload()
  await loadProject(project.id)
  return project
}

/** A Local submission: the optimistic bubble is replaced by the recorded copy. */
async function sendLocal(
  projectId: string,
  sessionId: string,
  text: string,
): Promise<boolean> {
  const report = pageError()
  const clientMessageId = crypto.randomUUID()
  mergeMessages(sessionId, [
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
    await vela.submit('local', {
      projectId,
      sessionId,
      text,
      clientMessageId,
    })
    report('')
    return true
  } catch (cause) {
    publish({
      messages: {
        ...snapshot.messages,
        [sessionId]: (snapshot.messages[sessionId] ?? []).filter(
          (message) => message.clientMessageId !== clientMessageId,
        ),
      },
    })
    report(errorMessage(cause))
    return false
  }
}

/** Whether a Lark submission went to the group's own chat rather than a topic. */
const placeOf = (sessionId: string | undefined) =>
  sessionId !== undefined &&
  snapshot.projects.some(
    (project) => project.channel === 'lark' && project.sessionId === sessionId,
  )
    ? 'group'
    : 'topic'

/**
 * A group message that is not a plain `posted` receipt may still be in Lark. Those
 * are re-read and reported, never retried: only `not-sent` gives the draft back.
 */
const larkNotice = (result: SubmitReceipt, place: string) => {
  const reason = result.error
    ? ` ${result.error.trim().replace(/\.$/, '')}.`
    : ''
  if (result.outcome === 'posted')
    return `Vela posted it in the ${place}, but the rest of the submission failed.${reason} It did not send it again; check the ${place}.`
  return `It may have been posted.${reason} Vela did not send it again; check the ${place} before sending.`
}

async function submitLark(input: LarkSubmit): Promise<boolean> {
  const report = pageError()
  try {
    const result = await vela.submit('lark', input)
    if (result.outcome === 'not-sent') {
      report(result.error ?? 'Lark did not accept the message.')
      return false
    }
    const project = snapshot.projects.find(
      (item) => item.channel === 'lark' && item.id === input.chatId,
    )
    let refreshError: string | undefined
    if (project) {
      refreshError = await history.load(project)
      if ('sessionId' in input) {
        const session = snapshot.sessions[input.sessionId]
        if (session?.topic)
          refreshError =
            (await history.loadTopic(input.chatId, session)) ?? refreshError
      }
      try {
        mergeSessions(await vela.sessions('lark', input.chatId))
      } catch (cause) {
        refreshError ??= errorMessage(cause)
      }
    }
    // The three-state notice is what the person must see; a failed re-read comes next.
    report(
      result.error
        ? larkNotice(
            result,
            'newTopic' in input ? 'group' : placeOf(input.sessionId),
          )
        : (refreshError ?? ''),
    )
    return true
  } catch (cause) {
    report(errorMessage(cause))
    return false
  }
}

/** The title a new topic's first message uses: the question's first line. */
const topicTitle = (text: string) =>
  text
    .split('\n')
    .find((line) => line.trim() !== '')
    ?.trim() ?? text.trim()

/** A message in the project chat; in a Lark project it posts in the group. */
export async function sendInProject(project: Project, text: string) {
  const body = text.trim()
  if (!body) return false
  if (project.channel === 'lark')
    return submitLark({
      chatId: project.id,
      sessionId: project.sessionId,
      text: body,
    })
  return sendLocal(project.id, project.sessionId, body)
}

/** Starts work from Home. In a Lark project that opens a topic in the group. */
export async function startSession(project: Project, text: string) {
  const body = text.trim()
  if (!body) return false
  if (project.channel === 'lark')
    return submitLark({
      chatId: project.id,
      newTopic: { title: topicTitle(body) },
      text: body,
    })
  return sendLocal(project.id, project.sessionId, body)
}

/** A reply in one open session; in Lark it continues that topic. */
export async function sendInSession(
  project: Project,
  session: Session,
  text: string,
) {
  const body = text.trim()
  if (!body) return false
  if (project.channel === 'lark')
    return submitLark({
      chatId: project.id,
      sessionId: session.sessionId,
      text: body,
    })
  return sendLocal(project.id, session.sessionId, body)
}

/** Opens the enabled group in Lark; a topic has no documented deep link. */
export async function openLarkChat(chatId: string) {
  const report = pageError()
  try {
    await vela.openLarkChat(chatId)
    report('')
  } catch (cause) {
    report(errorMessage(cause))
  }
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

/** Re-reads the Lark history the page shows after Lark says it changed. */
function applyLark(value: Extract<Event, { type: 'lark' }>['value']) {
  const reset = value.type === 'reset'
  if (reset) void refresh()

  const group = visibleLarkGroup
  if (group && (reset || value.chatId === group.id)) {
    const report = pageError(`project:${group.id}`)
    void history.load(group).then((error) => {
      if (error && visibleLarkGroup === group) report(error)
    })
  }

  const topic = visibleLarkTopic
  if (
    topic &&
    (reset ||
      (value.chatId === topic.projectId &&
        value.sessionId === topic.session.sessionId))
  ) {
    const report = pageError(`project:${topic.projectId}`)
    void history.loadTopic(topic.projectId, topic.session).then((error) => {
      if (error && visibleLarkTopic === topic) report(error)
    })
  }
}

/** Stops the run this session is in, if it still has one. */
export async function stop(session: Session) {
  if (!session.runId) return
  const report = pageError()
  try {
    await vela.stop(
      session.channel,
      {
        chatId: session.chatId,
        ...(session.topic ? { rootId: session.topic.rootId } : {}),
      },
      session.runId,
    )
  } catch (cause) {
    report(errorMessage(cause))
  }
}

/** Subscribes once and reads the recorded projects and sessions. Safe to call on every mount. */
export async function start() {
  starting ??= (async () => {
    vela.onEvent((event) => {
      if (event.type === 'local') apply(event.value)
      else if (event.type === 'session' && event.channel !== 'local')
        mergeSessions([event.value.session])
      else if (
        event.type === 'status' &&
        event.channel === 'lark' &&
        event.value.sessionId
      )
        publish({
          statuses: {
            ...snapshot.statuses,
            [event.value.sessionId]: event.value.text,
          },
        })
      else if (event.type === 'connection')
        // Lark reconnecting also sends its own `reset`, which re-reads what is shown.
        publish({
          connections: {
            ...snapshot.connections,
            [event.channel]: event.value,
          },
        })
      else if (event.type === 'lark') applyLark(event.value)
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
