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
  /** Opens (or returns) a session by id; one session per channel, conversation and sender */
  session: (id: string) => VelaSession
  /** The open session with this id, without opening one */
  find: (id: string) => VelaSession | undefined
  /** A channel session with no message for this long is closed; the next message resumes it. Default 10 minutes */
  idleMs?: number
  logger?: VelaLogger
}

export const DEFAULT_CHANNEL_IDLE_MS = 10 * 60_000
/** With `idleMs` 0, how often a session that is busy at its deadline is checked again */
const BUSY_RECHECK_MS = 1000
const MAX_SAVE_FAILURES = 3

const PLAIN = /^[A-Za-z0-9_]+$/

/**
 * Session id for a sender in one conversation, e.g. `feishu-oc_456-ou_123`: the channel name,
 * the conversation (`channelId`: a group chat or a direct chat) and the sender id. One person
 * gets separate sessions in different chats, and each member of a group chat has their own.
 * Different (channel, conversation, sender) triples must map to different sessions (or they
 * would see each other's history). If all three contain only letters, digits and `_`, they are
 * joined with `-`; otherwise they are sanitized and suffixed with `.` plus a hash of the
 * originals. Directly joined ids never contain `.`, so the two forms never collide.
 */
export const channelSessionId = (
  channel: string,
  conversationId: string,
  senderId: string,
) => {
  const parts = [channel, conversationId, senderId]
  const plain = parts.join('-')
  if (parts.every((part) => PLAIN.test(part)) && plain.length <= 128)
    return plain
  const hash = createHash('sha256')
    .update(parts.join('\0'))
    .digest('hex')
    .slice(0, 16)
  const safe = plain.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128 - 17)
  return `${safe}.${hash}`
}

export class ChannelGateway {
  private channels = new Map<string, ChannelDefinition>()
  /** Messages are processed serially per session: a sender's second message in a conversation waits for the first */
  private queues = new Map<string, Promise<void>>()
  /** Session objects already resumed from disk; a reopened session is a new object and must be resumed again */
  private resumed = new WeakSet<VelaSession>()
  private subscribed = new WeakSet<VelaSession>()
  private saveFailures = new Map<string, number>()
  private active = new Set<VelaSession>()
  /** Idle sessions waiting to be closed, by session id */
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Sessions being closed: a new message for the id waits until the close is done, then reopens it */
  private closing = new Map<string, Promise<void>>()
  private stopped = false
  private readonly logger: VelaLogger

  constructor(private options: GatewayOptions) {
    this.logger = options.logger ?? silentLogger
  }

  /** Internal storage-success notification, including saves outside a channel prompt. */
  sessionSaved(id: string): void {
    this.saveFailures.delete(id)
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
        this.logger.error(
          `[gateway] ✗ ${name} failed to start: ${errorMessage(err)}`,
        )
      }
    }
  }

  async stopAll(): Promise<void> {
    this.stopped = true
    for (const timer of this.idleTimers.values()) clearTimeout(timer)
    this.idleTimers.clear()
    // Drain all active work before stopping its channels, even if an independent close fails.
    const errors: unknown[] = []
    const drained = await Promise.allSettled([
      ...[...this.active].map((session) => session.abort()),
      ...this.queues.values(),
      ...this.closing.values(),
    ])
    this.saveFailures.clear()
    for (const result of drained)
      if (result.status === 'rejected') errors.push(result.reason)

    for (const [, ch] of this.channels) {
      try {
        await ch.stop()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'Channel shutdown failed')
  }

  /** Handles one channel message; the returned Promise settles once the reply is sent (or fails). */
  handleIncoming(channelName: string, msg: IncomingMessage): Promise<void> {
    const id = channelSessionId(channelName, msg.channelId, msg.senderId)
    clearTimeout(this.idleTimers.get(id))
    this.idleTimers.delete(id)
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
      if (this.queues.get(id) !== next) return
      this.queues.delete(id)
      this.closeWhenIdle(id)
    })
    return next
  }

  /**
   * Channel sessions would otherwise stay open (and in memory) for as long as the process runs, one per
   * conversation and sender. Once a sender's queue is empty, the session is closed after `idleMs`; its history
   * is saved, and the next message reopens and resumes it.
   */
  private closeWhenIdle(id: string, delay?: number): void {
    if (this.stopped) return
    const idleMs = this.options.idleMs ?? DEFAULT_CHANNEL_IDLE_MS
    const timer = setTimeout(() => {
      this.idleTimers.delete(id)
      const session = this.options.find(id)
      // A queued message rearms the timer once its reply is sent
      if (!session || this.queues.has(id)) return
      // Running (an extension or SDK caller is using it), or opened with a UI (the terminal resumed it): check
      // again later, so it is still closed once that use ends without another channel message
      if (session.isRunning || session.hasUI) {
        this.closeWhenIdle(id, idleMs || BUSY_RECHECK_MS)
        return
      }
      const closed = this.closeIdleSession(id, session, idleMs)
        .catch((error) =>
          this.logger.error(
            `[gateway] Failed to close idle session ${id}: ${errorMessage(error)}`,
          ),
        )
        .finally(() => {
          if (this.closing.get(id) === closed) this.closing.delete(id)
        })
      this.closing.set(id, closed)
    }, delay ?? idleMs)
    // An idle timer alone doesn't keep the process alive
    timer.unref?.()
    this.idleTimers.set(id, timer)
  }

  private async closeIdleSession(
    id: string,
    session: VelaSession,
    idleMs: number,
  ): Promise<void> {
    try {
      // A failed close discards pending history. Keep the live session until a real save succeeds.
      await session.save()
    } catch (error) {
      session.emit({ type: 'session_save_failed', error })
      return
    }
    // New work may have arrived while saving; its queue will rearm idle cleanup.
    if (
      this.stopped ||
      this.options.find(id) !== session ||
      this.queues.has(id)
    )
      return
    if (session.isRunning || session.hasUI) {
      this.closeWhenIdle(id, idleMs || BUSY_RECHECK_MS)
      return
    }
    await session.close()
  }

  private async process(
    id: string,
    channelName: string,
    msg: IncomingMessage,
  ): Promise<void> {
    if (this.stopped) return
    await this.closing.get(id)
    const session = this.options.session(id)
    session.channel = channelName
    // Re-evaluate the role on every message (the allowlist may change); defaults to guest
    session.role = this.channels.get(channelName)?.roleFor?.(msg) ?? 'guest'
    if (!this.subscribed.has(session)) {
      this.subscribed.add(session)
      session.subscribe((event) => {
        if (event.type !== 'session_save_failed') return
        if (!this.stopped)
          this.saveFailures.set(id, (this.saveFailures.get(id) ?? 0) + 1)
        this.logger.error(
          `[gateway] Could not save session ${id}: ${errorMessage(event.error)}`,
        )
      })
    }
    if ((this.saveFailures.get(id) ?? 0) >= MAX_SAVE_FAILURES) {
      try {
        // Retry the retained live session, without appending the new input or calling the model.
        await session.save()
      } catch {
        // The refusal below reports the continuing outage; only a real write clears the count.
      }
    }
    // A blocked session must reply even when the storage outage also prevents reads.
    if (
      (this.saveFailures.get(id) ?? 0) < MAX_SAVE_FAILURES &&
      !this.resumed.has(session)
    ) {
      await session.resume()
      this.resumed.add(session)
    }
    session.emit({
      type: 'channel_message',
      channel: channelName,
      senderId: msg.senderId,
      senderName: msg.senderName,
      text: msg.text,
    })

    if ((this.saveFailures.get(id) ?? 0) >= MAX_SAVE_FAILURES) {
      await this.sendReply(
        session,
        channelName,
        msg,
        "This session can't be saved. New prompts are paused after 3 consecutive save failures. Please ask the operator to restore session storage.",
      )
      return
    }

    this.active.add(session)
    // An input handler can handle the message without a run: then there is no new answer to send
    const previous = session.messages.at(-1)
    try {
      await session.prompt(msg.text, { source: 'channel' })
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

    if (session.messages.at(-1) === previous) return
    await this.sendReply(
      session,
      channelName,
      msg,
      lastAssistantText(session.messages),
    )
  }

  private async sendReply(
    session: VelaSession,
    channelName: string,
    msg: IncomingMessage,
    replyText: string,
  ): Promise<void> {
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
