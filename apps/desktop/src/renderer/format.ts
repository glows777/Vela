import type { Message, Project, Session } from '../shared/bridge.ts'
import type { Snapshot } from './store-state.ts'

export const stateWord = {
  running: 'Working',
  queued: 'Working',
  waiting: 'Needs you',
  done: 'Done',
  stopped: 'Stopped',
} as const

export const providerOf = (ref?: string) =>
  ref?.includes('/') ? ref.slice(0, ref.indexOf('/')) : ''

/** The bot speaks for the app, never as a person; each Lark composer says so. */
export const larkGroupComposer =
  'Vela posts it in the group as the bot, signed Vela app. It does not post as you.'

export const larkTopicComposer =
  'Vela posts it in this topic as the bot, signed Vela app. It does not post as you.'

/** Home starts a session here: a Lark project opens a topic in its group. */
export const larkStartHint = (name: string) =>
  `Vela opens a topic in ${name} for it, started by you.`

export const projectTag = (project?: Project) =>
  project?.channel === 'lark' ? 'Lark' : 'Local'

export const projectName = (project: Project) =>
  project.channel === 'lark' ? (project.name ?? project.id) : project.name

export const projectNameIsId = (project: Project) =>
  project.channel === 'lark' && !project.name

export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path

const newestFirst = (one: Session, other: Session) =>
  other.updatedAt.localeCompare(one.updatedAt)

/** A session shown as a conversation card/item (Local work/quick sessions, or Lark topics). */
const started = (session: Session) =>
  session.channel === 'local' || session.topic !== undefined

/** Desktop `Project.id` owning a session (`chatId` for Lark, `projectId` for Local, `null` for Quick chat). */
export const sessionProjectId = (session: Session): string | null =>
  session.channel === 'lark'
    ? (session.chatId ?? session.projectId)
    : session.projectId

export function projectSessions(
  snapshot: Snapshot,
  project: Project,
): Session[] {
  return Object.values(snapshot.sessions)
    .filter(
      (session) =>
        session.channel === project.channel &&
        sessionProjectId(session) === project.id &&
        started(session),
    )
    .sort(newestFirst)
}

export function quickSessions(snapshot: Snapshot): Session[] {
  return Object.values(snapshot.sessions)
    .filter((session) => session.chatKind === 'quick')
    .sort(newestFirst)
}

/** A session's messages without the replies the failure card already states. */
export function visibleMessages(
  snapshot: Snapshot,
  sessionId: string,
): Message[] {
  return (snapshot.messages[sessionId] ?? []).filter(
    (message) => !snapshot.hidden[message.id],
  )
}

export function groupSessions(sessions: Session[]) {
  return [
    {
      label: 'Needs you',
      sessions: sessions.filter((session) => session.state === 'waiting'),
    },
    {
      label: 'Working',
      sessions: sessions.filter(
        (session) => session.state === 'running' || session.state === 'queued',
      ),
    },
    {
      label: 'Done',
      sessions: sessions.filter(
        (session) => session.state === 'done' || session.state === 'stopped',
      ),
    },
  ].filter((group) => group.sessions.length > 0)
}

export function needsYou(snapshot: Snapshot): Session[] {
  return Object.values(snapshot.sessions)
    .filter((session) => started(session) && session.state === 'waiting')
    .sort(newestFirst)
}

export function recentSessions(snapshot: Snapshot): Session[] {
  return Object.values(snapshot.sessions)
    .filter((session) => started(session) && session.state !== 'waiting')
    .sort(newestFirst)
}

export const projectOf = (
  snapshot: Snapshot,
  session: Session,
): Project | undefined => {
  const pid = sessionProjectId(session)
  if (!pid) return undefined
  return snapshot.projects.find(
    (project) => project.id === pid && project.channel === session.channel,
  )
}

export const QUICK_PICK = '__quick__'

/** The Home picker defaults to Quick chat or the most recently active project. */
export function defaultHomePick(snapshot: Snapshot): string {
  const latest = Object.values(snapshot.sessions).sort(newestFirst)[0]
  if (latest?.chatKind === 'quick') return QUICK_PICK
  if (latest) {
    const proj = projectOf(snapshot, latest)
    if (proj) return proj.id
  }
  return snapshot.projects[0]?.id ?? QUICK_PICK
}

type TimelineItem =
  | { kind: 'message'; at: string; message: Message }
  | { kind: 'session'; at: string; session: Session }

/**
 * Lark group conversation timeline, placing each topic session card at its root message.
 */
export function projectTimeline(
  snapshot: Snapshot,
  project: Extract<Project, { channel: 'lark' }>,
): TimelineItem[] {
  const items: TimelineItem[] = []
  const roots = new Map<string, Session>()
  for (const session of projectSessions(snapshot, project)) {
    if (session.topic) roots.set(session.topic.rootId, session)
  }
  for (const message of visibleMessages(snapshot, project.sessionId)) {
    const session = roots.get(message.id)
    if (session) items.push({ kind: 'session', at: message.createdAt, session })
    else items.push({ kind: 'message', at: message.createdAt, message })
  }
  return items
}
