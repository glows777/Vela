import type { Message, Project, Session } from '../shared/bridge.ts'
import { errorMessage } from './errors.ts'

/** One page of a Lark history read, as the bridge answers it. */
export type LarkPage = { messages: Message[]; nextCursor?: string }

/**
 * What a Lark history read needs from the page, so this file never imports the store:
 * the messages a session shows, where to put new ones, whether older history remains,
 * and the bridge read itself.
 */
export type LarkHistoryHost = {
  shown(sessionId: string): Message[]
  set(sessionId: string, messages: Message[]): void
  /** `false` removes the “Show earlier messages” action for that session. */
  mark(sessionId: string, hasOlder: boolean): void
  fail(reason: string): void
  read(input: {
    chatId: string
    sessionId: string
    cursor?: string
    limit?: number
  }): Promise<LarkPage>
}

const ordered = (messages: Map<string, Message>[]) =>
  [
    ...messages
      .reduce((all, one) => {
        for (const [id, message] of one) all.set(id, message)
        return all
      }, new Map<string, Message>())
      .values(),
  ].sort((one, other) =>
    one.createdAt === other.createdAt
      ? one.id.localeCompare(other.id)
      : one.createdAt.localeCompare(other.createdAt),
  )

/**
 * A read is authoritative for the range it covers: a message the host no longer
 * returns — one recalled in Lark — leaves the page. An empty page covers no range, so
 * it removes nothing; a page covers its own time range, so anything outside it stays.
 */
const reconcile = (
  shown: Message[],
  incoming: Message[],
  complete: boolean,
) => {
  const fresh = new Map(incoming.map((message) => [message.id, message]))
  const times = incoming.map((message) => message.createdAt).sort()
  const oldest = times[0]
  const newest = times.at(-1)
  const kept = shown.filter((message) => {
    if (fresh.has(message.id)) return true
    if (complete || oldest === undefined || newest === undefined) return false
    return message.createdAt < oldest || message.createdAt > newest
  })
  return ordered([new Map(kept.map((message) => [message.id, message])), fresh])
}

const merge = (shown: Message[], incoming: Message[]) =>
  ordered([
    new Map(shown.map((message) => [message.id, message])),
    new Map(incoming.map((message) => [message.id, message])),
  ])

/**
 * Lark history paging. The cursor is the only sign a page sequence continues: a page
 * the host filtered to nothing (a card, a recalled row) neither ends a read nor says
 * anything about older history.
 */
export function larkHistory(host: LarkHistoryHost) {
  /** The cursor of the next older page per session, absent when nothing is older. */
  const cursors = new Map<string, string>()
  /** The histories the page currently shows, so Lark's `reset` re-reads exactly those. */
  const reads = new Map<string, () => Promise<void>>()

  const remember = (sessionId: string, next: string | undefined) => {
    if (next === undefined) cursors.delete(sessionId)
    else cursors.set(sessionId, next)
    host.mark(sessionId, next !== undefined)
  }

  /**
   * A group's newest history, or one older page when the person asks for it. Returns
   * the reason a read failed so the caller can keep its own wording.
   */
  /** Registers a group's history as one Lark's `reset` re-reads, without reading now. */
  const watch = (project: Project) => {
    if (project.channel !== 'lark') return
    reads.set(`group:${project.id}`, async () => {
      const error = await load(project)
      if (error) host.fail(error)
    })
  }

  const load = async (
    project: Project,
    older = false,
  ): Promise<string | undefined> => {
    if (project.channel !== 'lark') return undefined
    watch(project)
    const sessionId = project.sessionId
    const read = (cursor?: string) =>
      host.read({
        chatId: project.id,
        sessionId,
        ...(cursor ? { cursor } : {}),
        limit: 50,
      })
    // Whether this read went past its first page, which says where paging now stands.
    let walked = false
    const walk = async (
      cursor: string | undefined,
      take: (page: LarkPage, first: boolean) => void,
      done: (page: LarkPage) => boolean,
    ) => {
      for (;;) {
        const page = await read(cursor)
        if (page.messages.length > 0) take(page, cursor === undefined)
        if (done(page) || !page.nextCursor) return page.nextCursor
        walked = true
        cursor = page.nextCursor
      }
    }
    try {
      if (older) {
        const cursor = cursors.get(sessionId)
        if (cursor === undefined) return undefined
        // One more page of text, past any filtered pages before it.
        const next = await walk(
          cursor,
          (page) =>
            host.set(sessionId, merge(host.shown(sessionId), page.messages)),
          (page) => page.messages.length > 0,
        )
        remember(sessionId, next)
        return undefined
      }
      // A refresh reads the newest page, then keeps reading back until it reaches the
      // history this session already shows. Ordinary activity overlaps at once and
      // leaves the paging the person reached; a long absence leaves a gap that is
      // filled here instead of being skipped by an older cursor.
      const shown = host.shown(sessionId)
      const shownIds = new Set(shown.map((message) => message.id))
      const next = await walk(
        undefined,
        (page, first) =>
          host.set(
            sessionId,
            first
              ? reconcile(shown, page.messages, false)
              : merge(host.shown(sessionId), page.messages),
          ),
        (page) =>
          shownIds.size === 0 ||
          page.messages.some((message) => shownIds.has(message.id)),
      )
      // The first page already holds what is on screen: the deeper cursor stays.
      if (!walked && cursors.has(sessionId)) return undefined
      remember(sessionId, next)
      return undefined
    } catch (cause) {
      const error = errorMessage(cause)
      host.fail(error)
      return error
    }
  }

  /** A topic's whole history, oldest first. Returns a failed read's reason. */
  const loadTopic = async (
    projectId: string,
    session: Session,
  ): Promise<string | undefined> => {
    if (session.channel !== 'lark') return undefined
    const reread = async () => {
      const error = await loadTopic(projectId, session)
      if (error) host.fail(error)
    }
    reads.set(`topic:${session.sessionId}`, reread)
    try {
      const collected: Message[] = []
      let cursor: string | undefined
      do {
        const page = await host.read({
          chatId: projectId,
          sessionId: session.sessionId,
          ...(cursor ? { cursor } : {}),
          limit: 50,
        })
        collected.push(...page.messages)
        cursor = page.nextCursor
      } while (cursor)
      host.set(
        session.sessionId,
        reconcile(host.shown(session.sessionId), collected, true),
      )
      return undefined
    } catch (cause) {
      return errorMessage(cause)
    }
  }

  /** Re-reads every Lark history the page shows; Lark's `reset` is the only trigger. */
  const reread = () => {
    for (const read of [...reads.values()]) void read()
  }

  return { load, loadTopic, watch, reread }
}
