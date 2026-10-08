import { createHash } from 'node:crypto'
import type { ModelMessage } from 'ai'
import { errorMessage, silentLogger, type VelaLogger } from '../logger.ts'
import type { VelaSession } from '../vela-session.ts'
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from './types.ts'

interface GatewayOptions {
  /** Opens (or returns) a session by id; one session per channel sender */
  session: (id: string) => VelaSession
  logger?: VelaLogger
}

const PLAIN = /^[A-Za-z0-9_]+$/

/**
 * Session id for a channel sender, e.g. `feishu-ou_123`.
 * Different senders must map to different sessions (or they would see each other's history).
 * If the channel name and sender id contain only letters, digits and `_`, they are joined directly;
 * otherwise they are sanitized and suffixed with `.` plus a hash of the original. Directly joined
 * ids never contain `.`, so the two forms never collide.
 */
export const channelSessionId = (channel: string, senderId: string) => {
  const plain = `${channel}-${senderId}`
  if (PLAIN.test(channel) && PLAIN.test(senderId) && plain.length <= 128)
    return plain
  const hash = createHash('sha256')
    .update(`${channel}\0${senderId}`)
    .digest('hex')
    .slice(0, 16)
  const safe = plain.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128 - 17)
  return `${safe}.${hash}`
}

export class ChannelGateway {
  private channels = new Map<string, ChannelDefinition>()
  /** Messages are processed serially per session: a sender's second message waits for the first */
  private queues = new Map<string, Promise<void>>()
  /** Session objects already resumed from disk; a reopened session is a new object and must be resumed again */
  private resumed = new WeakSet<VelaSession>()
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
        this.logger.info(`[gateway] ✓ ${name} started`)
      } catch (err) {
        this.logger.error(`[gateway] ✗ ${name} failed to start: ${errorMessage(err)}`)
      }
    }
  }

  async stopAll(): Promise<void> {
    this.stopped = true
    // Abort channel sessions that are still running before stopping the channels
    for (const session of this.active) session.abort()
    await Promise.all(this.queues.values())

    for (const [, ch] of this.channels) {
      await ch.stop()
    }
  }

  /** Handles one channel message; the returned Promise settles once the reply is sent (or fails). */
  handleIncoming(channelName: string, msg: IncomingMessage): Promise<void> {
    const id = channelSessionId(channelName, msg.senderId)
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous
      .then(() => this.process(id, channelName, msg))
      .catch((error) =>
        this.logger.error(
          `[${channelName}] Failed to handle message: ${errorMessage(error)}`,
        ),
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
    // Re-evaluate the role on every message (the allowlist may change); defaults to guest
    session.role = this.channels.get(channelName)?.roleFor?.(msg) ?? 'guest'
    if (!this.resumed.has(session)) {
      this.resumed.add(session)
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

/** Text of the last assistant message (this turn's reply). */
function lastAssistantText(messages: ModelMessage[]): string {
  const last = messages[messages.length - 1]
  if (last?.role !== 'assistant') return ''
  if (typeof last.content === 'string') return last.content
  return last.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
}
