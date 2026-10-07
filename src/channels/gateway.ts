import type { ModelMessage } from 'ai'
import { errorMessage, silentLogger, type VelaLogger } from '../logger'
import { toSessionId, type VelaSession } from '../vela-session'
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from './types'

interface GatewayOptions {
  /** 按 id 打开（或取回）会话；每个通道发送者一个会话 */
  session: (id: string) => VelaSession
  logger?: VelaLogger
}

/** 通道发送者对应的会话 id，例如 `feishu-ou_123`。 */
export const channelSessionId = (channel: string, senderId: string) =>
  toSessionId(`${channel}-${senderId}`)

export class ChannelGateway {
  private channels = new Map<string, ChannelDefinition>()
  /** 每个会话串行处理消息：同一发送者连发两条时，第二条等第一条跑完 */
  private queues = new Map<string, Promise<void>>()
  private resumed = new Set<string>()
  private active = new Set<VelaSession>()
  private stopped = false
  private readonly logger: VelaLogger

  constructor(private options: GatewayOptions) {
    this.logger = options.logger ?? silentLogger
  }

  register(channel: ChannelDefinition): void {
    this.channels.set(channel.name, channel)

    channel.onMessage?.((msg: IncomingMessage) => {
      void this.handleIncoming(channel.name, msg)
    })
  }

  async startAll(): Promise<void> {
    this.stopped = false
    for (const [name, ch] of this.channels) {
      try {
        await ch.start()
        this.logger.info(`[gateway] ✓ ${name} 已启动`)
      } catch (err) {
        this.logger.error(`[gateway] ✗ ${name} 启动失败: ${errorMessage(err)}`)
      }
    }
  }

  async stopAll(): Promise<void> {
    this.stopped = true
    // 先中断所有仍在跑的通道会话，再关停通道
    for (const session of this.active) session.abort()
    await Promise.all(this.queues.values())

    for (const [, ch] of this.channels) {
      await ch.stop()
    }
  }

  /** 处理一条通道消息；返回的 Promise 在回复发出（或失败）后结束。 */
  handleIncoming(channelName: string, msg: IncomingMessage): Promise<void> {
    const id = channelSessionId(channelName, msg.senderId)
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous
      .then(() => this.process(id, channelName, msg))
      .catch((error) =>
        this.logger.error(`[${channelName}] 处理消息失败: ${errorMessage(error)}`),
      )
    this.queues.set(id, next)
    void next.then(() => {
      if (this.queues.get(id) === next) this.queues.delete(id)
    })
    return next
  }

  private async process(
    id: string,
    channelName: string,
    msg: IncomingMessage,
  ): Promise<void> {
    if (this.stopped) return
    const session = this.options.session(id)
    if (!this.resumed.has(id)) {
      this.resumed.add(id)
      await session.resume()
    }
    session.emit({
      type: 'channel_message',
      channel: channelName,
      senderId: msg.senderId,
      senderName: msg.senderName,
      text: msg.text,
    })

    this.active.add(session)
    try {
      await session.prompt(msg.text)
    } catch (error) {
      session.emit({
        type: 'channel_error',
        channel: channelName,
        senderId: msg.senderId,
        error,
        aborted: this.stopped || isAbort(error),
      })
      return
    } finally {
      this.active.delete(session)
    }

    const replyText = lastAssistantText(session.messages)
    const channel = this.channels.get(channelName)
    if (!replyText || !channel) return
    const reply: OutgoingMessage = {
      channelId: msg.channelId,
      recipientId: msg.senderId,
      text: replyText,
    }
    try {
      await channel.send(reply)
    } catch (error) {
      session.emit({
        type: 'channel_error',
        channel: channelName,
        senderId: msg.senderId,
        error,
        aborted: false,
      })
      return
    }
    session.emit({
      type: 'channel_reply',
      channel: channelName,
      recipientId: msg.senderId,
      text: replyText,
    })
  }

  list(): Array<{ name: string; description: string }> {
    return Array.from(this.channels.values()).map((ch) => ({
      name: ch.name,
      description: ch.description,
    }))
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** 最后一条 assistant 消息的文本（这一轮的回复）。 */
function lastAssistantText(messages: ModelMessage[]): string {
  const last = messages[messages.length - 1]
  if (last?.role !== 'assistant') return ''
  if (typeof last.content === 'string') return last.content
  return last.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
}
