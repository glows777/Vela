import { createHash } from 'node:crypto'
import { errorMessage, silentLogger, type VelaLogger } from '../logger.ts'
import type { ModelMessage } from '../messages.ts'
import type { SessionOptions, VelaSession } from '../vela-session.ts'
import { MessageFeedback } from './feedback.ts'
import type {
  ChannelDefinition,
  ChannelOutcome,
  ChannelRunFeedback,
  ChannelTopic,
  IncomingMessage,
  OutgoingMessage,
} from './types.ts'

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

const PLAIN = /^[A-Za-z0-9_]+$/

interface ChannelRun {
  session: VelaSession
  trigger: IncomingMessage
  lifetime: AbortController
  stopped: boolean
  inputs: MessageFeedback[]
  handedOff?: boolean
  steering?: Promise<void>
}

/**
 * Shared session id for a chat or topic, e.g. `feishu-oc_456`. Non-plain or long ids get a
 * hash suffix so different (channel, conversation, topic root) tuples cannot share history.
 */
export const channelSessionId = (
  channel: string,
  conversationId: string,
  topicRootId?: string,
) => {
  const parts = [channel, conversationId]
  if (topicRootId !== undefined) parts.push(topicRootId)
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
  /** Messages are processed serially per session: the next message in a chat waits for the previous reply */
  private queues = new Map<string, Promise<void>>()
  /** Session objects already resumed from disk; a reopened session is a new object and must be resumed again */
  private resumed = new WeakSet<VelaSession>()
  private subscribed = new WeakSet<VelaSession>()
  private saveFailures = new Map<string, number>()
  private active = new Set<VelaSession>()
  private runs = new Map<string, ChannelRun>()
  /** Idle sessions waiting to be closed, by session id */
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Sessions being closed: a new message for the id waits until the close is done, then reopens it */
  private closing = new Map<string, Promise<void>>()
  private topics = new Map<
    string,
    { channel: string; chatId: string; topic: Omit<ChannelTopic, 'state'> }
  >()
  private acknowledgements = new WeakMap<IncomingMessage, MessageFeedback[]>()
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

    channel.connect?.({
      context: (id) => this.runs.get(id)?.trigger,
      topics: (chatId) =>
        [...this.topics.entries()]
          .filter(
            ([, item]) =>
              item.channel === channel.name && item.chatId === chatId,
          )
          .map(([id, item]) => ({
            ...item.topic,
            state: this.runs.has(id)
              ? 'running'
              : this.queues.has(id)
                ? 'queued'
                : 'idle',
          })),
      dispatch: (id, msg) => {
        const source = this.runs.get(id)
        if (!source || !this.runIsLive(source))
          throw new Error('The source channel run has ended')
        const targetId = channelSessionId(
          channel.name,
          msg.channelId,
          msg.topic?.rootId,
        )
        if (msg.topic && !this.topics.has(targetId))
          this.topics.set(targetId, {
            channel: channel.name,
            chatId: msg.channelId,
            topic: { ...msg.topic, task: msg.text.slice(0, 120) },
          })
        this.acknowledgements.set(msg, source.inputs)
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
    const id = channelSessionId(channelName, msg.channelId, msg.topic?.rootId)
    clearTimeout(this.idleTimers.get(id))
    this.idleTimers.delete(id)
    const previous = this.queues.get(id) ?? Promise.resolve()
    const channel = this.channels.get(channelName)
    const run = this.runs.get(id)
    if (
      channel &&
      (!msg.requireExistingSession || (run && this.runIsLive(run)))
    )
      this.acknowledge(channel, msg)
    let consumed = false
    let chosen = false
    let decision: Promise<void> | undefined
    let card: Promise<void> | undefined
    const apply = (action: 'steer' | 'stop'): Promise<void> => {
      if (!run || !channel) return Promise.resolve()
      return this.applyRunChoice(channel, msg, run, action)
        .then((handled) => {
          consumed = handled
        })
        .catch(async (error) => {
          const aborted = this.stopped || run.stopped || isAbort(error)
          if (!aborted) await this.feedbackError(channelName, msg, error)
          else
            run.session.emit({
              type: 'channel_error',
              channel: channelName,
              senderId: msg.senderId,
              error,
              aborted: true,
            })
          await Promise.all(
            (this.acknowledgements.get(msg) ?? []).map(async (input) => {
              if (!aborted) input.fail()
              if (!run.inputs.includes(input))
                await input.finish(aborted ? 'stopped' : 'failed')
            }),
          )
          consumed = true
        })
        .finally(() => {
          if (run.stopped) consumed = true
        })
    }
    if (run && this.runIsLive(run) && channel) {
      if (msg.topic) {
        decision = (run.steering ?? Promise.resolve()).then(() =>
          apply('steer'),
        )
        run.steering = decision
      } else if (channel.showRunControls) {
        card = channel
          .showRunControls(msg, {
            signal: run.lifetime.signal,
            choose: (action) => {
              if (chosen || !this.runIsLive(run)) return false
              chosen = true
              if (action !== 'queue') decision = apply(action)
              return true
            },
          })
          .catch((error) =>
            this.logger.warn(
              `[${channelName}] Failed to send run controls: ${errorMessage(error)}`,
            ),
          )
      }
    }
    const next = previous
      .then(async () => {
        await card
        await decision
        if (!consumed) await this.process(id, channelName, msg)
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

  private runIsLive(run: ChannelRun): boolean {
    return (
      !this.stopped &&
      !run.stopped &&
      !run.lifetime.signal.aborted &&
      this.runs.get(run.session.id) === run &&
      run.session.isRunning
    )
  }

  /** Apply one reserved card choice; true consumes its gateway input. */
  private async applyRunChoice(
    channel: ChannelDefinition,
    msg: IncomingMessage,
    run: ChannelRun,
    action: 'steer' | 'stop',
  ): Promise<boolean> {
    if (action === 'stop') {
      run.stopped = true
      run.lifetime.abort()
      // These inputs belong to the cancelled run; the gateway's default queue stays intact.
      run.session.clearQueue()
      await run.session.abort()
      if (!msg.topic)
        await this.sendReply(
          run.session,
          channel.name,
          msg,
          'Stopped the current run.',
        )
      await Promise.all(
        (this.acknowledgements.get(msg) ?? [])
          .filter((input) => !run.inputs.includes(input))
          .map((input) => input.finish('stopped')),
      )
      return true
    }
    const inputs = this.acknowledge(channel, msg)
    await Promise.all(inputs.map((input) => input.ready))
    if (msg.topic) msg.isNewTopic = false
    const prepared = channel.prepareMessage
      ? await channel.prepareMessage(msg, run.trigger)
      : msg
    // History/name lookups can outlast the run. Leave the default queue intact.
    if (!prepared) {
      await Promise.all(inputs.map((input) => input.finish('failed')))
      return true
    }
    if (!this.runIsLive(run)) {
      if (!run.stopped) return false
      await Promise.all(inputs.map((input) => input.finish('stopped')))
      return true
    }
    run.inputs.push(...inputs)
    run.session.emit({
      type: 'channel_message',
      channel: channel.name,
      senderId: prepared.senderId,
      senderName: prepared.senderName,
      text: prepared.text,
    })
    await run.session.prompt(prepared.text, {
      source: 'channel',
      streamingBehavior: 'steer',
      images: prepared.images,
      signal: run.lifetime.signal,
    })
    return true
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

  private acknowledge(
    channel: ChannelDefinition,
    msg: IncomingMessage,
  ): MessageFeedback[] {
    let inputs = this.acknowledgements.get(msg)
    if (!inputs) {
      inputs = [
        new MessageFeedback(channel, msg, (error) =>
          this.feedbackError(channel.name, msg, error),
        ),
      ]
      this.acknowledgements.set(msg, inputs)
    }
    return inputs
  }

  private async feedbackError(
    channelName: string,
    msg: IncomingMessage,
    error: unknown,
  ): Promise<void> {
    const session = this.options.find(
      channelSessionId(channelName, msg.channelId, msg.topic?.rootId),
    )
    session?.emit({
      type: 'channel_error',
      channel: channelName,
      senderId: msg.senderId,
      error,
      aborted: false,
    })
    this.logger.error(
      `[${channelName}] Feedback failed: ${errorMessage(error)}`,
    )
    try {
      await this.channels.get(channelName)?.send({
        ...msg,
        recipientId: msg.senderId,
        text: `Couldn't update task feedback: ${errorMessage(error)}. Check the bot's permissions and connection.`,
      })
    } catch (sendError) {
      this.logger.error(
        `[${channelName}] Could not deliver feedback error: ${errorMessage(sendError)}`,
      )
    }
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
      await this.feedbackError(channelName, msg, error)
    } finally {
      if (outcome)
        await Promise.all(
          (this.acknowledgements.get(msg) ?? []).map((input) =>
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
    let topicSession: VelaSession | undefined
    if (msg.topic) {
      topicSession = this.options.session(id, channel?.sessionOptions?.(msg))
      const exists = this.resumed.has(topicSession)
        ? topicSession.getEntries().length > 0
        : await topicSession.resume()
      if (msg.requireExistingSession && !exists) {
        await topicSession.close()
        return 'failed'
      }
      this.resumed.add(topicSession)
      msg.isNewTopic = !exists
    }
    const inputs = channel ? this.acknowledge(channel, msg) : []
    await Promise.all(inputs.map((input) => input.ready))
    const task = msg.text
    const prepared = channel?.prepareMessage
      ? await channel.prepareMessage(msg)
      : msg
    if (!prepared || this.stopped) return 'failed'
    msg = prepared
    const session =
      topicSession ?? this.options.session(id, channel?.sessionOptions?.(msg))
    if (msg.topic && !this.topics.has(id))
      this.topics.set(id, {
        channel: channelName,
        chatId: msg.channelId,
        topic: { ...msg.topic, task: task.slice(0, 120) },
      })
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
      return 'failed'
    }

    this.active.add(session)
    const run: ChannelRun = {
      session,
      trigger: msg,
      lifetime: new AbortController(),
      stopped: false,
      inputs,
    }
    this.runs.set(id, run)
    let feedback: ChannelRunFeedback | undefined
    let feedbackErrorReported = false
    const report = async (error: unknown) => {
      if (feedbackErrorReported) return
      feedbackErrorReported = true
      await this.feedbackError(channelName, msg, error)
    }
    const unsubscribe = session.subscribe((event) => {
      feedback?.event(event)
      if (event.type === 'agent_settled') run.lifetime.abort()
    })
    let outcome: ChannelOutcome = 'done'
    let answer = ''
    let failureReported = false
    // An input handler can handle the message without a run: then there is no new answer to send
    const previous = session.messages.at(-1)
    try {
      if (msg.topic && channel?.showTopicControls) {
        feedback = await channel
          .showTopicControls(msg, {
            signal: run.lifetime.signal,
            error: report,
            stop: () => {
              if (!this.runIsLive(run)) return false
              void this.applyRunChoice(channel, msg, run, 'stop').catch(
                (error) =>
                  session.emit({
                    type: 'channel_error',
                    channel: channelName,
                    senderId: msg.senderId,
                    error,
                    aborted: this.stopped || isAbort(error),
                  }),
              )
              return true
            },
          })
          .catch(async (error) => {
            failureReported = true
            await this.sendReply(
              session,
              channelName,
              msg,
              `Couldn't show the topic Stop control: ${errorMessage(error)}. Check the bot's send permission and retry.`,
            )
            throw error
          })
          .then((value) => value || undefined)
      }
      await session.prompt(msg.text, { source: 'channel', images: msg.images })
      if (session.messages.at(-1) !== previous)
        answer = lastAssistantText(session.messages)
    } catch (error) {
      outcome =
        run.stopped || this.stopped || isAbort(error) ? 'stopped' : 'failed'
      if (outcome === 'failed' && !failureReported)
        answer = `Task failed: ${errorMessage(error)}`
      session.emit({
        type: 'channel_error',
        channel: channelName,
        senderId: msg.senderId,
        error,
        aborted: outcome === 'stopped',
      })
    } finally {
      unsubscribe()
      run.lifetime.abort()
      await run.steering
      try {
        await feedback?.finish(outcome)
      } catch (error) {
        await report(error)
      }
      this.runs.delete(id)
      this.active.delete(session)
    }
    if (run.handedOff) return
    if (outcome === 'stopped')
      answer = msg.topic ? 'Stopped the current run.' : ''
    if (answer && !(await this.sendReply(session, channelName, msg, answer))) {
      outcome = 'failed'
      try {
        await feedback?.finish(outcome)
      } catch (error) {
        await report(error)
      }
    }
    return outcome
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
