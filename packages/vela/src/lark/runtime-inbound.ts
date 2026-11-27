import type { ImageContent } from '../extension-api.ts'
import type {
  ChannelAdapterContext,
  ChannelInboundAttachment,
  ChannelIngestReceipt,
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

export function raceWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException('Aborted', 'AbortError'),
    )
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
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
  signal?: AbortSignal
  senderName: (id: string) => Promise<string>
  groupBoundary: (chatId: string) => LarkSentMessage | undefined
  noteHandled: (chatId: string, messageId: string, createTime: string) => void
  deliver: (msg: ChannelOutboundMessage) => Promise<unknown>
  preflightAttachment?: (ref: string, signal?: AbortSignal) => Promise<void>
  noteAdmittedInbound: (info: {
    inboxEventId: string
    externalChatId: string
    threadId?: string
    messageId?: string
    replyToId?: string
    text: string
    isDirect: boolean
    passive?: boolean
  }) => void
}): Promise<boolean> {
  const {
    event,
    meta,
    ctx,
    transport,
    appId,
    logger,
    isStopped,
    signal,
    senderName,
    groupBoundary,
    noteHandled,
    deliver,
    preflightAttachment,
    noteAdmittedInbound,
  } = params
  if (isStopped() || signal?.aborted) return false
  const { message } = event

  const existingTopicBinding = meta.topic
    ? ctx
        .listBindings?.({ channel: 'lark', enabledOnly: true })
        ?.find(
          (b) =>
            b.externalId === message.chat_id &&
            b.threadId === meta.topic!.threadId,
        )
    : undefined
  if (meta.requireExistingSession && !existingTopicBinding) {
    return false
  }

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
    return true
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
        name: `image-${i + 1}`,
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
        return false
      }
    }
  }

  const name =
    event.sender.sender_type === 'app'
      ? meta.senderId
      : await raceWithSignal(senderName(meta.senderId), signal)
  if (isStopped() || signal?.aborted) return false

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
          name: `history-${historyRefs.size + 1}`,
          ref,
          inlineOnly: true,
        })
      }
      placeholders.push({ type: 'image', data: ref, mimeType: 'image/png' })
    }
    return placeholders
  }

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
            const page = await raceWithSignal(
              transport.listTopicMessages(meta.topic.threadId, pageToken),
              signal,
            )
            history.push(...page.items)
            pageToken = page.pageToken
          } while (pageToken)
          const context = await readTopicContext(history, {
            chatId: message.chat_id,
            message,
            appId,
            question,
            senderName: (id) => raceWithSignal(senderName(id), signal),
            downloadImages: collectHistoryImages,
          })
          formattedText = context.text
          for (const img of context.images) {
            const att = historyRefs.get(img.data)
            if (att) historyImageOrder.push(att)
          }
        } catch (error) {
          if (isStopped() || signal?.aborted) return false
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
          return false
        }
      } else if (meta.group && transport) {
        try {
          const history = await raceWithSignal(
            transport.listMessages(message.chat_id, {
              before: message.create_time,
              limit: 50,
            }),
            signal,
          )
          const context = await readGroupContext(history, {
            chatId: message.chat_id,
            message,
            previous: groupBoundary(message.chat_id),
            appId,
            question,
            senderName: (id) => raceWithSignal(senderName(id), signal),
            downloadImages: collectHistoryImages,
          })
          formattedText = context.text
          for (const img of context.images) {
            const att = historyRefs.get(img.data)
            if (att) historyImageOrder.push(att)
          }
        } catch (error) {
          if (isStopped() || signal?.aborted) return false
          logger.warn(
            `[lark] Failed to fetch context for chat ${message.chat_id}: ${String(error)}. History images require im:resource permission.`,
          )
        }
      }
    }
  }

  if (isStopped() || signal?.aborted) return false

  const dedupeKey = message.message_id
    ? `lark:${message.message_id}`
    : `lark:${message.chat_id}:${message.create_time ?? Date.now()}:${meta.senderId}`

  const validHistoryImages: ChannelInboundAttachment[] = []
  if (historyImageOrder.length > 0 && preflightAttachment) {
    for (const att of historyImageOrder) {
      if (isStopped() || signal?.aborted) return false
      try {
        await preflightAttachment(att.ref, signal)
        validHistoryImages.push(att)
      } catch (error) {
        logger.warn(
          `[lark] Skipping unreadable historical image ${att.name}: ${errorMessage(error)}`,
        )
      }
    }
  } else {
    validHistoryImages.push(...historyImageOrder)
  }
  if (isStopped() || signal?.aborted) return false

  const submitIngest = async (
    atts: ChannelInboundAttachment[],
  ): Promise<ChannelIngestReceipt | undefined> => {
    const payload = {
      channel: 'lark',
      dedupeKey,
      externalChatId: message.chat_id,
      kind: meta.group ? ('group' as const) : ('direct' as const),
      ...(meta.topic ? { threadId: meta.topic.threadId } : {}),
      ...(meta.topic?.rootId ? { threadRootId: meta.topic.rootId } : {}),
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
    }
    if (ctx.ingestWithReceipt) {
      return ctx.ingestWithReceipt(payload)
    }
    await ctx.ingest(payload)
    return undefined
  }

  const initialAttachments = [...validHistoryImages, ...triggerAttachments]
  try {
    const receipt = await submitIngest(initialAttachments)
    if (receipt && !receipt.admitted) {
      return receipt.reason === 'duplicate'
    }
    if (!receipt?.shortcut && receipt?.inboxEventId) {
      noteAdmittedInbound({
        inboxEventId: receipt.inboxEventId,
        externalChatId: message.chat_id,
        threadId: meta.topic?.threadId,
        messageId: message.message_id,
        replyToId: meta.replyToId,
        text: baseText,
        isDirect: !meta.group,
        passive: meta.passive,
      })
    }
    if (!meta.passive && message.message_id && message.create_time) {
      noteHandled(message.chat_id, message.message_id, message.create_time)
    }
    return true
  } catch (error) {
    if (error instanceof FileTooLarge && validHistoryImages.length > 0) {
      try {
        const retryReceipt = await submitIngest([...triggerAttachments])
        if (retryReceipt && !retryReceipt.admitted) {
          return retryReceipt.reason === 'duplicate'
        }
        if (!retryReceipt?.shortcut && retryReceipt?.inboxEventId) {
          noteAdmittedInbound({
            inboxEventId: retryReceipt.inboxEventId,
            externalChatId: message.chat_id,
            threadId: meta.topic?.threadId,
            messageId: message.message_id,
            replyToId: meta.replyToId,
            text: baseText,
            isDirect: !meta.group,
            passive: meta.passive,
          })
        }
        if (!meta.passive && message.message_id && message.create_time) {
          noteHandled(message.chat_id, message.message_id, message.create_time)
        }
        return true
      } catch (retryError) {
        await reportFailure(retryError)
        return false
      }
    }
    if (triggerRefs.size > 0) {
      await reportFailure(error)
      return false
    }
    throw error
  }
}
