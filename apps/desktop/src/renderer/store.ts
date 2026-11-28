import { useSyncExternalStore } from 'react'
import type {
  DesktopPreferences,
  Event,
  LarkSubmit,
  Message,
  ModelSetup,
  Project,
  Session,
  SettingsState,
} from '../shared/bridge.ts'
import { errorMessage } from './errors.ts'
import { sessionProjectId } from './format.ts'
import {
  clearLarkCursors,
  readLarkGroupHistory,
  readLarkTopicHistory,
  readLocalHistoryPages,
} from './store-history.ts'
import {
  applyChannelEventState,
  applyLocalEventState,
  initialSnapshot,
  type LocalSendOutcome,
  mergeSessionMessages,
  readDesktopFrame,
  reconcileLocalMessages,
  type Snapshot,
  sessionMap,
  submitLarkFlow,
  submitLocalFlow,
  syncVisibleLarkState,
  topicTitle,
  withoutKey,
} from './store-state.ts'
import { vela } from './vela.ts'

export type { Snapshot }

let snapshot = initialSnapshot
const listeners = new Set<() => void>()
let starting: Promise<void> | undefined
const attempts = new Map<string, { message: string; replyId?: string }>()
const complete = new Set<string>()
const loading = new Map<string, Promise<boolean>>()

const publish = (change: Partial<Snapshot>) => {
  snapshot = { ...snapshot, ...change }
  for (const listener of listeners) listener()
}

let errorView = 'home'
let viewGeneration = 0

const pageError = (view = errorView) => {
  const generation = viewGeneration
  return (error: string) => {
    if (error && (generation !== viewGeneration || view !== errorView)) return
    publish({ error })
  }
}

export function dismissPageError() {
  publish({ error: '' })
}

export function reportPageError(view: string, cause: unknown) {
  pageError(view)(errorMessage(cause))
}

export function setErrorView(view: string) {
  if (view === errorView) return
  errorView = view
  viewGeneration += 1
  if (snapshot.error) publish({ error: '' })
}

const current = () => snapshot

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useStore = () => useSyncExternalStore(subscribe, current)
export { errorMessage } from './errors.ts'

function mergeMessages(sessionId: string, incoming: Message[]) {
  const existingList = snapshot.messages[sessionId] ?? []
  if (incoming.length === 0) {
    if (snapshot.messages[sessionId] === undefined) {
      publish({
        messages: { ...snapshot.messages, [sessionId]: [] },
      })
    }
    return
  }
  publish({
    messages: {
      ...snapshot.messages,
      [sessionId]: mergeSessionMessages(existingList, incoming),
    },
  })
}

function replaceMessages(sessionId: string, incoming: Message[]) {
  publish({
    messages: {
      ...snapshot.messages,
      [sessionId]: reconcileLocalMessages(
        snapshot.messages[sessionId] ?? [],
        incoming,
      ),
    },
  })
}

function mergeSessions(sessions: Session[]) {
  const merged = { ...snapshot.sessions }
  for (const session of sessions) merged[session.sessionId] = session
  publish({ sessions: merged })
}

const historyGeneration = new Map<string, number>()

const bumpHistoryGeneration = (sessionId: string): number => {
  const next = (historyGeneration.get(sessionId) ?? 0) + 1
  historyGeneration.set(sessionId, next)
  return next
}

const clearLocalSessionState = (sessionId: string) => {
  bumpHistoryGeneration(sessionId)
  complete.delete(sessionId)
  loading.delete(sessionId)
}

const invalidateAllLocalHistory = () => {
  const ids = new Set<string>([
    ...Object.keys(snapshot.messages),
    ...complete,
    ...loading.keys(),
    ...(visibleLocalSession ? [visibleLocalSession.sessionId] : []),
  ])
  for (const sessionId of ids) {
    bumpHistoryGeneration(sessionId)
  }
  complete.clear()
  loading.clear()
}

/** One forward page walk for Local/Quick Chat history. */
async function readLocalHistory(
  place: string,
  sessionId: string,
  firstOnly: boolean,
) {
  const report = pageError(place)
  const generation = historyGeneration.get(sessionId) ?? 0
  try {
    const incoming = await readLocalHistoryPages(sessionId, firstOnly)
    if ((historyGeneration.get(sessionId) ?? 0) !== generation) {
      return false
    }
    if (firstOnly) mergeMessages(sessionId, incoming)
    else replaceMessages(sessionId, incoming)
    return true
  } catch (cause) {
    report(errorMessage(cause))
    return false
  }
}

async function loadLocalMessages(
  place: string,
  sessionId: string,
  firstOnly = false,
) {
  const key = sessionId
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
    const read = readLocalHistory(place, sessionId, firstOnly)
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

function loadLarkGroupPage(
  project: Extract<Project, { channel: 'lark' }>,
  older = false,
): Promise<string | undefined> {
  return readLarkGroupHistory({
    project,
    older,
    shown: (sessionId) => snapshot.messages[sessionId] ?? [],
    onPage: (sessionId, messages, hasEarlier) => {
      publish({
        messages: { ...snapshot.messages, [sessionId]: messages },
        ...(hasEarlier === undefined
          ? {}
          : {
              earlier: hasEarlier
                ? { ...snapshot.earlier, [sessionId]: true }
                : withoutKey(snapshot.earlier, sessionId),
            }),
      })
    },
  })
}

function loadLarkTopicMessages(sessionId: string): Promise<string | undefined> {
  return readLarkTopicHistory({
    sessionId,
    shown: (sessionId) => snapshot.messages[sessionId] ?? [],
    onMessages: (sessionId, messages) => {
      publish({
        messages: { ...snapshot.messages, [sessionId]: messages },
      })
    },
  })
}

let visibleLocalSession: { place: string; sessionId: string } | undefined
let visibleLarkGroup: Extract<Project, { channel: 'lark' }> | undefined
let visibleLarkTopic:
  | { projectId: string; session: Session; report: (notice: string) => void }
  | undefined

/** Only the mounted Lark group page receives automatic history refreshes. */
export function watchLarkProject(project: Project) {
  if (project.channel !== 'lark') return
  visibleLarkGroup = project
  return () => {
    if (visibleLarkGroup === project) visibleLarkGroup = undefined
  }
}

/** Reads one session's whole history; full-width SessionView and Lark Topics use it. */
export function loadSession(
  place: string,
  sessionId: string,
  report: (notice: string) => void,
) {
  const session = snapshot.sessions[sessionId]
  if (session?.channel !== 'lark') {
    const localTarget = { place, sessionId }
    visibleLocalSession = localTarget
    void loadLocalMessages(place, sessionId)
    return () => {
      if (visibleLocalSession === localTarget) visibleLocalSession = undefined
    }
  }
  const projectId = sessionProjectId(session) ?? place.replace(/^project:/, '')
  const topic = { projectId, session, report }
  visibleLarkTopic = topic
  void loadLarkTopicMessages(sessionId).then((error) => {
    if (error && visibleLarkTopic === topic) report(error)
  })
  return () => {
    if (visibleLarkTopic === topic) visibleLarkTopic = undefined
  }
}

export async function loadQuickChats() {
  const report = pageError('quick')
  try {
    const sessions = await vela.sessions('local', 'quick')
    mergeSessions(sessions)
    if (sessions[0]) {
      await loadLocalMessages('quick', sessions[0].sessionId)
    }
  } catch (cause) {
    report(errorMessage(cause))
  }
}

/** Reads a project's sessions and initial history. */
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
    const error = await loadLarkGroupPage(project)
    if (error) report(error)
    return
  }
  try {
    const sessions = await vela.sessions('local', projectId)
    mergeSessions(sessions)
    const latest = [...sessions].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    )[0]
    if (latest) {
      await loadLocalMessages(`project:${projectId}`, latest.sessionId)
    }
  } catch (cause) {
    report(errorMessage(cause))
  }
}

/** One older page of a Lark group's history. */
export function loadEarlierLark(project: Project) {
  if (project.channel !== 'lark') return
  const report = pageError(`project:${project.id}`)
  void loadLarkGroupPage(project, true).then((error) => {
    if (error) report(error)
  })
}

async function refresh() {
  const report = pageError()
  try {
    const { projects, sessions, connections } = await readDesktopFrame(
      vela,
      errorMessage,
    )
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
    const [settings, frame] = await Promise.all([
      vela.settings(),
      readDesktopFrame(vela, errorMessage),
    ])
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

export async function saveModel(input: ModelSetup): Promise<SettingsState> {
  const settings = await vela.saveModel(input)
  publish({ settings })
  return settings
}

export async function savePreferences(
  input: Partial<DesktopPreferences>,
): Promise<SettingsState> {
  const settings = await vela.savePreferences(input)
  publish({ settings })
  return settings
}

export async function confirmLarkGroup(chatId: string) {
  await vela.confirmLarkGroup()
  await reload()
  const project = snapshot.projects.find(
    (item) => item.channel === 'lark' && item.id === chatId,
  )
  if (!project) {
    throw new Error(
      'Group saved, but it is missing from the active Lark configuration.',
    )
  }
  return project
}

export async function openProject(input: { cwd: string; name?: string }) {
  const project = await vela.openProject(input)
  await reload()
  await loadProject(project.id)
  return project
}

export async function removeProject(projectId: string): Promise<boolean> {
  try {
    const removed = await vela.removeProject({ projectId })
    if (removed) {
      const nextSessions = { ...snapshot.sessions }
      const nextMessages = { ...snapshot.messages }
      for (const [sid, session] of Object.entries(nextSessions)) {
        if (session.projectId === projectId) {
          delete nextSessions[sid]
          delete nextMessages[sid]
          clearLocalSessionState(sid)
        }
      }
      publish({
        projects: snapshot.projects.filter((p) => p.id !== projectId),
        sessions: nextSessions,
        messages: nextMessages,
        error: '',
      })
    }
    return removed
  } catch (cause) {
    pageError()(errorMessage(cause))
    return false
  }
}

export async function createSession(
  projectId: string | null,
  name?: string,
): Promise<Session> {
  const created = await vela.createSession({ projectId, name })
  complete.add(created.sessionId)
  publish({
    sessions: { ...snapshot.sessions, [created.sessionId]: created },
    messages: {
      ...snapshot.messages,
      [created.sessionId]: snapshot.messages[created.sessionId] ?? [],
    },
  })
  return created
}

export async function renameSession(
  sessionId: string,
  name: string,
): Promise<Session | undefined> {
  const renamed = await vela.renameSession({ sessionId, name })
  if (renamed) mergeSessions([renamed])
  return renamed
}

export async function deleteSession(
  sessionId: string,
  report = pageError(),
): Promise<boolean> {
  try {
    const deleted = await vela.deleteSession({ sessionId })
    if (deleted) {
      clearLocalSessionState(sessionId)
      publish({
        sessions: withoutKey(snapshot.sessions, sessionId),
        messages: withoutKey(snapshot.messages, sessionId),
        failures: withoutKey(snapshot.failures, sessionId),
        progress: withoutKey(snapshot.progress, sessionId),
      })
      report('')
    }
    return deleted
  } catch (cause) {
    report(errorMessage(cause))
    return false
  }
}

/** A Local submission: optimistic bubble is replaced by the recorded copy. */
function sendLocal(
  projectId: string | null,
  sessionId: string,
  text: string,
  report = pageError(),
): Promise<LocalSendOutcome> {
  return submitLocalFlow({
    projectId,
    sessionId,
    text,
    getSnapshot: () => snapshot,
    publish,
    mergeMessages,
    onUnknown: (sid) => complete.delete(sid),
    submit: vela.submit,
    report,
    formatError: errorMessage,
  })
}

async function submitLark(
  input: LarkSubmit,
  {
    onAccepted,
    report = pageError(),
  }: {
    onAccepted?: (notice: string) => void
    report?: (notice: string) => void
  } = {},
): Promise<boolean> {
  return submitLarkFlow({
    input,
    projects: snapshot.projects,
    sessions: snapshot.sessions,
    submit: vela.submit,
    fetchLarkSessions: (chatId) => vela.sessions('lark', chatId),
    loadGroupPage: loadLarkGroupPage,
    loadTopicMessages: loadLarkTopicMessages,
    mergeSessions,
    onAccepted,
    report,
    formatError: errorMessage,
  })
}

/** A message in a Lark group chat. */
export async function sendInProject(
  project: Extract<Project, { channel: 'lark' }>,
  text: string,
) {
  const body = text.trim()
  if (!body) return false
  return submitLark({
    chatId: project.id,
    sessionId: project.sessionId,
    text: body,
  })
}

/** Starts work from Home: Quick chat, Local project session, or Lark topic. */
export async function startSession(
  destination: Project | 'quick',
  text: string,
  openDestination: (sessionId?: string) => void,
) {
  const body = text.trim()
  if (!body) return false
  const reportHome = pageError('home')
  if (body.length > 100_000) {
    reportHome('Message is too long (maximum 100,000 characters)')
    return false
  }
  const generation = viewGeneration
  if (destination === 'quick' || destination.channel === 'local') {
    const targetProjectId = destination === 'quick' ? null : destination.id
    let session: Session
    try {
      session = await createSession(targetProjectId, body.slice(0, 60))
    } catch (cause) {
      reportHome(errorMessage(cause))
      return false
    }
    const outcome = await sendLocal(
      targetProjectId,
      session.sessionId,
      body,
      reportHome,
    )
    if (outcome === 'rejected') {
      await deleteSession(session.sessionId, (err) => {
        if (err) reportHome(err)
      })
      return false
    }
    if (generation === viewGeneration) {
      openDestination(session.sessionId)
    }
    return true
  }
  return submitLark(
    {
      chatId: destination.id,
      newTopic: { title: topicTitle(body) },
      text: body,
    },
    {
      report: reportHome,
      onAccepted: (notice) => {
        if (generation !== viewGeneration) return
        openDestination()
        if (notice) pageError(`project:${destination.id}`)(notice)
      },
    },
  )
}

/** Send a message inside a specific session (Quick chat, Local work session, or Lark topic). */
export async function sendInSession(
  project: Project | undefined,
  session: Session,
  text: string,
  report: (notice: string) => void,
) {
  const body = text.trim()
  if (!body) return false
  if (session.channel === 'lark' && project?.channel === 'lark') {
    return submitLark(
      {
        chatId: project.id,
        sessionId: session.sessionId,
        text: body,
      },
      { report },
    )
  }
  const outcome = await sendLocal(
    session.projectId,
    session.sessionId,
    body,
    report,
  )
  return outcome !== 'rejected'
}

/** Starts a new Local session in an existing project when there is no active session yet. */
export async function sendInNewLocalSession(
  projectId: string | null,
  text: string,
  onCreated: (sessionId: string) => void,
  report = pageError(),
) {
  const body = text.trim()
  if (!body) return false
  const created = await createSession(projectId, body.slice(0, 60))
  const outcome = await sendLocal(projectId, created.sessionId, body, report)
  if (outcome === 'rejected') {
    void deleteSession(created.sessionId, (err) => {
      if (err) report(err)
    })
    return false
  }
  onCreated(created.sessionId)
  return true
}

/** Opens the enabled group in Lark; a topic has no documented deep link. */
export async function openLarkChat(
  chatId: string,
  report: (notice: string) => void,
) {
  try {
    await vela.openLarkChat(chatId)
    report('')
  } catch (cause) {
    report(errorMessage(cause))
  }
}

function apply(value: Extract<Event, { type: 'local' }>['value']) {
  applyLocalEventState({
    value,
    snapshot,
    attempts,
    publish,
    mergeSessions,
    mergeMessages,
    onSessionReset: clearLocalSessionState,
  })
}

/** Re-reads Local/Lark history or frame state after a channel event arrives. */
function syncVisibleLarkViews() {
  syncVisibleLarkState({
    visibleGroup: visibleLarkGroup,
    visibleTopic: visibleLarkTopic,
    fetchLarkSessions: (chatId) => vela.sessions('lark', chatId),
    loadGroupPage: loadLarkGroupPage,
    loadTopicMessages: loadLarkTopicMessages,
    mergeSessions,
    pageError,
    isCurrentGroup: (id) => visibleLarkGroup?.id === id,
    isCurrentTopic: (topic) => visibleLarkTopic === topic,
  })
}

function applyChannel(
  channel: string,
  value: Extract<Event, { type: 'channel' }>['value'],
) {
  applyChannelEventState({
    channel,
    value,
    getSnapshot: () => snapshot,
    publish,
    invalidateAllLocalHistory,
    clearLarkCursors,
    refresh,
    visibleLocal: visibleLocalSession,
    visibleGroup: visibleLarkGroup,
    visibleTopic: visibleLarkTopic,
    loadLocal: loadLocalMessages,
    loadGroupPage: loadLarkGroupPage,
    loadTopicMessages: loadLarkTopicMessages,
    fetchLarkSessions: (chatId) => vela.sessions('lark', chatId),
    mergeSessions,
    pageError,
    isCurrentGroup: (id) => visibleLarkGroup?.id === id,
    isCurrentTopic: (topic) => visibleLarkTopic === topic,
  })
}

/** Stops the run this session is in, if it still has one. */
export async function stop(session: Session, report = pageError()) {
  if (!session.runId) return
  try {
    await vela.stop(
      session.channel,
      {
        sessionId: session.sessionId,
        ...(session.chatId ? { chatId: session.chatId } : {}),
        ...(session.topic ? { rootId: session.topic.rootId } : {}),
      },
      session.runId,
    )
  } catch (cause) {
    report(errorMessage(cause))
  }
}

/** Subscribes once and reads the recorded projects and sessions. */
export async function start() {
  starting ??= (async () => {
    vela.onEvent((event) => {
      if (event.type === 'local') apply(event.value)
      else if (event.type === 'session' && event.channel !== 'local') {
        mergeSessions([event.value.session])
      } else if (
        event.type === 'status' &&
        event.channel === 'lark' &&
        event.value.sessionId
      ) {
        publish({
          statuses: {
            ...snapshot.statuses,
            [event.value.sessionId]: event.value.text,
          },
        })
      } else if (event.type === 'connection') {
        const wasConnected = snapshot.connections[event.channel]?.connected
        publish({
          connections: {
            ...snapshot.connections,
            [event.channel]: event.value,
          },
        })
        if (
          event.channel === 'lark' &&
          wasConnected !== true &&
          event.value.connected
        ) {
          void refresh().then(() => syncVisibleLarkViews())
        }
      } else if (event.type === 'channel') {
        applyChannel(event.channel, event.value)
      }
    })
    await reload()
  })()
  return starting
}

export async function saveLark(input: Parameters<typeof vela.saveLark>[0]) {
  try {
    publish({ settings: await vela.saveLark(input) })
  } finally {
    await reload()
  }
}
