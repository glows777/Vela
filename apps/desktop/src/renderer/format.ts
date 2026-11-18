import type { Message, Project, Session } from '../shared/bridge.ts'
import type { Snapshot } from './store.ts'

export const stateWord = {
  running: 'Running',
  queued: 'Queued',
  waiting: 'Waiting for an answer',
  done: 'Done',
  stopped: 'Stopped',
} as const satisfies Record<Session['state'], string>

const newestFirst = (one: Session, other: Session) =>
  other.updatedAt.localeCompare(one.updatedAt)

/** A session is the work started inside a project; the project chat itself is not one. */
const started = (session: Session) => session.topic !== undefined

function projectSessions(snapshot: Snapshot, projectId: string): Session[] {
  return Object.values(snapshot.sessions)
    .filter((session) => session.chatId === projectId && started(session))
    .sort(newestFirst)
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
): Project | undefined =>
  snapshot.projects.find((project) => project.id === session.chatId)

/** The Home picker defaults to the project with the most recent session. */
export function lastUsedProject(snapshot: Snapshot): Project | undefined {
  const latest = Object.values(snapshot.sessions).sort(newestFirst)[0]
  return (latest && projectOf(snapshot, latest)) ?? snapshot.projects[0]
}

type TimelineItem =
  | { kind: 'message'; at: string; message: Message }
  | { kind: 'session'; at: string; session: Session }

/**
 * The project conversation, with each started session placed where its title message
 * was recorded. Local records no reply on the turn that starts a session, so that
 * title message is the only recorded link between the chat and the session.
 */
export function projectTimeline(
  snapshot: Snapshot,
  project: Project,
): TimelineItem[] {
  const items: TimelineItem[] = []
  for (const message of snapshot.messages[project.sessionId] ?? [])
    items.push({ kind: 'message', at: message.createdAt, message })
  for (const session of projectSessions(snapshot, project.id)) {
    const title = snapshot.messages[session.sessionId]?.[0]
    if (title) items.push({ kind: 'session', at: title.createdAt, session })
  }
  return items.sort((one, other) =>
    one.at === other.at
      ? one.kind.localeCompare(other.kind)
      : one.at.localeCompare(other.at),
  )
}
