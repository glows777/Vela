import { randomUUID } from 'node:crypto'
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

/** The fields used from a `card.action.trigger` callback (v2). */
export interface FeishuCardAction {
  operator?: { open_id?: string }
  context?: { open_chat_id?: string }
  action?: { value?: unknown }
}

export interface FeishuCardResponse {
  toast: { type: 'success' | 'info'; content: string }
}

export interface FeishuCard {
  schema: '2.0'
  header: { title: { tag: 'plain_text'; content: string } }
  body: {
    elements: {
      tag: 'markdown' | 'column_set'
      content?: string
      columns?: {
        tag: 'column'
        width: 'weighted'
        weight: number
        elements: {
          tag: 'button'
          text: { tag: 'plain_text'; content: string }
          type: 'primary' | 'default' | 'danger'
          behaviors: {
            type: 'callback'
            value: { action: string; token: string }
          }[]
        }[]
      }[]
    }[]
  }
}

/** The connection to Feishu: receives message events and sends text to a chat (lark's long connection by default). */
export interface FeishuTransport {
  start(
    onMessage: (event: FeishuMessageEvent) => void,
    onAction: (event: FeishuCardAction) => FeishuCardResponse,
  ): Promise<void>
  stop(): void
  send(chatId: string, text: string): Promise<void>
  reply(messageId: string, text: string): Promise<FeishuSentMessage>
  sendCard(chatId: string, card: FeishuCard, replyToId?: string): Promise<void>
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
  private readonly pending = new Set<Promise<void>>()
  private readonly controls = new Map<
    string,
    {
      msg: IncomingMessage
      choose: (action: 'queue' | 'steer' | 'stop') => boolean
      clear: () => void
    }
  >()
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
    await transport.start(
      (event) => this.receive(event),
      (event) => this.receiveAction(event),
    )
    this.config.logger.info('[feishu] Long connection established')
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.transport?.stop()
    for (const entry of this.controls.values()) entry.clear()
    await Promise.all(this.pending)
  }

  async showRunControls(
    msg: IncomingMessage,
    controls: Parameters<NonNullable<ChannelDefinition['showRunControls']>>[1],
  ): Promise<void> {
    if (
      this.stopped ||
      controls.signal.aborted ||
      !this.transport ||
      messageText((msg.raw as FeishuMessageEvent).message) === undefined
    )
      return
    const token = randomUUID()
    const clear = () => {
      this.controls.delete(token)
      controls.signal.removeEventListener('abort', clear)
    }
    this.controls.set(token, { msg, choose: controls.choose, clear })
    controls.signal.addEventListener('abort', clear, { once: true })
    const card: FeishuCard = {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: 'A run is in progress' } },
      body: {
        elements: [
          {
            tag: 'markdown',
            content:
              'Your message is queued by default. Steer adds it to the current task for one combined reply. Stop cancels the current run and discards this queued message.',
          },
          {
            tag: 'column_set',
            columns: (['queue', 'steer', 'stop'] as const).map((action) => ({
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [
                {
                  tag: 'button',
                  text: {
                    tag: 'plain_text',
                    content: {
                      queue: 'Queue (default)',
                      steer: 'Steer',
                      stop: 'Stop',
                    }[action],
                  },
                  type:
                    action === 'queue'
                      ? 'primary'
                      : action === 'stop'
                        ? 'danger'
                        : 'default',
                  behaviors: [{ type: 'callback', value: { action, token } }],
                },
              ],
            })),
          },
        ],
      },
    }
    try {
      // Control cards are not answers and must not advance the chat-history boundary.
      await this.transport.sendCard(msg.channelId, card, msg.replyToId)
    } catch (error) {
      clear()
      throw error
    }
  }

  private receiveAction(event: FeishuCardAction): FeishuCardResponse {
    const ignored: FeishuCardResponse = {
      toast: {
        type: 'info',
        content: 'This control is unavailable or has expired.',
      },
    }
    const value = event.action?.value
    if (this.stopped || !value || typeof value !== 'object') return ignored
    const { action, token } = value as { action?: unknown; token?: unknown }
    if (
      typeof token !== 'string' ||
      (action !== 'queue' && action !== 'steer' && action !== 'stop')
    )
      return ignored
    const entry = this.controls.get(token)
    const operator = event.operator?.open_id
    if (
      !entry ||
      !operator ||
      event.context?.open_chat_id !== entry.msg.channelId
    )
      return ignored
    const original = entry.msg.raw as FeishuMessageEvent
    if (
      !this.config.chats?.includes(entry.msg.channelId) &&
      !(
        original.message.chat_type === 'p2p' &&
        this.config.owners.includes(operator)
      )
    )
      return ignored
    entry.clear()
    if (!entry.choose(action)) return ignored
    return {
      toast: {
        type: 'success',
        content: {
          queue: 'Message queued.',
          steer: 'Adding the message to the current run.',
          stop: 'Stopping the current run.',
        }[action],
      },
    }
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

  /** The gateway prepares queued input after the preceding reply; Steer prepares it during the run. */
  async prepareMessage(
    msg: IncomingMessage,
    activeMessage?: IncomingMessage,
  ): Promise<IncomingMessage | undefined> {
    if (this.stopped) return
    const event = msg.raw as FeishuMessageEvent
    const activeTrigger = (activeMessage?.raw as FeishuMessageEvent | undefined)
      ?.message
    if (messageText(event.message) === undefined) {
      await this.send({
        channelId: msg.channelId,
        recipientId: msg.senderId,
        replyToId: msg.replyToId,
        text: UNSUPPORTED_MESSAGE,
      })
      return
    }
    // Preserve extension commands, skills and templates; attribution must not hide their leading slash.
    if (msg.text.startsWith('/')) return msg
    const name = await this.senderName(msg.senderId)
    const question = { name, text: msg.text }
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
            (activeTrigger?.create_time &&
              item.create_time &&
              Number(item.create_time) < Number(activeTrigger.create_time)) ||
            (previous &&
              (item.message_id === previous.messageId ||
                Number(item.create_time) <= Number(previous.createTime))) ||
            (item.sender?.sender_type === 'app' &&
              item.sender.id === this.config.appId &&
              (item.msg_type === 'text' || item.msg_type === 'post'))
          )
            break
          if (
            item.deleted ||
            // Other messages can share this millisecond; exclude the known trigger by id.
            (activeTrigger?.message_id &&
              item.message_id === activeTrigger.message_id) ||
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
    const text = messageText(message)
    if (text === '' || !this.messageHandler) return
    // Deliver immediately so the gateway can show run controls, then serialize preparation and replies there.
    const next = Promise.resolve(
      this.messageHandler({
        channelId: message.chat_id,
        senderId,
        senderName: senderId,
        text: text ?? '',
        replyToId,
        raw: event,
      }),
    ).catch((error) =>
      this.config.logger.warn(
        `[feishu] Failed to handle message: ${String(error)}`,
      ),
    )
    this.pending.add(next)
    void next.then(() => this.pending.delete(next))
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
    async start(onMessage, onAction) {
      const dispatcher = new lark.EventDispatcher({})
      dispatcher.register({
        'im.message.receive_v1': (data) =>
          onMessage(data as FeishuMessageEvent),
        'card.action.trigger': (data: FeishuCardAction) => onAction(data),
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
    async sendCard(chatId, card, replyToId) {
      const data = { msg_type: 'interactive', content: JSON.stringify(card) }
      checked(
        replyToId
          ? await client.im.message.reply({
              path: { message_id: replyToId },
              data,
            })
          : await client.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: { ...data, receive_id: chatId },
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
