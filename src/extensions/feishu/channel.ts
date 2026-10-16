import * as lark from '@larksuiteoapi/node-sdk'
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
  Role,
  VelaLogger,
} from '../../index.ts'

/** The parts of an `im.message.receive_v1` event the channel reads */
export interface FeishuMessageEvent {
  message: {
    message_id?: string
    create_time?: string
    chat_id: string
    /** `p2p` or `group` */
    chat_type?: string
    message_type: string
    content: string
    mentions?: { key: string; id?: { open_id?: string } }[]
  }
  sender: { sender_id?: { open_id?: string } }
}

/** History items returned newest first by Feishu's message API. Times are milliseconds. */
export interface FeishuHistoryMessage {
  message_id?: string
  create_time?: string
  msg_type?: string
  body?: { content?: string }
  sender?: { id?: string; sender_type?: string }
  mentions?: { key: string }[]
  deleted?: boolean
}

export interface FeishuSentMessage {
  messageId: string
  createTime: string
}

/** The connection to Feishu: receives message events and sends text to a chat (lark's long connection by default). */
export interface FeishuTransport {
  start(onMessage: (event: FeishuMessageEvent) => void): Promise<void>
  stop(): void
  send(chatId: string, text: string): Promise<void>
  reply(messageId: string, text: string): Promise<FeishuSentMessage>
  getBotId(): Promise<string>
  getSenderName(openId: string): Promise<string | undefined>
  listMessages(
    chatId: string,
    options: { before?: string; limit: number },
  ): Promise<FeishuHistoryMessage[]>
}

export interface FeishuChannelConfig {
  appId: string
  appSecret: string
  /** These senders (open_id) always have their direct chats enabled. */
  owners: readonly string[]
  /** Every member of these chats is trusted with owner access. */
  chats?: readonly string[]
  logger: VelaLogger
  /** Default: lark's long connection with appId / appSecret */
  transport?: FeishuTransport
}

/** Feishu may deliver an event more than once; this many recent message ids are remembered to drop repeats */
const SEEN_MESSAGES = 1000

export const UNSUPPORTED_MESSAGE =
  'Only text messages are supported; please send your message as text.'

export class FeishuChannel implements ChannelDefinition {
  name = 'feishu'
  description = 'Feishu bot message channel (long-connection mode)'

  private config: FeishuChannelConfig
  private messageHandler?: (msg: IncomingMessage) => void | Promise<void>
  private transport?: FeishuTransport
  private readonly seen = new Set<string>()
  private stopped = false
  private readonly queues = new Map<string, Promise<void>>()
  private botId?: string
  private readonly names = new Map<string, Promise<string>>()
  private readonly lastReplies = new Map<string, FeishuSentMessage>()

  constructor(config: FeishuChannelConfig) {
    this.config = config
  }

  roleFor(): Role {
    return 'owner'
  }

  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void {
    this.messageHandler = handler
  }

  async start(): Promise<void> {
    this.stopped = false
    this.botId = undefined
    const transport =
      this.config.transport ??
      (this.config.appId && this.config.appSecret
        ? larkTransport(this.config.appId, this.config.appSecret)
        : undefined)
    if (!transport) {
      this.config.logger.warn(
        '[feishu] appId / appSecret not configured; channel will not connect to Feishu',
      )
      return
    }
    if (!this.config.chats?.length)
      this.config.logger.info(
        '[feishu] chats is empty; only owners’ direct chats are enabled',
      )
    this.transport = transport
    try {
      this.botId = await transport.getBotId()
    } catch (error) {
      this.config.logger.warn(
        `[feishu] Cannot identify bot; group messages will be ignored: ${String(error)}`,
      )
    }
    await transport.start((event) => this.receive(event))
    this.config.logger.info('[feishu] Long connection established')
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.transport?.stop()
    await Promise.all(this.queues.values())
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.transport) {
      this.config.logger.warn(
        `[feishu] Feishu not configured, skipping send: ${message.text.slice(0, 50)}`,
      )
      return
    }
    // A failed send throws: the gateway reports it as channel_error instead of a channel_reply that never arrived
    if (message.replyToId) {
      const receipt = await this.transport.reply(
        message.replyToId,
        message.text,
      )
      this.lastReplies.set(message.channelId, receipt)
    } else {
      await this.transport.send(message.channelId, message.text)
    }
  }

  /** The Feishu queue waits for the preceding gateway reply before preparing the next input. */
  private async prepareMessage(msg: IncomingMessage): Promise<IncomingMessage> {
    // Preserve extension commands, skills and templates; attribution must not hide their leading slash.
    if (msg.text.startsWith('/')) return msg
    const name = await this.senderName(msg.senderId)
    const question = { name, text: msg.text }
    const event = msg.raw as FeishuMessageEvent
    let text = `${name}: ${msg.text}`
    if (event.message.chat_type === 'group' && this.transport) {
      try {
        const history = await this.transport.listMessages(msg.channelId, {
          before: event.message.create_time,
          limit: 50,
        })
        const previous = this.lastReplies.get(msg.channelId)
        const earlier: { name: string; text: string }[] = []
        const seen = new Set<string>()
        for (const item of history.slice(0, 50)) {
          if (item.message_id && seen.has(item.message_id)) continue
          if (item.message_id) seen.add(item.message_id)
          if (
            (previous &&
              (item.message_id === previous.messageId ||
                Number(item.create_time) <= Number(previous.createTime))) ||
            (item.sender?.sender_type === 'app' &&
              item.sender.id === this.config.appId)
          )
            break
          if (
            item.deleted ||
            item.message_id === event.message.message_id ||
            (event.message.create_time &&
              Number(item.create_time) > Number(event.message.create_time))
          )
            continue
          const body = messageText({
            chat_id: msg.channelId,
            message_type: item.msg_type ?? '',
            content: item.body?.content ?? '',
            mentions: item.mentions,
          })
          if (!body) continue
          earlier.push({
            name: await this.senderName(item.sender?.id ?? 'unknown'),
            text: body,
          })
        }
        text = formatGroupContext(earlier.reverse(), question)
      } catch (error) {
        this.config.logger.warn(
          `[feishu] Failed to fetch context for chat ${msg.channelId}: ${String(error)}`,
        )
      }
    }
    return { ...msg, senderName: name, text }
  }

  private senderName(id: string): Promise<string> {
    let name = this.names.get(id)
    if (!name) {
      name = Promise.resolve()
        .then(() => this.transport?.getSenderName(id))
        .then((value) => value?.trim() || id)
        .catch(() => id)
      this.names.set(id, name)
      if (this.names.size > SEEN_MESSAGES)
        this.names.delete(this.names.keys().next().value as string)
    }
    return name
  }

  private receive(event: FeishuMessageEvent): void {
    if (this.stopped) return
    const { message } = event
    if (message.message_id) {
      if (this.seen.has(message.message_id)) return
      this.seen.add(message.message_id)
      if (this.seen.size > SEEN_MESSAGES)
        this.seen.delete(this.seen.values().next().value as string)
    }
    const senderId = event.sender.sender_id?.open_id || 'unknown'
    const enabled =
      this.config.chats?.includes(message.chat_id) ||
      (message.chat_type === 'p2p' && this.config.owners.includes(senderId))
    if (!enabled) {
      this.config.logger.info(
        `[feishu] ignored message from chat ${message.chat_id}`,
      )
      return
    }
    const group = message.chat_type === 'group'
    if (
      group &&
      (!this.botId ||
        !message.mentions?.some(
          (mention) => mention.id?.open_id === this.botId,
        ))
    )
      return
    // A group reply needs its actual trigger; never accidentally post an unthreaded answer.
    if (group && !message.message_id) return
    const replyToId = group ? message.message_id : undefined
    const previous = this.queues.get(message.chat_id) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        if (this.stopped) return
        const text = messageText(message)
        if (text === undefined) {
          await this.send({
            channelId: message.chat_id,
            recipientId: senderId,
            replyToId,
            text: UNSUPPORTED_MESSAGE,
          })
          return
        }
        if (!text || !this.messageHandler) return
        const prepared = await this.prepareMessage({
          channelId: message.chat_id,
          senderId,
          senderName: senderId,
          text,
          replyToId,
          raw: event,
        })
        if (!this.stopped) await this.messageHandler(prepared)
      })
      .catch((error) =>
        this.config.logger.warn(
          `[feishu] Failed to handle message: ${String(error)}`,
        ),
      )
    this.queues.set(message.chat_id, next)
    void next.then(() => {
      if (this.queues.get(message.chat_id) === next)
        this.queues.delete(message.chat_id)
    })
  }
}

/**
 * Plain text of a text or rich-text (`post`) message, with `@` mentions removed; undefined for other message
 * types. Malformed content counts as empty.
 */
export function messageText(
  message: FeishuMessageEvent['message'],
): string | undefined {
  if (message.message_type !== 'text' && message.message_type !== 'post')
    return undefined
  let content: unknown
  try {
    content = JSON.parse(message.content)
  } catch {
    return ''
  }
  if (!content || typeof content !== 'object') return ''
  let text =
    message.message_type === 'text'
      ? String((content as { text?: unknown }).text ?? '')
      : postText(content)
  // Strip @ mention markers (`@_user_1`)
  for (const mention of message.mentions ?? [])
    text = text.replaceAll(mention.key, '')
  return text.trim()
}

/** A post is `{ title, content: [[element]] }`, possibly wrapped in a language key (`{ zh_cn: {...} }`) */
function postText(content: object): string {
  const post = ('content' in content ? content : Object.values(content)[0]) as
    | { title?: unknown; content?: unknown }
    | undefined
  if (!post || typeof post !== 'object') return ''
  const lines = Array.isArray(post.content)
    ? post.content.map((line) =>
        Array.isArray(line)
          ? line
              .map((element: { tag?: string; text?: unknown }) =>
                // `at` elements are mentions, images and media have no text
                element?.tag === 'text' ||
                element?.tag === 'a' ||
                element?.tag === 'code_block'
                  ? String(element.text ?? '')
                  : '',
              )
              .join('')
          : '',
      )
    : []
  const title = typeof post.title === 'string' && post.title ? [post.title] : []
  return [...title, ...lines].join('\n')
}

/** Already-resolved names and plain text, in chronological order. */
export function formatGroupContext(
  history: readonly { name: string; text: string }[],
  question: { name: string; text: string },
): string {
  const named = (item: { name: string; text: string }) =>
    `${item.name}: ${item.text}`
  return history.length
    ? `[Chat since last reply]\n${history.slice(-50).map(named).join('\n')}\n\n[Question]\n${named(question)}`
    : named(question)
}

function checked<T extends { code?: number; msg?: string }>(response: T): T {
  if (response.code !== undefined && response.code !== 0)
    throw new Error(
      `Feishu ${response.code}: ${response.msg ?? 'request failed'}`,
    )
  return response
}

function larkTransport(appId: string, appSecret: string): FeishuTransport {
  const client = new lark.Client({ appId, appSecret })
  let wsClient: lark.WSClient | undefined
  return {
    async start(onMessage) {
      const dispatcher = new lark.EventDispatcher({})
      dispatcher.register({
        'im.message.receive_v1': (data) =>
          onMessage(data as FeishuMessageEvent),
      })
      wsClient = new lark.WSClient({
        appId,
        appSecret,
        loggerLevel: lark.LoggerLevel.warn,
      })
      await wsClient.start({ eventDispatcher: dispatcher })
    },
    stop() {
      wsClient?.close()
    },
    async send(chatId, text) {
      checked(
        await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
        }),
      )
    },
    async reply(messageId, text) {
      const response = checked(
        await client.im.message.reply({
          path: { message_id: messageId },
          data: { msg_type: 'text', content: JSON.stringify({ text }) },
        }),
      )
      const data = response.data
      if (!data?.message_id || !data.create_time)
        throw new Error('Feishu reply returned no message receipt')
      return { messageId: data.message_id, createTime: data.create_time }
    },
    async getBotId() {
      const response = checked(
        await client.request<{
          code?: number
          msg?: string
          bot?: { open_id?: string }
        }>({ url: '/open-apis/bot/v3/info', method: 'GET' }),
      )
      if (!response.bot?.open_id)
        throw new Error('Feishu bot info returned no open_id')
      return response.bot.open_id
    },
    async getSenderName(openId) {
      const response = checked(
        await client.contact.user.get({
          path: { user_id: openId },
          params: { user_id_type: 'open_id' },
        }),
      )
      return response.data?.user?.name
    },
    async listMessages(chatId, { before, limit }) {
      const response = checked(
        await client.im.message.list({
          params: {
            container_id_type: 'chat',
            container_id: chatId,
            sort_type: 'ByCreateTimeDesc',
            page_size: Math.min(50, limit),
            ...(before
              ? { end_time: String(Math.floor(Number(before) / 1000) + 1) }
              : {}),
          },
        }),
      )
      return response.data?.items ?? []
    },
  }
}
