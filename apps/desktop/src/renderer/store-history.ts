import type { Message, Project } from '../shared/bridge.ts'
import { errorMessage } from './errors.ts'
import { vela } from './vela.ts'

const LARK_PAGE_LIMIT = 50
const larkCursors = new Map<string, string>()
const exhaustedLarkSessions = new Set<string>()

export function clearLarkCursors(): void {
  larkCursors.clear()
  exhaustedLarkSessions.clear()
}

function orderedMessages(messages: Message[]): Message[] {
  const byId = new Map<string, Message>()
  for (const message of messages) byId.set(message.id, message)
  return [...byId.values()].sort((one, other) =>
    one.createdAt === other.createdAt
      ? one.id.localeCompare(other.id)
      : one.createdAt.localeCompare(other.createdAt),
  )
}

function reconcileRange(
  shown: Message[],
  incoming: Message[],
  complete: boolean,
): Message[] {
  if (!complete && incoming.length === 0) return shown
  const fresh = new Map(incoming.map((message) => [message.id, message]))
  const times = incoming.map((message) => message.createdAt).sort()
  const oldest = times[0]
  const newest = times.at(-1)
  const kept = shown.filter((message) => {
    if (fresh.has(message.id)) return true
    if (complete || oldest === undefined || newest === undefined) return false
    return message.createdAt < oldest || message.createdAt > newest
  })
  return orderedMessages([...kept, ...incoming])
}

export async function readLarkGroupHistory(params: {
  project: Extract<Project, { channel: 'lark' }>
  older?: boolean
  shown: (sessionId: string) => Message[]
  onPage: (sessionId: string, messages: Message[], hasEarlier?: boolean) => void
  fetchMessages?: (params: {
    sessionId: string
    cursor?: string
    limit?: number
  }) => Promise<{ messages: Message[]; nextCursor?: string }>
}): Promise<string | undefined> {
  const { project, older = false, shown, onPage, fetchMessages } = params
  const sessionId = project.sessionId
  const read = (cursor?: string) =>
    (fetchMessages ?? vela.messages)({
      sessionId,
      ...(cursor ? { cursor } : {}),
      limit: LARK_PAGE_LIMIT,
    })

  let walked = false
  const walk = async (
    startCursor: string | undefined,
    take: (page: Awaited<ReturnType<typeof read>>, first: boolean) => void,
    done: (page: Awaited<ReturnType<typeof read>>) => boolean,
  ) => {
    let cursor = startCursor
    for (;;) {
      const page = await read(cursor)
      take(page, cursor === undefined)
      if (done(page) || !page.nextCursor) return page.nextCursor
      walked = true
      cursor = page.nextCursor
    }
  }

  const remember = (next: string | undefined) => {
    if (next === undefined) {
      larkCursors.delete(sessionId)
      exhaustedLarkSessions.add(sessionId)
    } else {
      exhaustedLarkSessions.delete(sessionId)
      larkCursors.set(sessionId, next)
    }
    return next !== undefined
  }

  try {
    if (older) {
      const cursor = larkCursors.get(sessionId)
      if (cursor === undefined) return undefined
      const next = await walk(
        cursor,
        (page) => {
          onPage(
            sessionId,
            orderedMessages([...shown(sessionId), ...page.messages]),
          )
        },
        (page) => page.messages.length > 0,
      )
      onPage(sessionId, shown(sessionId), remember(next))
      return undefined
    }

    const shownIds = new Set(shown(sessionId).map((message) => message.id))
    let overlaps = false
    const next = await walk(
      undefined,
      (page, first) => {
        const nextMessages = first
          ? reconcileRange(shown(sessionId), page.messages, false)
          : orderedMessages([...shown(sessionId), ...page.messages])
        onPage(sessionId, nextMessages)
      },
      (page) => {
        overlaps = page.messages.some((message) => shownIds.has(message.id))
        return shownIds.size === 0 || overlaps
      },
    )
    if (
      !walked &&
      overlaps &&
      (larkCursors.has(sessionId) || exhaustedLarkSessions.has(sessionId))
    ) {
      return undefined
    }
    onPage(sessionId, shown(sessionId), remember(next))
    return undefined
  } catch (cause) {
    onPage(sessionId, shown(sessionId))
    return errorMessage(cause)
  }
}

export async function readLarkTopicHistory(params: {
  sessionId: string
  shown: (sessionId: string) => Message[]
  onMessages: (sessionId: string, messages: Message[]) => void
}): Promise<string | undefined> {
  const { sessionId, shown, onMessages } = params
  try {
    const collected: Message[] = []
    let cursor: string | undefined
    do {
      const page = await vela.messages({
        sessionId,
        ...(cursor ? { cursor } : {}),
        limit: LARK_PAGE_LIMIT,
      })
      collected.push(...page.messages)
      cursor = page.nextCursor
    } while (cursor)
    onMessages(sessionId, reconcileRange(shown(sessionId), collected, true))
    return undefined
  } catch (cause) {
    return errorMessage(cause)
  }
}

export async function readLocalHistoryPages(
  sessionId: string,
  firstOnly: boolean,
): Promise<Message[]> {
  const collected: Message[] = []
  let after: string | undefined
  do {
    const page = await vela.messages({
      sessionId,
      after,
      limit: firstOnly ? 1 : 100,
    })
    collected.push(...page.messages)
    after = firstOnly ? undefined : page.nextCursor
    if (page.messages.length === 0) break
  } while (after)
  return collected
}
