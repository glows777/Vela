import { Buffer } from 'node:buffer'
import {
  type ChannelHost,
  channelSessionId,
  type IncomingMessage,
} from '@glows777/vela-channels'
import { errorMessage } from './log.ts'
import { messageText } from './messages.ts'
import type {
  LarkHistoryMessage,
  LarkMessageEvent,
  LarkSentMessage,
  LarkTransport,
} from './transport.ts'

export interface LarkVisibleMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  senderName: string
}

export type LarkHostEvent =
  | { type: 'reset' }
  | { type: 'history_changed'; chatId: string; sessionId?: string }

/**
 * A signed host submission that did not complete. `outcome` says whether anything
 * reached Lark, so a caller can re-read history instead of resending blindly.
 */
export class LarkSubmitError extends Error {
  /** `not-sent`: nothing was posted; `uncertain`: may have been posted; `posted`: it was, with `messageId` when known. */
  readonly outcome: 'not-sent' | 'uncertain' | 'posted'
  readonly messageId?: string

  constructor(
    message: string,
    outcome: LarkSubmitError['outcome'],
    details: { messageId?: string; cause?: unknown } = {},
  ) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    )
    this.name = 'LarkSubmitError'
    this.outcome = outcome
    if (details.messageId !== undefined) this.messageId = details.messageId
  }
}

export class LarkHostEvents {
  private readonly listeners = new Set<(event: LarkHostEvent) => void>()

  constructor(private readonly onError: (error: unknown) => void) {}

  get observed(): boolean {
    return this.listeners.size > 0
  }

  subscribe(
    listener: (event: LarkHostEvent) => void,
    connected: boolean,
  ): () => void {
    this.listeners.add(listener)
    if (connected) this.notify(listener, { type: 'reset' })
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: LarkHostEvent): void {
    for (const listener of this.listeners) this.notify(listener, event)
  }

  changed(chatId: string, topic?: IncomingMessage['topic']): void {
    this.emit(
      topic
        ? {
            type: 'history_changed',
            chatId,
            sessionId: channelSessionId('lark', chatId, topic.rootId),
          }
        : { type: 'history_changed', chatId },
    )
  }

  private notify(
    listener: (event: LarkHostEvent) => void,
    event: LarkHostEvent,
  ): void {
    try {
      void Promise.resolve(listener({ ...event })).catch(this.onError)
    } catch (error) {
      this.onError(error)
    }
  }
}

type SubmitInput = {
  chatId: string
  text: string
  author: { id: string; name: string }
}

export interface LarkHost extends ChannelHost {
  /** Every enabled group from saved configuration, whether or not Lark is connected. */
  chats(): Promise<{ chatId: string; name?: string }[]>
  /** Group history is newest first; topic history is oldest first. */
  messages(input: {
    chatId: string
    sessionId: string
    cursor?: string
    limit?: number
  }): Promise<{ messages: LarkVisibleMessage[]; nextCursor?: string }>
  submit(message: IncomingMessage): Promise<{ sessionId: string }>
  submit(input: SubmitInput & { sessionId: string }): Promise<{
    sessionId: string
    messageId: string
  }>
  submit(input: SubmitInput & { newTopic: { title: string } }): Promise<{
    sessionId: string
    messageId: string
    topic: { rootId: string; threadId: string }
  }>
  /** Best effort, not a replayable stream. Re-read visible history on reset. */
  onEvent(listener: (event: LarkHostEvent) => void): () => void
}

type Page = {
  sessionId: string
  limit: number
  endTime: string
  token?: string
  offset: number
}

function readCursor(cursor: string, sessionId: string): Page {
  try {
    const page = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Page
    if (
      page.sessionId === sessionId &&
      Number.isInteger(page.limit) &&
      page.limit >= 1 &&
      page.limit <= 50 &&
      Number.isInteger(page.offset) &&
      page.offset >= 0 &&
      page.offset < 50 &&
      typeof page.endTime === 'string' &&
      /^\d+$/.test(page.endTime) &&
      (page.token === undefined || typeof page.token === 'string')
    )
      return page
  } catch {
    // A malformed token is a host argument error, not a request to Lark.
  }
  throw new Error('Invalid Lark history cursor')
}

interface Operations {
  enabled(chatId: string): boolean
  chatIds(): string[]
  /** The transport while Lark is connected; undefined otherwise, including after Stop. */
  transport(): LarkTransport | undefined
  senderName(id: string): Promise<string>
  ownAppId: string
  submitNewTopic(message: IncomingMessage): Promise<{ sessionId: string }>
  onEvent(listener: (event: LarkHostEvent) => void): () => void
  changed(chatId: string, topic?: IncomingMessage['topic']): void
}

export function larkHost(base: ChannelHost, ops: Operations): LarkHost {
  function enabled(chatId: string) {
    if (!ops.enabled(chatId)) throw new Error('Lark group is not enabled')
  }

  function topicFor(chatId: string, sessionId: string) {
    enabled(chatId)
    // The enabled group's logical ID exists before its first admitted input.
    if (sessionId === channelSessionId('lark', chatId)) return undefined
    const target = base.sessions(chatId).find((s) => s.sessionId === sessionId)
    if (!target?.topic) throw new Error('Unknown Lark group or topic session')
    return target.topic
  }

  return {
    ...base,
    async chats() {
      // The list is the saved configuration: a missing name never removes a group.
      const transport = ops.transport()
      return Promise.all(
        ops.chatIds().map(async (chatId) => {
          const name = await chatName(transport, chatId)
          return name === undefined ? { chatId } : { chatId, name }
        }),
      )
    },
    async messages({ chatId, sessionId, cursor, limit = 50 }) {
      const topic = topicFor(chatId, sessionId)
      if (!Number.isInteger(limit) || limit < 1 || limit > 50)
        throw new Error('Lark history limit must be an integer from 1 to 50')
      const page =
        cursor === undefined
          ? {
              sessionId,
              limit,
              endTime: String(Math.floor(Date.now() / 1000) + 1),
              offset: 0,
            }
          : readCursor(cursor, sessionId)
      const transport = ops.transport()
      if (!transport) throw new Error('Lark is not connected')
      const result = topic
        ? await transport.listTopicMessages(topic.threadId, page.token)
        : await transport.searchMessages(chatId, {
            startTime: '0',
            endTime: page.endTime,
            limit: page.limit,
            pageToken: page.token,
          })
      const slice = result.items.slice(page.offset, page.offset + page.limit)
      const messages = (
        await Promise.all(
          slice.map((row) => visibleMessage(row, chatId, sessionId, ops)),
        )
      ).filter((row) => row !== undefined)
      const taken = page.offset + slice.length
      const next =
        taken < result.items.length
          ? { ...page, offset: taken }
          : result.pageToken
            ? { ...page, token: result.pageToken, offset: 0 }
            : undefined
      return {
        messages,
        ...(next && {
          nextCursor: Buffer.from(JSON.stringify(next)).toString('base64url'),
        }),
      }
    },
    submit: (async (
      input:
        | IncomingMessage
        | (SubmitInput &
            ({ sessionId: string } | { newTopic: { title: string } })),
    ) => {
      if (!('chatId' in input)) return base.submit(input)
      const { chatId, author } = input
      const newTopic = 'newTopic' in input
      const title = newTopic ? input.newTopic.title.trim() : undefined
      const name = author.name.trim()
      const id = author.id.trim()
      const text = input.text.trim()
      let transport: LarkTransport
      let topic: IncomingMessage['topic']
      try {
        if (!ops.enabled(chatId)) throw new Error('Lark group is not enabled')
        topic = newTopic ? undefined : topicFor(chatId, input.sessionId)
        if (!id || !name || !text || title === '')
          throw new Error(
            'Lark submit requires text, an author, and a title for a new topic',
          )
        const connected = ops.transport()
        if (!connected) throw new Error('Lark is not connected')
        transport = connected
      } catch (error) {
        throw new LarkSubmitError(errorMessage(error), 'not-sent', {
          cause: error,
        })
      }
      const signed = `${name}: ${text}`
      let posted: LarkSentMessage & { topic?: IncomingMessage['topic'] }
      try {
        posted = await postSigned(transport, chatId, signed, topic)
      } catch (error) {
        throw new LarkSubmitError(errorMessage(error), 'uncertain', {
          cause: error,
        })
      }
      ops.changed(chatId, topic)
      try {
        if (
          topic &&
          posted.topic &&
          (posted.topic.rootId !== topic.rootId ||
            posted.topic.threadId !== topic.threadId)
        )
          throw new Error('Lark returned a different topic')
        let anchor = posted.messageId
        if (newTopic) {
          const opened = await transport.startTopic(anchor, title!)
          if (!opened.messageId || !opened.rootId || !opened.threadId)
            throw new Error('Lark returned an incomplete topic receipt')
          topic = { rootId: opened.rootId, threadId: opened.threadId }
          anchor = opened.messageId
        }
        const message: IncomingMessage = {
          channelId: chatId,
          chatKind: 'group',
          senderId: `sdk:${id}`,
          senderName: name,
          text,
          topic,
          replyToId: anchor,
          raw: {
            sender: { sender_type: 'app' },
            message: {
              chat_id: chatId,
              chat_type: 'group',
              message_id: newTopic ? posted.messageId : anchor,
              create_time: posted.createTime,
              message_type: 'text',
              content: JSON.stringify({ text }),
            },
          } satisfies LarkMessageEvent,
        }
        const receipt = newTopic
          ? await ops.submitNewTopic(message)
          : await base.submit(message)
        if (newTopic) ops.changed(chatId, topic)
        return {
          ...receipt,
          messageId: posted.messageId,
          ...(newTopic && { topic }),
        }
      } catch (error) {
        throw new LarkSubmitError(
          `Lark message ${posted.messageId} was posted, but submit did not complete: ${errorMessage(error)}`,
          'posted',
          { cause: error, messageId: posted.messageId },
        )
      }
    }) as LarkHost['submit'],
    onEvent: ops.onEvent,
  }
}

/** A name is display decoration: any failure leaves the group listed by its chat ID. */
async function chatName(
  transport: LarkTransport | undefined,
  chatId: string,
): Promise<string | undefined> {
  if (!transport?.getChat) return undefined
  try {
    const name = (await transport.getChat(chatId))?.name?.trim()
    return name || undefined
  } catch {
    return undefined
  }
}

async function visibleMessage(
  row: LarkHistoryMessage,
  chatId: string,
  sessionId: string,
  ops: Pick<Operations, 'senderName' | 'ownAppId'>,
): Promise<LarkVisibleMessage | undefined> {
  if (row.deleted || !row.message_id || !row.create_time) return
  const date = new Date(Number(row.create_time))
  if (!Number.isFinite(date.getTime())) return
  const text = messageText({
    chat_id: chatId,
    message_type: row.msg_type ?? '',
    content: row.body?.content ?? '',
    mentions: row.mentions,
  })
  if (!text) return
  const app = row.sender?.sender_type === 'app'
  const sender = row.sender?.id ?? 'unknown'
  return {
    id: row.message_id,
    sessionId,
    role: app ? 'assistant' : 'user',
    text,
    createdAt: date.toISOString(),
    senderName:
      app && sender === ops.ownAppId ? 'Vela' : await ops.senderName(sender),
  }
}

async function postSigned(
  transport: LarkTransport,
  chatId: string,
  text: string,
  topic: IncomingMessage['topic'],
): Promise<LarkSentMessage & { topic?: IncomingMessage['topic'] }> {
  const posted = await (async () => {
    // Anchoring to a root must set reply_in_thread, even for an existing
    // thread. The transport calls that operation startTopic.
    if (topic) {
      const { rootId, threadId, ...receipt } = await transport.startTopic(
        topic.rootId,
        text,
      )
      return { ...receipt, topic: { rootId, threadId } }
    }
    return (await transport.send(chatId, text)) || undefined
  })().catch((error) => {
    throw new Error(`Lark send outcome is uncertain: ${errorMessage(error)}`, {
      cause: error,
    })
  })
  if (!posted?.messageId)
    throw new Error(
      'Lark message may already have been posted, but no message ID was returned; no run was started',
    )
  return posted
}
