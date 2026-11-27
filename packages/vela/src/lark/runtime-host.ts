import { Buffer } from 'node:buffer'
import type {
  ChannelAdapterContext,
  ChannelBindingKind,
  ChannelHostSubmitInput,
  ChannelHostSubmitResult,
} from '../runtime/channels.ts'
import type {
  RuntimeMessagePage,
  RuntimeMessageRecord,
} from '../runtime/messages.ts'
import { errorMessage } from './log.ts'
import { messageText } from './messages.ts'
import type {
  LarkHistoryMessage,
  LarkMessageEvent,
  LarkSentMessage,
  LarkTransport,
} from './transport.ts'

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
    ) {
      return page
    }
  } catch {
    // Malformed cursor fails locally without querying Lark.
  }
  throw new Error('Invalid Lark history cursor')
}

async function toRuntimeMessageRecord(
  row: LarkHistoryMessage,
  chatId: string,
  sessionId: string,
  ownAppId: string,
  senderName: (id: string) => Promise<string>,
): Promise<RuntimeMessageRecord | undefined> {
  if (row.deleted || !row.message_id || !row.create_time) return undefined
  const date = new Date(Number(row.create_time))
  if (!Number.isFinite(date.getTime())) return undefined
  const text = messageText({
    chat_id: chatId,
    message_type: row.msg_type ?? '',
    content: row.body?.content ?? '',
    mentions: row.mentions,
  })
  if (!text) return undefined
  const fromApp =
    row.sender?.sender_type === 'app' &&
    (!ownAppId || row.sender.id === ownAppId)
  if (fromApp) {
    return {
      id: row.message_id,
      sessionId,
      runId: null,
      seq: 0,
      kind: 'message',
      role: 'assistant',
      text,
      content: text,
      senderName: 'Vela',
      createdAt: date.toISOString(),
    }
  }
  const signed = text.match(/^([^:\n]+): ([\s\S]*)$/)
  if (row.sender?.sender_type === 'app' && signed) {
    return {
      id: row.message_id,
      sessionId,
      runId: null,
      seq: 0,
      kind: 'message',
      role: 'user',
      text: signed[2]!,
      content: signed[2]!,
      senderName: signed[1]!,
      createdAt: date.toISOString(),
    }
  }
  const resolvedName = await senderName(row.sender?.id ?? 'unknown')
  return {
    id: row.message_id,
    sessionId,
    runId: null,
    seq: 0,
    kind: 'message',
    role: 'user',
    text,
    content: text,
    ...(row.sender?.id ? { senderId: row.sender.id } : {}),
    senderName: resolvedName,
    createdAt: date.toISOString(),
  }
}

export async function listLarkRuntimeMessages(params: {
  sessionId: string
  externalChatId: string
  threadId?: string | null
  kind: ChannelBindingKind
  cursor?: string
  limit?: number
  ownAppId: string
  transport?: LarkTransport
  senderName: (id: string) => Promise<string>
}): Promise<RuntimeMessagePage> {
  const {
    sessionId,
    externalChatId,
    threadId,
    cursor,
    limit = 50,
    ownAppId,
    transport,
    senderName,
  } = params
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('Lark history limit must be an integer from 1 to 50')
  }
  const page =
    cursor === undefined
      ? {
          sessionId,
          limit,
          endTime: String(Math.floor(Date.now() / 1000) + 1),
          offset: 0,
        }
      : readCursor(cursor, sessionId)
  if (!transport) throw new Error('Lark is not connected')

  const result = threadId
    ? await transport.listTopicMessages(threadId, page.token)
    : await transport.searchMessages(externalChatId, {
        startTime: '0',
        endTime: page.endTime,
        limit: page.limit,
        pageToken: page.token,
      })

  const slice = result.items.slice(page.offset, page.offset + page.limit)
  const records = (
    await Promise.all(
      slice.map((row) =>
        toRuntimeMessageRecord(
          row,
          externalChatId,
          sessionId,
          ownAppId,
          senderName,
        ),
      ),
    )
  ).filter((row): row is RuntimeMessageRecord => row !== undefined)
  const taken = page.offset + slice.length
  const next =
    taken < result.items.length
      ? { ...page, offset: taken }
      : result.pageToken
        ? { ...page, token: result.pageToken, offset: 0 }
        : undefined
  return {
    messages: records,
    ...(next
      ? { nextCursor: Buffer.from(JSON.stringify(next)).toString('base64url') }
      : {}),
  }
}

export async function submitLarkRuntimeHostMessage(params: {
  input: ChannelHostSubmitInput
  ctx?: ChannelAdapterContext
  transport?: LarkTransport
  isConnected: () => boolean
  isChatEnabled: (chatId: string) => boolean
  getTopicRoot?: (threadId: string) => string | undefined
  rememberTopicRoot: (threadId: string, rootId: string) => void
  noteHostInbound?: (info: {
    externalChatId: string
    threadId?: string
    messageId: string
    replyToId: string
    text: string
  }) => void
}): Promise<ChannelHostSubmitResult> {
  const { input, ctx, transport, isConnected, isChatEnabled } = params
  const chatId = input.chatId
  const title = input.newTopic ? input.newTopic.title.trim() : undefined
  const name = input.author.name.trim()
  const id = input.author.id.trim()
  const text = input.text.trim()

  if (!isChatEnabled(chatId)) {
    return { outcome: 'not-sent', error: 'Lark group is not enabled' }
  }
  let targetThreadId: string | undefined
  if (input.newTopic) {
    if (title === '') {
      return {
        outcome: 'not-sent',
        error:
          'Lark submit requires text, an author, and a title for a new topic',
      }
    }
  } else {
    if (!input.sessionId) {
      return {
        outcome: 'not-sent',
        error: 'Unknown Lark group or topic session',
      }
    }
    const bindings =
      ctx?.listBindings?.({ channel: 'lark', enabledOnly: true }) ?? []
    const rootBinding = bindings.find(
      (b) => b.externalId === chatId && !b.threadId,
    )
    const session = ctx?.getSession?.(input.sessionId)
    const isRootHub =
      Boolean(rootBinding?.projectId) &&
      session?.kind === 'hub' &&
      session.projectId === rootBinding?.projectId
    if (!isRootHub && rootBinding?.sessionId !== input.sessionId) {
      const topicBinding = bindings.find(
        (b) => b.externalId === chatId && b.sessionId === input.sessionId,
      )
      if (!topicBinding?.threadId) {
        return {
          outcome: 'not-sent',
          error: 'Unknown Lark group or topic session',
        }
      }
      targetThreadId = topicBinding.threadId
    }
  }

  if (!id || !name || !text) {
    return {
      outcome: 'not-sent',
      error:
        'Lark submit requires text, an author, and a title for a new topic',
    }
  }
  if (!ctx || !transport || !isConnected()) {
    return { outcome: 'not-sent', error: 'Lark is not connected' }
  }

  const signed = `${name}: ${text}`
  let posted: LarkSentMessage & { topic?: { rootId: string; threadId: string } }
  try {
    if (!targetThreadId) {
      const sent = await transport.send(chatId, signed)
      if (!sent?.messageId) {
        throw new Error('Lark send returned no message receipt')
      }
      posted = sent
    } else {
      const replyTarget =
        params.getTopicRoot?.(targetThreadId) ?? targetThreadId
      posted = await transport.reply(replyTarget, signed, undefined)
    }
  } catch (error) {
    return { outcome: 'uncertain', error: errorMessage(error) }
  }

  try {
    let topic: { rootId: string; threadId: string } | undefined
    let anchor = posted.messageId
    if (targetThreadId) {
      const resolvedRoot =
        posted.topic?.rootId ?? params.getTopicRoot?.(targetThreadId)
      if (posted.topic?.threadId && posted.topic.threadId !== targetThreadId) {
        throw new Error('Lark returned a different topic')
      }
      if (resolvedRoot) {
        topic = { rootId: resolvedRoot, threadId: targetThreadId }
        params.rememberTopicRoot(targetThreadId, resolvedRoot)
      }
    } else if (input.newTopic) {
      const opened = await transport.startTopic(anchor, title!)
      if (!opened.messageId || !opened.rootId || !opened.threadId) {
        throw new Error('Lark returned an incomplete topic receipt')
      }
      topic = { rootId: opened.rootId, threadId: opened.threadId }
      params.rememberTopicRoot(opened.threadId, opened.rootId)
      anchor = opened.messageId
    }

    const dedupeId = input.newTopic ? posted.messageId : anchor
    const threadId = topic?.threadId ?? targetThreadId
    params.noteHostInbound?.({
      externalChatId: chatId,
      threadId,
      messageId: dedupeId,
      replyToId: anchor,
      text,
    })

    const rawEvent: LarkMessageEvent = {
      sender: { sender_type: 'app' },
      message: {
        chat_id: chatId,
        chat_type: 'group',
        message_id: dedupeId,
        create_time: posted.createTime,
        message_type: 'text',
        content: JSON.stringify({ text }),
        ...(threadId ? { thread_id: threadId } : {}),
        ...(topic?.rootId ? { root_id: topic.rootId } : {}),
      },
    }

    await ctx.ingest({
      channel: 'lark',
      dedupeKey: `lark:${dedupeId}`,
      externalChatId: chatId,
      kind: 'group',
      ...(threadId ? { threadId } : {}),
      messageId: anchor,
      senderId: `sdk:${id}`,
      senderName: name,
      text: signed,
      rawText: text,
      preformatted: true,
      mentioned: true,
      mentionRecipient: Boolean(threadId),
      passive: false,
      wake: true,
      timestamp: new Date().toISOString(),
      raw: rawEvent,
    })

    const bindings =
      ctx.listBindings?.({ channel: 'lark', enabledOnly: true }) ?? []
    let resolvedSessionId = input.sessionId
    if (threadId) {
      const b = bindings.find(
        (row) => row.externalId === chatId && row.threadId === threadId,
      )
      if (b?.sessionId) resolvedSessionId = b.sessionId
    } else {
      const root = bindings.find(
        (row) => row.externalId === chatId && !row.threadId,
      )
      if (root?.sessionId) {
        resolvedSessionId = root.sessionId
      } else if (root?.projectId) {
        resolvedSessionId =
          ctx.getProject?.(root.projectId)?.hubSessionId ?? resolvedSessionId
      }
    }

    return {
      outcome: 'posted',
      ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
      messageId: posted.messageId,
      ...(topic ? { topic } : {}),
    }
  } catch (error) {
    return {
      outcome: 'posted',
      messageId: posted.messageId,
      error: `Lark message ${posted.messageId} was posted, but submit did not complete: ${errorMessage(error)}`,
    }
  }
}
