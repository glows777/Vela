import type { ImageContent } from '../extension-api.ts'
import type {
  ChannelAdapterContext,
  ChannelInboundAttachment,
  ChannelOutboundMessage,
} from '../runtime/channels.ts'
import type { VelaLogger } from '../shared/logger.ts'
import { FileTooLarge } from './attachments.ts'
import {
  formatGroupContext,
  messageTime,
  readGroupContext,
  readTopicContext,
} from './history.ts'
import { errorMessage } from './log.ts'
import { imageKeys, safeName } from './messages.ts'
import type {
  LarkMessageEvent,
  LarkSentMessage,
  LarkTransport,
} from './transport.ts'

const IMG_REF_PREFIX = 'lark-img:'
const FILE_REF_PREFIX = 'lark-file:'

const UNSUPPORTED_MESSAGE =
  'Only text, images and files are supported; please send one of these message types.'

function encodeLarkRef(
  prefix: typeof IMG_REF_PREFIX | typeof FILE_REF_PREFIX,
  messageId: string,
  key: string,
): string {
  return `${prefix}${encodeURIComponent(messageId)}:${encodeURIComponent(key)}`
}

export function decodeLarkRef(
  ref: string,
): { kind: 'image' | 'file'; messageId: string; key: string } | undefined {
  let kind: 'image' | 'file'
  let body: string
  if (ref.startsWith(IMG_REF_PREFIX)) {
    kind = 'image'
    body = ref.slice(IMG_REF_PREFIX.length)
  } else if (ref.startsWith(FILE_REF_PREFIX)) {
    kind = 'file'
    body = ref.slice(FILE_REF_PREFIX.length)
  } else {
    return undefined
  }
  const sep = body.indexOf(':')
  if (sep <= 0) return undefined
  const messageId = decodeURIComponent(body.slice(0, sep))
  const key = decodeURIComponent(body.slice(sep + 1))
  if (!messageId || !key) return undefined
  return { kind, messageId, key }
}

function extractFileDescriptor(message: LarkMessageEvent['message']): {
  key: string
  name: string
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(message.content)
  } catch {
    throw new Error('Invalid file message content')
  }
  const fileKey =
    parsed &&
    typeof parsed === 'object' &&
    'file_key' in parsed &&
    typeof (parsed as { file_key?: unknown }).file_key === 'string'
      ? (parsed as { file_key: string }).file_key
      : undefined
  if (!fileKey) throw new Error('File has no file_key')
  const rawName =
    parsed &&
    typeof parsed === 'object' &&
    'file_name' in parsed &&
    typeof (parsed as { file_name?: unknown }).file_name === 'string'
      ? (parsed as { file_name: string }).file_name
      : 'file'
  return { key: fileKey, name: safeName(rawName) }
}

export async function processLarkInboundEvent(params: {
  event: LarkMessageEvent
  meta: {
    senderId: string
    group: boolean
    mentioned: boolean
    passive: boolean
    replyToId?: string
    requireExistingSession: boolean
    topic?: { rootId: string; threadId: string }
    rawText?: string
  }
  ctx: ChannelAdapterContext
  transport: LarkTransport | undefined
  appId: string
  logger: VelaLogger
  isStopped: () => boolean
  senderName: (id: string) => Promise<string>
  groupBoundary: (chatId: string) => LarkSentMessage | undefined
  noteHandled: (chatId: string, messageId: string, createTime: string) => void
  deliver: (msg: ChannelOutboundMessage) => Promise<unknown>
  notePendingInbound: (input: {
    externalChatId: string
    threadId?: string
    messageId?: string
    replyToId?: string
    text: string
    isDirect: boolean
  }) => void
}): Promise<void> {
  const {
    event,
    meta,
    ctx,
    transport,
    appId,
    logger,
    isStopped,
    senderName,
    groupBoundary,
    noteHandled,
    deliver,
    notePendingInbound,
  } = params
  if (isStopped()) return
  const { message } = event

  if (meta.rawText === undefined) {
    if (transport && !meta.passive) {
      await deliver({
        outboxId: `unsupported-${message.message_id ?? Date.now()}`,
        kind: 'reply',
        channel: 'lark',
        externalChatId: message.chat_id,
        ...(meta.topic ? { threadId: meta.topic.threadId } : {}),
        ...(meta.replyToId ? { replyToMessageId: meta.replyToId } : {}),
        recipientId: meta.senderId,
        text: UNSUPPORTED_MESSAGE,
      })
    }
    return
  }

  const triggerAttachments: ChannelInboundAttachment[] = []
  const triggerRefs = new Set<string>()
  let baseText = meta.rawText
  const attachmentType =
    message.message_type === 'file' ? 'file' : ('image' as const)

  const reportFailure = async (error: unknown): Promise<void> => {
    if (meta.passive) {
      logger.warn(
        `[lark] Passive attachment preparation failed: ${errorMessage(error)}`,
      )
      return
    }
    if (!transport) return
    await deliver({
      outboxId: `att-err-${message.message_id ?? Date.now()}`,
      kind: 'reply',
      channel: 'lark',
      externalChatId: message.chat_id,
      ...(meta.topic ? { threadId: meta.topic.threadId } : {}),
      ...(meta.replyToId ? { replyToMessageId: meta.replyToId } : {}),
      recipientId: meta.senderId,
      text:
        error instanceof FileTooLarge
          ? 'File too large. The limit is 20MB.'
          : `Couldn't download the ${attachmentType}: ${errorMessage(error)}. Check the bot's im:resource permission and retry.`,
    })
  }

  if (message.message_id) {
    const keys = imageKeys(message)
    for (let i = 0; i < keys.length; i++) {
      const ref = encodeLarkRef(IMG_REF_PREFIX, message.message_id, keys[i]!)
      triggerRefs.add(ref)
      triggerAttachments.push({
        name: `image-${i + 1}.png`,
        ref,
        inlineOnly: true,
      })
    }
    if (message.message_type === 'file') {
      try {
        const { key, name } = extractFileDescriptor(message)
        const ref = encodeLarkRef(FILE_REF_PREFIX, message.message_id, key)
        triggerRefs.add(ref)
        triggerAttachments.push({ name, ref })
        baseText = `[file: ${name}]`
      } catch (error) {
        await reportFailure(error)
        return
      }
    }
  }

  const name =
    event.sender.sender_type === 'app'
      ? meta.senderId
      : await senderName(meta.senderId)

  const isSlash = !meta.passive && baseText.startsWith('/')
  let formattedText = baseText
  const historyRefs = new Map<string, ChannelInboundAttachment>()
  const historyImageOrder: ChannelInboundAttachment[] = []

  const collectHistoryImages = async (
    histMsg: LarkMessageEvent['message'],
    limit: number,
  ): Promise<ImageContent[]> => {
    if (limit <= 0 || !histMsg.message_id) return []
    const keys = imageKeys(histMsg).slice(-limit)
    const placeholders: ImageContent[] = []
    for (const key of keys) {
      const ref = encodeLarkRef(IMG_REF_PREFIX, histMsg.message_id, key)
      if (!historyRefs.has(ref)) {
        historyRefs.set(ref, {
          name: `history-${historyRefs.size + 1}.png`,
          ref,
          inlineOnly: true,
        })
      }
      placeholders.push({ type: 'image', data: ref, mimeType: 'image/png' })
    }
    return placeholders
  }

  const existingTopicBinding = meta.topic
    ? ctx
        .listBindings?.({ channel: 'lark', enabledOnly: true })
        ?.find(
          (b) =>
            b.externalId === message.chat_id &&
            b.threadId === meta.topic!.threadId,
        )
    : undefined
  const isNewTopic = Boolean(
    meta.topic && !meta.requireExistingSession && !existingTopicBinding,
  )

  if (!isSlash) {
    const question = {
      name,
      text: baseText,
      time:
        meta.group && !meta.topic
          ? messageTime(message.create_time)
          : undefined,
    }
    formattedText = formatGroupContext([], question)
    if (!meta.passive && (!meta.topic || isNewTopic)) {
      if (meta.topic && transport) {
        try {
          const history = []
          let pageToken: string | undefined
          do {
            const page = await transport.listTopicMessages(
              meta.topic.threadId,
              pageToken,
            )
            history.push(...page.items)
            pageToken = page.pageToken
          } while (pageToken)
          const context = await readTopicContext(history, {
            chatId: message.chat_id,
            message,
            appId,
            question,
            senderName,
            downloadImages: collectHistoryImages,
          })
          formattedText = context.text
          for (const img of context.images) {
            const att = historyRefs.get(img.data)
            if (att) historyImageOrder.push(att)
          }
        } catch (error) {
          await deliver({
            outboxId: `topic-hist-err-${message.message_id ?? Date.now()}`,
            kind: 'reply',
            channel: 'lark',
            externalChatId: message.chat_id,
            threadId: meta.topic.threadId,
            ...(meta.replyToId ? { replyToMessageId: meta.replyToId } : {}),
            recipientId: meta.senderId,
            text: `Couldn't read the topic history: ${errorMessage(error)}. Check im:message:readonly and im:message.group_msg permissions and retry.`,
          })
          return
        }
      } else if (meta.group && transport) {
        try {
          const history = await transport.listMessages(message.chat_id, {
            before: message.create_time,
            limit: 50,
          })
          const context = await readGroupContext(history, {
            chatId: message.chat_id,
            message,
            previous: groupBoundary(message.chat_id),
            appId,
            question,
            senderName,
            downloadImages: collectHistoryImages,
          })
          formattedText = context.text
          for (const img of context.images) {
            const att = historyRefs.get(img.data)
            if (att) historyImageOrder.push(att)
          }
        } catch (error) {
          logger.warn(
            `[lark] Failed to fetch context for chat ${message.chat_id}: ${String(error)}. History images require im:resource permission.`,
          )
        }
      }
    }
  }

  const dedupeKey = message.message_id
    ? `lark:${message.message_id}`
    : `lark:${message.chat_id}:${message.create_time ?? Date.now()}:${meta.senderId}`

  if (!meta.passive) {
    notePendingInbound({
      externalChatId: message.chat_id,
      threadId: meta.topic?.threadId,
      messageId: message.message_id,
      replyToId: meta.replyToId,
      text: baseText,
      isDirect: !meta.group,
    })
  }

  const submitIngest = async (
    atts: ChannelInboundAttachment[],
  ): Promise<void> => {
    await ctx.ingest({
      channel: 'lark',
      dedupeKey,
      externalChatId: message.chat_id,
      kind: meta.group ? 'group' : 'direct',
      ...(meta.topic ? { threadId: meta.topic.threadId } : {}),
      ...(meta.replyToId ? { messageId: meta.replyToId } : {}),
      senderId: meta.senderId,
      senderName: name,
      text: formattedText,
      rawText: baseText,
      preformatted: !isSlash,
      mentioned: meta.mentioned,
      mentionRecipient: meta.group && Boolean(meta.topic),
      passive: meta.passive,
      // Passive top-level Lark messages batch into an evaluation run where the model may call skip_reply.
      wake: true,
      requireExistingSession: meta.requireExistingSession,
      ...(atts.length > 0 ? { attachments: atts } : {}),
      timestamp: message.create_time
        ? new Date(Number(message.create_time)).toISOString()
        : new Date().toISOString(),
      raw: event,
    })
  }

  const initialAttachments = [...historyImageOrder, ...triggerAttachments]
  try {
    await submitIngest(initialAttachments)
    if (!meta.passive && message.message_id && message.create_time) {
      noteHandled(message.chat_id, message.message_id, message.create_time)
    }
  } catch (error) {
    if (error instanceof FileTooLarge && historyImageOrder.length > 0) {
      try {
        await submitIngest([...triggerAttachments])
        if (!meta.passive && message.message_id && message.create_time) {
          noteHandled(message.chat_id, message.message_id, message.create_time)
        }
        return
      } catch (retryError) {
        await reportFailure(retryError)
        return
      }
    }
    if (triggerRefs.size > 0) {
      await reportFailure(error)
      return
    }
    throw error
  }
}
