import type {
  SessionOptions,
  VelaLogger,
  VelaSession,
} from '@glows777/vela-core/extension-api'
import {
  publishChannelEvent,
  silentLogger,
} from '@glows777/vela-core/extension-api'
import { TopicAdmission } from './admission.ts'
import { TopicCommands } from './commands.ts'
import { ChannelDirectory } from './directory.ts'
import { ChannelEvents } from './events.ts'
import { RunFeedback } from './feedback.ts'
import { ChannelHandoff } from './handoff.ts'
import { errorMessage } from './log.ts'
import { ChannelRecovery, storedMessage } from './recovery.ts'
import { ChannelRoutines } from './routines.ts'
import { resolveChannelScope } from './scope.ts'
import { channelSessionId } from './session-id.ts'
import { ChannelSessions } from './sessions.ts'
import type {
  ChannelDefinition,
  ChannelOutcome,
  IncomingMessage,
  OutgoingMessage,
} from './types.ts'
import { ChannelUsage } from './usage.ts'

interface GatewayOptions {
  dataDir?: string
  /** Opens (or returns) a session by id; one shared session per channel and conversation */
  session: (id: string, options?: SessionOptions) => VelaSession
  /** The open session with this id, without opening one */
  find: (id: string) => VelaSession | undefined
  /** A channel session with no message for this long is closed; the next message resumes it. Default 10 minutes */
  idleMs?: number
  logger?: VelaLogger
  eventDefaultTarget?: { channel: string; chatId: string }
}

const DEFAULT_CHANNEL_IDLE_MS = 10 * 60_000
/** With `idleMs` 0, how often a session that is busy at its deadline is checked again */
const BUSY_RECHECK_MS = 1000
const MAX_SAVE_FAILURES = 3

export class ChannelGateway {
  readonly routines: ChannelRoutines
  readonly events: ChannelEvents
  readonly handoff: ChannelHandoff
  private readonly directory: ChannelDirectory
  private readonly recovery: ChannelRecovery
  private readonly sessions: ChannelSessions
  private admitting = new Map<string, Promise<void>>()
  private readonly commands: TopicCommands
  private readonly usage: ChannelUsage
  private channels = new Map<string, ChannelDefinition>()
  /** Channels whose `start()` reported a connection; `serve` refuses to idle when this is empty */
  private started = new Set<string>()
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
    this.directory = new ChannelDirectory(options.dataDir)
    this.usage = new ChannelUsage(options.dataDir, this.directory)
    this.routines = new ChannelRoutines(
      options.dataDir,
      this.directory,
      (name) => this.channels.get(name),
      (name, msg) => this.handleIncoming(name, msg),
      async (key, name, msg) => {
        await this.queues.get(key)
        if (this.stopped) return
        return this.admission.admit(key, this.channels.get(name), msg)
      },
      this.logger,
    )
    this.recovery = new ChannelRecovery(this.directory, this.logger, (msg) =>
      this.routines.confirmed(msg),
    )
    this.sessions = new ChannelSessions(
      this.directory,
      (name) => this.channels.get(name),
      options.session,
      options.dataDir ?? process.cwd(),
    )
    this.admission = new TopicAdmission(this.directory, (id, name, msg) =>
      this.sessions.open(id, name, msg),
    )
    this.feedback = new RunFeedback({
      directory: this.directory,
      recovery: this.recovery,
      stopped: () => this.stopped,
      channel: (name) => this.channels.get(name),
      find: (id) => this.find(id),
      reply: (session, name, msg, text) =>
        this.sendReply(session, name, msg, text),
      logger: this.logger,
      finished: (key, msg, outcome, answer) =>
        this.handoff.finished(key, msg, outcome, answer),
    })
    this.commands = new TopicCommands({
      directory: this.directory,
      feedback: this.feedback,
      admission: this.admission,
      usage: this.usage,
      stopped: () => this.stopped,
      channel: (name) => this.channels.get(name),
      find: (key) => this.find(key),
      closing: (key) => this.closing.get(key),
      routines: (name, chatId) => this.routines.formatList(name, chatId),
    })
    const liveTrigger = (id: string) => {
      const run = this.feedback.runs.get(this.directory.keyForSession(id))
      return run?.session.id === id && this.feedback.runIsLive(run)
        ? run.trigger
        : undefined
    }
    const enqueue = (name: string, msg: IncomingMessage) => {
      void this.handleIncoming(name, msg)
    }
    this.events = new ChannelEvents(
      options.dataDir,
      this.directory,
      (name) => this.channels.get(name),
      (name) =>
        !this.stopped &&
        (name ? this.started.has(name) : this.started.size > 0),
      liveTrigger,
      enqueue,
      this.logger,
      options.eventDefaultTarget,
    )
    this.handoff = new ChannelHandoff(
      this.directory,
      liveTrigger,
      (name, chatId) => this.topics(name, chatId),
      enqueue,
      this.logger,
    )
  }

  /** Internal storage-success notification, including saves outside a channel prompt. */
  sessionSaved(id: string): void {
    this.saveFailures.delete(this.directory.keyForSession(id))
    this.handoff.saved(id)
  }

  private topics(channel: string, chatId: string) {
    return this.admission.list(channel, chatId, (id) =>
      this.feedback.runs.has(id)
        ? 'running'
        : this.queues.has(id)
          ? 'queued'
          : (this.directory.get(id)?.state ?? 'done'),
    )
  }

  private find(key: string): VelaSession | undefined {
    return this.options.find(this.directory.sessionId(key))
  }

  register(channel: ChannelDefinition): void {
    this.channels.set(channel.name, channel)

    channel.connect?.({
      scope: (id) => {
        const record =
          this.directory.get(this.directory.keyForSession(id)) ??
          this.directory
            .entries(channel.name)
            .find(
              (entry) => channelSessionId(channel.name, entry.chatId) === id,
            )
        return record
          ? resolveChannelScope(
              this.options.dataDir ?? process.cwd(),
              record.channel,
              record.chatId,
              record.chatKind,
              record.storageKey,
            )
          : undefined
      },
      routines: this.routines.scoped(
        channel.name,
        (id) =>
          this.feedback.runs.get(this.directory.keyForSession(id))?.trigger,
      ),
      context: (id) =>
        this.feedback.runs.get(this.directory.keyForSession(id))?.trigger,
      topicCoverage: () => this.directory.coverage,
      skipReply: (id) => {
        const run = this.feedback.runs.get(this.directory.keyForSession(id))
        if (
          !run ||
          run.session.id !== id ||
          !(run.trigger.passive || run.trigger.handoff) ||
          !this.feedback.runIsLive(run)
        )
          throw new Error(
            'Silence requires an active passive or hand-off group run',
          )
        run.skipReply = true
      },
      topics: (chatId) => this.topics(channel.name, chatId),
      waitForInput: (id, reason) => {
        const key = this.directory.keyForSession(id)
        const run = this.feedback.runs.get(key)
        if (!run || run.session.id !== id || !this.feedback.runIsLive(run))
          throw new Error('The topic run has ended')
        return this.directory.waitForInput(key, reason)
      },
      dispatch: (id, msg, label) => {
        const source = this.feedback.runs.get(this.directory.keyForSession(id))
        if (!source || !this.feedback.runIsLive(source))
          throw new Error('The source channel run has ended')
        const targetId = channelSessionId(
          channel.name,
          msg.channelId,
          msg.topic?.rootId,
        )
        this.admission.observe(targetId, channel.name, msg, label)
        this.feedback.acknowledgements.set(msg, source.inputs)
        source.handedOff = true
        void this.handleIncoming(channel.name, msg)
      },
    })
    channel.onMessage?.((msg: IncomingMessage) => {
      return this.handleIncoming(channel.name, msg)
    })
  }

  async startAll(toolNames: readonly string[] = []): Promise<void> {
    for (const channel of this.channels.values())
      channel.validateTools?.(toolNames)
    await this.directory.load()
    await this.events.load()
    await this.routines.load(this.channels.values())
    this.usage.load()
    this.stopped = false
    for (const [name, ch] of this.channels) {
      try {
        // Reserve recovery before transport startup can deliver new events.
        let connected!: (started: boolean) => void
        const ready = new Promise<boolean>((resolve) => {
          connected = resolve
        })
        const records = this.directory
          .entries(name)
          .filter(
            (record) =>
              record.state === 'running' || record.pendingMessageIds.length,
          )
        for (const stored of records) {
          const record = structuredClone(stored)
          const task = ready
            .then(async (started) => {
              if (!started) return
              const msg = storedMessage(record)
              if (
                this.stopped ||
                ch.canRecover?.(msg, record.chatKind) === false
              )
                return
              const session = this.sessions.open(record.activeSessionId)
              await session.resume()
              this.admission.resumed.add(session)
              await this.recovery.recover(record, ch, session, (input) =>
                this.process(record.key, name, input, true),
              )
            })
            .catch((error) =>
              this.feedback.feedbackError(name, storedMessage(record), error),
            )
          this.queues.set(record.key, task)
          this.releaseQueue(record.key, task)
        }
        let started = false
        try {
          started = (await ch.start()) !== false
          connected(started)
        } catch (error) {
          connected(false)
          throw error
        }
        if (started) {
          this.started.add(name)
          this.logger.info(`[gateway] ✓ ${name} started`)
          this.routines.start(name)
        }
      } catch (err) {
        this.logger.error(
          `[gateway] ✗ ${name} failed to start: ${errorMessage(err)}`,
        )
      }
    }
  }

  async stopAll(): Promise<void> {
    this.stopped = true
    this.started.clear()
    this.routines.stop()
    for (const timer of this.idleTimers.values()) clearTimeout(timer)
    this.idleTimers.clear()
    // Drain all active work before stopping its channels, even if an independent close fails.
    const errors: unknown[] = []
    const drained = await Promise.allSettled([
      ...[...this.feedback.active].map((session) => session.abort()),
      ...this.queues.values(),
      ...this.admitting.values(),
      ...this.commands.active,
      ...this.closing.values(),
      ...this.routines.active,
      ...this.events.active,
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
    try {
      if (this.channels.size) await this.directory.flush()
    } catch (error) {
      errors.push(error)
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
    const incoming = this.commands.receive(
      id,
      channelName,
      msg,
      () => this.admit(id, channelName, msg),
      previous,
    )
    if (incoming.command) {
      if (incoming.blocks) {
        this.queues.set(id, incoming.command)
        this.releaseQueue(id, incoming.command)
      } else void incoming.command.then(() => this.closeWhenIdle(id))
      return incoming.command
    }
    const available = incoming.available
    // Keep live controls immediate. Steer waits for its admitted ID before submitting input.
    const ready = available.then(() => {})
    void ready.catch(() => {})
    const receive =
      !incoming.blocked &&
      (!msg.requireExistingSession ||
        this.directory.get(id) ||
        this.feedback.runs.has(id))
        ? this.feedback.receive(id, channelName, msg, ready)
        : undefined
    const consumed = available
      .then((accepted) =>
        accepted
          ? (receive ?? this.feedback.receive(id, channelName, msg))
          : () => Promise.resolve(true),
      )
      .catch(async (error) => {
        await this.feedback.feedbackError(channelName, msg, error)
        return () => Promise.resolve(true)
      })
    const next = previous
      .then(async () => {
        this.logger.debug(
          `[${channelName}] input ${msg.replyToId ?? '-'} dequeued at=${new Date().toISOString()}`,
        )
        if (!(await (await consumed)()))
          await this.process(id, channelName, msg)
      })
      .catch((error) =>
        this.logger.error(
          `[${channelName}] Failed to handle message: ${errorMessage(error)}`,
        ),
      )
    this.queues.set(id, next)
    this.releaseQueue(id, next)
    return next
  }

  private admit(
    id: string,
    channelName: string,
    msg: IncomingMessage,
  ): Promise<boolean> {
    const admitted = (this.admitting.get(id) ?? this.directory.load()).then(
      async () => {
        if (this.stopped) return false
        const channel = this.channels.get(channelName)
        if (msg.requireExistingSession && !this.directory.get(id)) {
          await this.closing.get(id)
          if (!(await this.admission.admit(id, channel, msg))) return false
        }
        await this.directory.admit(id, channelName, msg)
        this.logger.debug(
          `[${channelName}] input ${msg.replyToId ?? '-'} admitted at=${new Date().toISOString()}`,
        )
        return true
      },
    )
    const admission = admitted.then(
      () => {},
      () => {},
    )
    this.admitting.set(id, admission)
    void admission.then(() => {
      if (this.admitting.get(id) === admission) this.admitting.delete(id)
    })
    return admitted
  }

  private releaseQueue(id: string, next: Promise<void>): void {
    void next.then(() => {
      if (this.queues.get(id) !== next) return
      this.queues.delete(id)
      this.closeWhenIdle(id)
    })
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
      const session = this.find(id)
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
      await session.save({ reportFailure: true })
    } catch {
      return
    }
    // New work may have arrived while saving; its queue will rearm idle cleanup.
    if (this.stopped || this.find(id) !== session || this.queues.has(id)) return
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
    recovered = false,
  ): Promise<void> {
    const processing = this.commands.begin(id)
    let outcome: ChannelOutcome | undefined = 'failed'
    try {
      outcome = await this.processRun(
        id,
        channelName,
        msg,
        processing,
        recovered,
      )
    } catch (error) {
      await this.feedback.feedbackError(channelName, msg, error)
    } finally {
      this.commands.end(id, processing)
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
    processing: { stopped: boolean },
    recovered = false,
  ): Promise<ChannelOutcome | undefined> {
    if (this.stopped) return 'stopped'
    this.logger.debug(
      `[${channelName}] input ${msg.replyToId ?? '-'} preparing at=${new Date().toISOString()}`,
    )
    await this.closing.get(id)
    const channel = this.channels.get(channelName)
    if (msg.externalEvent) {
      const record = this.directory.get(id)
      if (!record || channel?.canRecover?.(msg, record.chatKind) === false)
        return 'done'
    }
    const topicSession =
      msg.topic || msg.passive
        ? await this.admission.admit(id, channel, msg)
        : undefined
    if (msg.topic && !topicSession) return 'failed'
    if (
      msg.passive &&
      msg.replyToId &&
      topicSession &&
      this.recovery.hasInput(topicSession, msg.replyToId)
    ) {
      await this.directory.forget(id, [msg.replyToId])
      return 'done'
    }
    const inputs = channel
      ? this.feedback.acknowledge(channel, msg, !recovered)
      : []
    await Promise.all(inputs.map((input) => input.ready))
    this.logger.debug(
      `[${channelName}] input ${msg.replyToId ?? '-'} acknowledged at=${new Date().toISOString()}`,
    )
    const input = msg
    const task = msg.text
    const prepared =
      !processing.stopped && !recovered && channel?.prepareMessage
        ? await channel.prepareMessage(msg)
        : msg
    this.logger.debug(
      `[${channelName}] input ${msg.replyToId ?? '-'} prepared at=${new Date().toISOString()}`,
    )
    if (processing.stopped) {
      await this.directory.forget(id, msg.replyToId ? [msg.replyToId] : [])
      await this.directory.finish(id, 'stopped')
      await this.sendReply(
        topicSession ?? this.sessions.open(id, channelName, msg),
        channelName,
        msg,
        'Stopped the current run.',
      )
      return 'stopped'
    }
    if (!prepared) {
      // Undefined means the adapter handled the input without a model prompt.
      await this.directory.forget(id, msg.replyToId ? [msg.replyToId] : [])
      return 'failed'
    }
    if (this.stopped) return 'failed'
    msg = prepared
    const session = topicSession ?? this.sessions.open(id, channelName, msg)
    this.admission.observe(id, channelName, msg, task)
    this.usage.track(id, msg.channelId, session)
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
    if (
      msg.routine &&
      !recovered &&
      !(await this.routines.shouldRun(msg, session))
    )
      return 'done'
    publishChannelEvent(session, {
      type: 'channel_message',
      channel: channelName,
      senderId: msg.senderId,
      senderName: msg.senderName,
      text: msg.text,
    })

    if ((this.saveFailures.get(id) ?? 0) >= MAX_SAVE_FAILURES) {
      if (msg.passive) {
        this.logger.error(
          `[${channelName}] Passive evaluation paused: session ${session.id} cannot be saved`,
        )
        return 'failed'
      }
      await this.sendReply(
        session,
        channelName,
        msg,
        "This session can't be saved. New prompts are paused after 3 consecutive save failures. Please ask the operator to restore session storage.",
      )
      return 'failed'
    }

    await this.handoff.beforeRun(id, session, msg)
    return this.feedback.prompt(
      id,
      channelName,
      channel,
      msg,
      session,
      inputs,
      input,
    )
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
      routine: msg.routine,
      handoff: msg.handoff,
      topic: msg.topic,
      channelId: msg.channelId,
      recipientId: msg.senderId,
      text: replyText,
      ...(msg.replyToId ? { replyToId: msg.replyToId } : {}),
    }
    try {
      await channel.send(reply)
    } catch (error) {
      publishChannelEvent(session, {
        type: 'channel_error',
        channel: channelName,
        senderId: msg.senderId,
        error,
        aborted: false,
      })
      this.logger.error(`[${channelName}] Reply failed: ${errorMessage(error)}`)
      return false
    }
    publishChannelEvent(session, {
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

  /** Channels whose last `start()` reported a connection (not `false`, and it did not throw) */
  running(): string[] {
    return [...this.started]
  }
}
