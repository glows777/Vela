import { errorMessage, silentLogger, type VelaLogger } from '../logger.ts'
import type { SessionOptions, VelaSession } from '../vela-session.ts'
import { TopicAdmission } from './admission.ts'
import { RunFeedback } from './feedback.ts'
import { channelSessionId } from './session-id.ts'

import type {
  ChannelDefinition,
  ChannelOutcome,
  IncomingMessage,
  OutgoingMessage,
} from './types.ts'

export { channelSessionId } from './session-id.ts'

interface GatewayOptions {
  /** Opens (or returns) a session by id; one shared session per channel and conversation */
  session: (id: string, options?: SessionOptions) => VelaSession
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

export class ChannelGateway {
  private channels = new Map<string, ChannelDefinition>()
  /** Messages are processed serially per session: the next message in a chat waits for the previous reply */
  private queues = new Map<string, Promise<void>>()
  private subscribed = new WeakSet<VelaSession>()
  private saveFailures = new Map<string, number>()
  /** Idle sessions waiting to be closed, by session id */
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Sessions being closed: a new message for the id waits until the close is done, then reopens it */
  private closing = new Map<string, Promise<void>>()
  private readonly admission: TopicAdmission
  private readonly feedback: RunFeedback
  private stopped = false
  private readonly logger: VelaLogger

  constructor(private options: GatewayOptions) {
    this.logger = options.logger ?? silentLogger
    this.admission = new TopicAdmission((id, opts) => options.session(id, opts))
    this.feedback = new RunFeedback({
      stopped: () => this.stopped,
      channel: (name) => this.channels.get(name),
      find: (id) => options.find(id),
      reply: (session, name, msg, text) =>
        this.sendReply(session, name, msg, text),
      logger: this.logger,
    })
  }

  /** Internal storage-success notification, including saves outside a channel prompt. */
  sessionSaved(id: string): void {
    this.saveFailures.delete(id)
  }

  register(channel: ChannelDefinition): void {
    this.channels.set(channel.name, channel)

    channel.connect?.({
      context: (id) => this.feedback.runs.get(id)?.trigger,
      topics: (chatId) =>
        this.admission.list(channel.name, chatId, (id) =>
          this.feedback.runs.has(id)
            ? 'running'
            : this.queues.has(id)
              ? 'queued'
              : 'idle',
        ),
      dispatch: (id, msg) => {
        const source = this.feedback.runs.get(id)
        if (!source || !this.feedback.runIsLive(source))
          throw new Error('The source channel run has ended')
        const targetId = channelSessionId(
          channel.name,
          msg.channelId,
          msg.topic?.rootId,
        )
        this.admission.observe(targetId, channel.name, msg)
        this.feedback.acknowledgements.set(msg, source.inputs)
        source.handedOff = true
        void this.handleIncoming(channel.name, msg)
      },
    })
    channel.onMessage?.((msg: IncomingMessage) => {
      return this.handleIncoming(channel.name, msg)
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
      ...[...this.feedback.active].map((session) => session.abort()),
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
    const id = channelSessionId(channelName, msg.channelId, msg.topic?.rootId)
    clearTimeout(this.idleTimers.get(id))
    this.idleTimers.delete(id)
    const previous = this.queues.get(id) ?? Promise.resolve()
    const consumed = this.feedback.receive(id, channelName, msg)
    const next = previous
      .then(async () => {
        if (!(await consumed())) await this.process(id, channelName, msg)
      })
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
   * conversation. Once a chat's queue is empty, the session is closed after `idleMs`; its history
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
    let outcome: ChannelOutcome | undefined = 'failed'
    try {
      outcome = await this.processRun(id, channelName, msg)
    } catch (error) {
      await this.feedback.feedbackError(channelName, msg, error)
    } finally {
      if (outcome)
        await Promise.all(
          (this.feedback.acknowledgements.get(msg) ?? []).map((input) =>
            input.finish(outcome!),
          ),
        )
    }
  }

  private async processRun(
    id: string,
    channelName: string,
    msg: IncomingMessage,
  ): Promise<ChannelOutcome | undefined> {
    if (this.stopped) return 'stopped'
    await this.closing.get(id)
    const channel = this.channels.get(channelName)
    const topicSession = msg.topic
      ? await this.admission.admit(id, channel, msg)
      : undefined
    if (msg.topic && !topicSession) return 'failed'
    const inputs = channel ? this.feedback.acknowledge(channel, msg) : []
    await Promise.all(inputs.map((input) => input.ready))
    const task = msg.text
    const prepared = channel?.prepareMessage
      ? await channel.prepareMessage(msg)
      : msg
    if (!prepared || this.stopped) return 'failed'
    msg = prepared
    const session =
      topicSession ?? this.options.session(id, channel?.sessionOptions?.(msg))
    this.admission.observe(id, channelName, msg, task)
    session.channel = channelName
    // Channels admit only trusted chats; custom channels can still choose an SDK role.
    session.role = this.channels.get(channelName)?.roleFor?.(msg) ?? 'owner'
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
      !this.admission.resumed.has(session)
    ) {
      await session.resume()
      this.admission.resumed.add(session)
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
      return 'failed'
    }

    return this.feedback.prompt(id, channelName, channel, msg, session, inputs)
  }

  private async sendReply(
    session: VelaSession,
    channelName: string,
    msg: IncomingMessage,
    replyText: string,
  ): Promise<boolean> {
    const channel = this.channels.get(channelName)
    if (!replyText || !channel) return false
    const reply: OutgoingMessage = {
      topic: msg.topic,
      channelId: msg.channelId,
      recipientId: msg.senderId,
      text: replyText,
      ...(msg.replyToId ? { replyToId: msg.replyToId } : {}),
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
      this.logger.error(`[${channelName}] Reply failed: ${errorMessage(error)}`)
      return false
    }
    session.emit({
      type: 'channel_reply',
      channel: channelName,
      recipientId: msg.senderId,
      text: replyText,
    })
    return true
  }

  list(): Array<{ name: string; description: string }> {
    return Array.from(this.channels.values()).map((ch) => ({
      name: ch.name,
      description: ch.description,
    }))
  }
}
