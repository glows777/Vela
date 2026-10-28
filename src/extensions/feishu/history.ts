import type { ImageContent } from '../../extension-api.ts'
import { messageText } from './messages.ts'
import type {
  FeishuHistoryMessage,
  FeishuMessageEvent,
  FeishuSentMessage,
} from './transport.ts'

/** One named line of chat history; `time` is the local send time when the message has one */
export interface ContextLine {
  name: string
  text: string
  time?: string
}

interface GroupContextOptions {
  chatId: string
  message: FeishuMessageEvent['message']
  activeTrigger?: FeishuMessageEvent['message']
  previous?: FeishuSentMessage
  appId: string
  question: ContextLine
  senderName: (id: string) => Promise<string>
  downloadImages: (
    message: FeishuMessageEvent['message'],
    limit: number,
  ) => Promise<ImageContent[]>
}

export async function readGroupContext(
  history: FeishuHistoryMessage[],
  {
    chatId,
    message,
    activeTrigger,
    previous,
    appId,
    question,
    senderName,
    downloadImages,
  }: GroupContextOptions,
): Promise<{ text: string; images: ImageContent[] }> {
  const earlier: ContextLine[] = []
  const seen = new Set<string>()
  const historyImages: ImageContent[][] = []
  let imageCount = 0
  for (const item of history.slice(0, 50)) {
    if (item.message_id && seen.has(item.message_id)) continue
    if (item.message_id) seen.add(item.message_id)
    if (
      (activeTrigger?.create_time &&
        item.create_time &&
        Number(item.create_time) < Number(activeTrigger.create_time)) ||
      (previous &&
        (item.message_id === previous.messageId ||
          Number(item.create_time) <= Number(previous.createTime))) ||
      (item.sender?.sender_type === 'app' && item.sender.id === appId)
    )
      break
    if (
      item.deleted ||
      // Other messages can share this millisecond; exclude the known trigger by id.
      (activeTrigger?.message_id &&
        item.message_id === activeTrigger.message_id) ||
      item.message_id === message.message_id ||
      (message.create_time &&
        Number(item.create_time) > Number(message.create_time))
    )
      continue
    const historyMessage = {
      chat_id: chatId,
      message_type: item.msg_type ?? '',
      content: item.body?.content ?? '',
      mentions: item.mentions,
      message_id: item.message_id,
    }
    const body = messageText(historyMessage)
    if (!body) continue
    const attachments = await downloadImages(historyMessage, 4 - imageCount)
    imageCount += attachments.length
    historyImages.push(attachments)
    earlier.push({
      name: await senderName(item.sender?.id ?? 'unknown'),
      text: body,
      time: messageTime(item.create_time),
    })
  }
  return {
    text: formatGroupContext(earlier.reverse(), question),
    images: historyImages.reverse().flat(),
  }
}

/** The local `HH:MM` for a Feishu `create_time` in milliseconds. */
export function messageTime(
  createTime: string | undefined,
): string | undefined {
  if (!createTime) return undefined
  const date = new Date(Number(createTime))
  if (Number.isNaN(date.getTime())) return undefined
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Already-resolved names and plain text, in chronological order. */
export function formatGroupContext(
  history: readonly ContextLine[],
  question: ContextLine,
): string {
  const named = (item: ContextLine) =>
    `${item.time ? `[${item.time}] ` : ''}${item.name}: ${item.text}`
  return history.length
    ? `[Chat since last reply]\n${history.slice(-50).map(named).join('\n')}\n\n[Question]\n${named(question)}`
    : named(question)
}

/** Full topic history, already fetched in ascending creation order. */
export async function readTopicContext(
  history: FeishuHistoryMessage[],
  options: GroupContextOptions,
): Promise<{ text: string; images: ImageContent[] }> {
  const lines: string[] = []
  const images: ImageContent[] = []
  const seen = new Set<string>()
  for (const item of history) {
    if (
      item.deleted ||
      item.message_id === options.message.message_id ||
      (options.message.create_time &&
        Number(item.create_time) > Number(options.message.create_time))
    )
      continue
    if (item.message_id && seen.has(item.message_id)) continue
    if (item.message_id) seen.add(item.message_id)
    const message = {
      chat_id: options.chatId,
      message_id: item.message_id,
      message_type: item.msg_type ?? '',
      content: item.body?.content ?? '',
      mentions: item.mentions,
    }
    const text = messageText(message)
    if (!text) continue
    const name =
      item.sender?.sender_type === 'app' && item.sender.id === options.appId
        ? 'Vela'
        : await options.senderName(item.sender?.id ?? 'unknown')
    lines.push(`${name}: ${text}`)
    images.push(...(await options.downloadImages(message, 4 - images.length)))
  }
  return {
    text: `[Topic history]\n${lines.join('\n')}\n\n[Question]\n${options.question.name}: ${options.question.text}`,
    images,
  }
}
