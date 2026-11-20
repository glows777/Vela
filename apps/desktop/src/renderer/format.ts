import type { Message, Project, Session } from '../shared/bridge.ts'
import type { Snapshot } from './store.ts'

export const stateWord = {
  running: 'Running',
  queued: 'Queued',
  waiting: 'Waiting for an answer',
  done: 'Done',
  stopped: 'Stopped',
} as const satisfies Record<Session['state'], string>

/** The provider of a `provider/id` ref. */
export const providerOf = (ref?: string) =>
  ref === undefined ? '' : (ref.split('/')[0] ?? '')

/** The bot speaks for the app, never as a person; each Lark composer says so. */
export const larkGroupComposer =
  'Vela posts it in the group as the bot, signed Vela app. It does not post as you.'
export const larkTopicComposer =
  'Vela posts it in this topic as the bot, signed Vela app. It does not post as you.'
/** Home starts a session here: a Lark project opens a topic in its group. */
export const larkStartHint = (name: string) =>
  `Vela opens a topic in ${name} for it, started by you.`

/** The source tag a project shows everywhere (app.md, "A project has a source tag"). */
export const projectTag = (project?: Project) =>
  project?.channel === 'lark' ? 'Lark' : 'Local'

/** A group with no readable name shows its chat id, in mono. */
export const projectName = (project: Project) =>
  project.channel === 'lark' ? (project.name ?? project.id) : project.name
export const projectNameIsId = (project: Project) =>
  project.channel === 'lark' && project.name === undefined

/** The last segment of a path from main: a row names its file, not the folder above it. */
export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path

const newestFirst = (one: Session, other: Session) =>
  other.updatedAt.localeCompare(one.updatedAt)

/** A session is the work started inside a project; the project chat itself is not one. */
export const started = (session: Session) => session.topic !== undefined

function projectSessions(snapshot: Snapshot, project: Project): Session[] {
  return Object.values(snapshot.sessions)
    .filter(
      (session) =>
        session.chatId === project.id &&
        session.channel === project.channel &&
        started(session),
    )
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

/** The panel groups every started session by what it asks of the person. */
export function sessionGroups(snapshot: Snapshot, project: Project) {
  const sessions = projectSessions(snapshot, project)
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
): Project | undefined =>
  snapshot.projects.find(
    (project) =>
      project.id === session.chatId && project.channel === session.channel,
  )

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
  if (project.channel === 'lark') {
    // A Lark topic's first message is the group's root message. The card takes that
    // message's place; a root outside the loaded page shows nothing rather than a guess.
    const roots = new Map<string, Session>()
    for (const session of projectSessions(snapshot, project))
      if (session.topic) roots.set(session.topic.rootId, session)
    for (const message of visibleMessages(snapshot, project.sessionId)) {
      const session = roots.get(message.id)
      if (session)
        items.push({ kind: 'session', at: message.createdAt, session })
      else items.push({ kind: 'message', at: message.createdAt, message })
    }
  } else {
    for (const message of visibleMessages(snapshot, project.sessionId))
      items.push({ kind: 'message', at: message.createdAt, message })
    for (const session of projectSessions(snapshot, project)) {
      const title = snapshot.messages[session.sessionId]?.[0]
      if (title) items.push({ kind: 'session', at: title.createdAt, session })
    }
  }
  return items.sort((one, other) =>
    one.at === other.at
      ? one.kind.localeCompare(other.kind)
      : one.at.localeCompare(other.at),
  )
}
