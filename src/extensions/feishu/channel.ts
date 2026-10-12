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
    chat_id: string
    /** `p2p` or `group` */
    chat_type?: string
    message_type: string
    content: string
    mentions?: { key: string }[]
  }
  sender: { sender_id?: { open_id?: string } }
}

/** The connection to Feishu: receives message events and sends text to a chat (lark's long connection by default). */
export interface FeishuTransport {
  start(onMessage: (event: FeishuMessageEvent) => void): Promise<void>
  stop(): void
  send(chatId: string, text: string): Promise<void>
}

export interface FeishuChannelConfig {
  appId: string
  appSecret: string
  /** These senders (open_id) are owners; all other senders are guests */
  owners: readonly string[]
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
  private messageHandler?: (msg: IncomingMessage) => void
  private transport?: FeishuTransport
  private readonly seen = new Set<string>()

  constructor(config: FeishuChannelConfig) {
    this.config = config
  }

  roleFor(msg: IncomingMessage): Role {
    return this.config.owners.includes(msg.senderId) ? 'owner' : 'guest'
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  async start(): Promise<void> {
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
    this.transport = transport
    await transport.start((event) => this.receive(event))
    this.config.logger.info('[feishu] Long connection established')
  }

  async stop(): Promise<void> {
    this.transport?.stop()
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.transport) {
      this.config.logger.warn(
        `[feishu] Feishu not configured, skipping send: ${message.text.slice(0, 50)}`,
      )
      return
    }
    // A failed send throws: the gateway reports it as channel_error instead of a channel_reply that never arrived
    await this.transport.send(message.channelId, message.text)
  }

  private receive(event: FeishuMessageEvent): void {
    const { message } = event
    if (message.message_id) {
      if (this.seen.has(message.message_id)) return
      this.seen.add(message.message_id)
      if (this.seen.size > SEEN_MESSAGES)
        this.seen.delete(this.seen.values().next().value as string)
    }
    const text = messageText(message)
    if (text === undefined) {
      // Images, files, stickers, ...: tell the sender instead of ignoring the message (in a group only when
      // the bot was mentioned, so a bot that reads all group messages doesn't answer every picture)
      if (message.chat_type === 'group' && !message.mentions?.length) return
      this.send({
        channelId: message.chat_id,
        recipientId: event.sender.sender_id?.open_id ?? 'unknown',
        text: UNSUPPORTED_MESSAGE,
      }).catch((error) =>
        this.config.logger.warn(
          `[feishu] Failed to reply to an unsupported message: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      return
    }
    if (!text || !this.messageHandler) return
    const senderId = event.sender.sender_id?.open_id || 'unknown'
    this.messageHandler({
      // The chat (group or direct) is the conversation: each sender gets one session per chat
      channelId: message.chat_id,
      senderId,
      senderName: senderId,
      text,
      raw: event,
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
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      })
    },
  }
}
