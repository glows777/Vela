import type {
  SessionOptions,
  VelaLogger,
  VelaSession,
} from '@glows777/vela-core/extension-api'
import { silentLogger } from '@glows777/vela-core/extension-api'
import { TopicAdmission } from './admission.ts'
import { TopicCommands } from './commands.ts'
import { ChannelDirectory, isGroupInput } from './directory.ts'
import { ChannelEvents } from './events.ts'
import { RunFeedback } from './feedback.ts'
import { GatewayIdle } from './gateway-idle.ts'
import { GatewayInput } from './gateway-input.ts'
import { GatewayRun } from './gateway-run.ts'
import { ChannelHandoff } from './handoff.ts'
import { errorMessage } from './log.ts'
import { ChannelRecovery, storedMessage } from './recovery.ts'
import { ChannelRoutines } from './routines.ts'
import { ScopedChannelRuntime } from './runtime.ts'
import { channelSessionId } from './session-id.ts'
import { ChannelSessions } from './sessions.ts'
import { ChannelTopics } from './topics.ts'
import type {
  ChannelDefinition,
  ChannelSessionUpdate,
  IncomingMessage,
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

export class ChannelGateway {
  readonly routines: ChannelRoutines
  readonly events: ChannelEvents
  readonly handoff: ChannelHandoff
  readonly topicTools: ChannelTopics
  private readonly directory: ChannelDirectory
  private readonly recovery: ChannelRecovery
  private readonly sessions: ChannelSessions
  private readonly commands: TopicCommands
  private readonly usage: ChannelUsage
  private channels = new Map<string, ChannelDefinition>()
  private runtimes = new Map<string, ScopedChannelRuntime>()
  /** Channels whose `start()` reported a connection; `serve` refuses to idle when this is empty */
  private started = new Set<string>()
  private readonly input: GatewayInput
  private readonly run: GatewayRun
  private readonly idle: GatewayIdle
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
    this.idle = new GatewayIdle(
      options.idleMs,
      (id) => this.find(id),
      (id) => this.queues.has(id),
      () => this.stopped,
      this.logger,
    )
    this.feedback = new RunFeedback({
      directory: this.directory,
      recovery: this.recovery,
      changed: (key) => this.sessionChanged(key),
      stopped: () => this.stopped,
      channel: (name) => this.channels.get(name),
      find: (id) => this.find(id),
      reply: (session, name, msg, text) =>
        this.run.sendReply(session, name, msg, text),
      logger: this.logger,
      finished: (key, msg, outcome, answer) =>
        this.handoff.finished(key, msg, outcome, answer),
    })
    this.commands = new TopicCommands({
      directory: this.directory,
      feedback: this.feedback,
      changed: (key) => this.sessionChanged(key),
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
      (record, text) => {
        if (record.rootId)
          this.runtimes
            .get(record.channel)
            ?.status({ chatId: record.chatId, rootId: record.rootId, text })
      },
    )
    this.topicTools = new ChannelTopics((id) => {
      const record = this.directory.get(this.directory.keyForSession(id))
      const runtime = record && this.runtimes.get(record.channel)?.api
      return runtime && record.activeSessionId === id
        ? {
            runtime,
            capabilities: this.channels.get(record.channel)?.topicCapabilities,
          }
        : undefined
    })
    this.run = new GatewayRun(
      this.directory,
      this.admission,
      this.commands,
      this.feedback,
      this.sessions,
      this.usage,
      this.recovery,
      this.routines,
      this.handoff,
      this.idle,
      (name) => this.channels.get(name),
      (key, run) => this.sessionChanged(key, run),
      () => this.stopped,
      this.logger,
    )
    this.input = new GatewayInput(
      this.directory,
      this.admission,
      this.commands,
      this.feedback,
      this.idle,
      (name) => this.channels.get(name),
      (id, name, msg) => this.run.process(id, name, msg),
      (key) => this.sessionChanged(key),
      () => this.stopped,
      this.logger,
    )
  }

  private get queues() {
    return this.input.queues
  }

  private get closing() {
    return this.idle.closing
  }

  /** Internal storage-success notification, including saves outside a channel prompt. */
  sessionSaved(id: string): void {
    this.run.saved(id)
    this.handoff.saved(id)
  }

  private topics(channel: string, chatId: string) {
    return this.admission.list(channel, chatId, (id) => this.state(id))
  }

  private state(id: string) {
    return this.feedback.runs.has(id)
      ? 'running'
      : this.queues.has(id)
        ? 'queued'
        : (this.directory.get(id)?.state ?? 'done')
  }

  private sessionChanged(key: string, run?: ChannelSessionUpdate['run']): void {
    const record = this.directory.get(key)
    if (!record) return
    this.runtimes.get(record.channel)?.session(key, record.chatId, run)
  }

  private find(key: string): VelaSession | undefined {
    return this.options.find(this.directory.sessionId(key))
  }

  register(channel: ChannelDefinition): void {
    this.channels.set(channel.name, channel)

    const runtime = new ScopedChannelRuntime({
      logger: this.logger,
      channel,
      directory: this.directory,
      dataDir: this.options.dataDir ?? process.cwd(),
      find: (id) => this.find(id),
      state: (id) => this.state(id),
      run: (id) => this.commands.controllable(id),
      submit: async (msg) => {
        if (this.stopped || !this.started.has(channel.name))
          throw new Error('Channel is not running')
        if (
          channel.canRecover?.(msg, isGroupInput(msg) ? 'group' : 'direct') ===
          false
        )
          throw new Error('Channel scope is not enabled')
        const submission = this.input.enqueue(channel.name, msg)
        if (!(await submission.admitted))
          throw new Error('Message was not admitted')
        return {
          sessionId: channelSessionId(
            channel.name,
            msg.channelId,
            msg.topic?.rootId,
          ),
        }
      },
      stop: async (target, runId) => {
        if (this.stopped || !this.started.has(channel.name)) return false
        const key = channelSessionId(channel.name, target.chatId, target.rootId)
        const record = this.directory.get(key)
        if (
          !record ||
          channel.canRecover?.(storedMessage(record), record.chatKind) === false
        )
          return false
        return this.commands.stop(key, runId)
      },
      operations: {
        routines: this.routines.scoped(
          channel.name,
          (id) =>
            this.feedback.runs.get(this.directory.keyForSession(id))?.trigger,
        ),
        context: (id) =>
          this.feedback.runs.get(this.directory.keyForSession(id))?.trigger,
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
        waitForInput: async (id, reason) => {
          const key = this.directory.keyForSession(id)
          const run = this.feedback.runs.get(key)
          if (!run || run.session.id !== id || !this.feedback.runIsLive(run))
            throw new Error('The topic run has ended')
          await this.directory.waitForInput(key, reason)
          this.sessionChanged(key)
        },
        dispatch: (id, msg, label) => {
          const source = this.feedback.runs.get(
            this.directory.keyForSession(id),
          )
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
      },
    })
    this.runtimes.set(channel.name, runtime)
    channel.connect?.(runtime.api)
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
                this.run.process(record.key, name, input, true),
              )
            })
            .catch((error) =>
              this.feedback.feedbackError(name, storedMessage(record), error),
            )
          this.queues.set(record.key, task)
          this.input.release(record.key, task)
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
    this.idle.stop()
    // Drain all active work before stopping its channels, even if an independent close fails.
    const errors: unknown[] = []
    const drained = await Promise.allSettled([
      ...[...this.feedback.active].map((session) => session.abort()),
      ...this.queues.values(),
      ...this.input.admitting.values(),
      ...this.commands.active,
      ...this.closing.values(),
      ...this.routines.active,
      ...this.events.active,
    ])
    this.run.clearSaveFailures()
    for (const result of drained)
      if (result.status === 'rejected') errors.push(result.reason)

    for (const [, ch] of this.channels) {
      try {
        await ch.stop()
      } catch (error) {
        errors.push(error)
      }
    }
    for (const runtime of this.runtimes.values()) runtime.clear()
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
    return this.input.enqueue(channelName, msg).completed
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
