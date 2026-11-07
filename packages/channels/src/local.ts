import { randomUUID } from 'node:crypto'
import type { VelaLogger } from '@glows777/vela-core/extension-api'
import { z } from 'zod'
import { LocalEvents, localProgress } from './local-events.ts'
import { LocalHttp } from './local-http.ts'
import type {
  LocalMessage,
  LocalOptions,
  LocalProject,
  LocalSession,
} from './local-protocol.ts'
import { LocalStore } from './local-store.ts'
import { channelSessionId } from './session-id.ts'
import { topicSessionOptions } from './topics.ts'
import type {
  ChannelDefinition,
  ChannelRunFeedback,
  ChannelRuntime,
  IncomingMessage,
  OutgoingMessage,
} from './types.ts'
import type { ChannelExtension } from './vela.ts'

const optionsSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0 && !/[\r\n]/.test(value)),
    port: z.number().int().min(0).max(65535).optional(),
    timezone: z.string().optional(),
  })
  .strict()

/** Explicit SDK configuration only. The CLI resolves its user-level settings before calling this. */
export function local(options: LocalOptions): ChannelExtension {
  const parsed = optionsSchema.safeParse(options)
  if (!parsed.success)
    throw new Error(
      'Local requires a nonempty token, a valid port and an optional timezone',
    )
  return function local(vela) {
    vela.registerChannel(
      new LocalChannel(parsed.data, vela.dataDir, vela.logger),
    )
  }
}

class LocalChannel implements ChannelDefinition {
  readonly name = 'local'
  readonly description =
    'Local project chat over authenticated loopback HTTP and SSE'
  readonly store: LocalStore
  readonly events = new LocalEvents()
  private runtime!: ChannelRuntime
  private http?: LocalHttp
  private unsubscribe?: () => void
  private readonly runs = new Map<string, string>()
  private readonly observed = new WeakSet<object>()
  private readonly deferred = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly epoch = new Date().toISOString()

  constructor(
    private options: LocalOptions,
    dataDir: string,
    private logger: VelaLogger,
  ) {
    this.store = new LocalStore(dataDir)
  }
  formatError(): string {
    return 'See daemon diagnostics for details'
  }

  get timezone(): string | undefined {
    return this.options.timezone
  }

  connect(runtime: ChannelRuntime): void {
    this.runtime = runtime
  }

  async start(): Promise<void> {
    await this.store.load()
    this.unsubscribe = this.runtime.onStatus((line) => {
      this.events.publish(
        { type: 'status', data: { text: line.text } },
        {
          projectId: line.chatId,
          sessionId: channelSessionId('local', line.chatId, line.rootId),
        },
      )
    })
    this.http = new LocalHttp(
      this.options,
      {
        store: this.store,
        events: this.events,
        runtime: this.runtime,
        sessions: (project) => this.sessions(project),
        submit: (project, session, text, clientMessageId) =>
          this.submit(project, session, text, clientMessageId),
      },
      this.logger,
    )
    await this.http.start()
  }

  async stop(): Promise<void> {
    this.unsubscribe?.()
    for (const timer of this.deferred.values()) clearTimeout(timer)
    this.deferred.clear()
    await this.http?.stop()
  }

  canRecover(message: IncomingMessage, kind: 'group' | 'direct'): boolean {
    return kind === 'group' && !!this.store.project(message.channelId)
  }

  sessionOptions(message: IncomingMessage) {
    const project = this.store.project(message.channelId)
    if (!project) throw new Error('Unknown Local project')
    return { ...topicSessionOptions(message), cwd: project.cwd }
  }

  sessions(project: LocalProject): LocalSession[] {
    const sessions = this.runtime
      .sessions(project.id)
      .map((session) => ({ ...session, channel: 'local' as const }))
    if (!sessions.some((session) => session.sessionId === project.sessionId))
      sessions.unshift({
        channel: 'local',
        sessionId: project.sessionId,
        chatId: project.id,
        chatKind: 'group',
        task: project.name,
        state: 'done',
        requester: { id: 'local-user', name: 'You' },
        updatedAt: this.epoch,
      })
    return sessions
  }

  private async submit(
    project: LocalProject,
    session: LocalSession,
    text: string,
    clientMessageId?: string,
  ) {
    // Persist visible input before admission can start a model. Failed admission removes that input.
    const message = await this.store.append(project.id, {
      sessionId: session.sessionId,
      role: 'user',
      text,
      ...(clientMessageId ? { clientMessageId } : {}),
    })
    try {
      const receipt = await this.runtime.submit({
        channelId: project.id,
        chatKind: 'group',
        senderId: 'local-user',
        senderName: 'You',
        text,
        replyToId: message.id,
        topic: session.topic,
        requireExistingSession: !!session.topic,
      })
      this.visible(project.id, message)
      this.publishSession(project.id, session.sessionId)
      return { ...receipt, messageId: message.id }
    } catch (error) {
      await this.store.remove(project.id, message.id)
      throw error
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    const sessionId = channelSessionId(
      'local',
      message.channelId,
      message.topic?.rootId,
    )
    const visible = await this.store.append(message.channelId, {
      sessionId,
      role: 'assistant',
      text: message.text,
    })
    this.visible(message.channelId, visible)
  }

  readonly topicCapabilities = {
    startTopic: async (message: IncomingMessage, title: string) => {
      const rootId = randomUUID()
      const sessionId = channelSessionId('local', message.channelId, rootId)
      const visible = await this.store.append(message.channelId, {
        sessionId,
        role: 'system',
        text: title,
      })
      this.visible(message.channelId, visible)
      return { messageId: visible.id, rootId, threadId: rootId }
    },
    forwardToTopic: async (
      message: IncomingMessage,
      target: { rootId: string; threadId: string },
    ) => {
      const sessionId = channelSessionId(
        'local',
        message.channelId,
        target.rootId,
      )
      const visible = await this.store.append(message.channelId, {
        sessionId,
        role: 'user',
        text: message.text,
      })
      this.visible(message.channelId, visible)
      return { ...message, replyToId: visible.id, topic: target }
    },
    readTopic: async (projectId: string, threadId: string) =>
      this.store
        .messages(projectId, channelSessionId('local', projectId, threadId))
        .map((message) => `${message.role}: ${message.text}`)
        .join('\n'),
  }

  async prepareRoutine(
    message: IncomingMessage,
    _kind: 'group' | 'direct',
    reminder: { message: string; lateByMs: number },
  ): Promise<IncomingMessage> {
    const sessionId = channelSessionId(
      'local',
      message.channelId,
      message.topic?.rootId,
    )
    const visible = await this.store.append(message.channelId, {
      sessionId,
      role: 'system',
      text: `Reminder: ${reminder.message}`,
    })
    this.visible(message.channelId, visible)
    return { ...message, replyToId: visible.id }
  }

  async startRun(message: IncomingMessage): Promise<ChannelRunFeedback> {
    const sessionId = channelSessionId(
      'local',
      message.channelId,
      message.topic?.rootId,
    )
    const projectId = message.channelId
    let runId: string | undefined
    return {
      event: (update) => {
        if (update.type !== 'agent') return // Hub inputs queue; task steering belongs to the gateway.
        const snapshot = this.runtime
          .sessions(projectId)
          .find((session) => session.sessionId === sessionId)
        runId ??= snapshot?.runId
        if (runId && this.runs.get(sessionId) !== runId) {
          this.runs.set(sessionId, runId)
          this.events.publish(
            { type: 'run_started', data: {} },
            { projectId, sessionId, runId },
          )
          this.publishSession(projectId, sessionId)
        }
        if (this.observed.has(update.event)) return
        this.observed.add(update.event)
        const data = localProgress(update.event)
        if (data)
          this.events.publish(
            { type: 'progress', data },
            { projectId, sessionId, runId },
          )
      },
      finish: async (outcome) => {
        if (runId && this.runs.get(sessionId) === runId) {
          this.runs.delete(sessionId)
          this.events.publish(
            { type: 'run_finished', data: { outcome } },
            { projectId, sessionId, runId },
          )
        }
        if (outcome === 'failed')
          this.events.publish(
            {
              type: 'error',
              data: {
                code: 'run_failed',
                message:
                  'Run failed. Reload visible history and inspect daemon diagnostics.',
              },
            },
            { projectId, sessionId, runId },
          )
        this.observeSettled(projectId, sessionId)
      },
    }
  }

  private observeSettled(projectId: string, sessionId: string): void {
    clearTimeout(this.deferred.get(sessionId))
    // Feedback finishes before the gateway commits status and releases its queue. Observe,
    // never drive, that boundary; a later run's start also ends this observer.
    const timer = setTimeout(() => {
      this.deferred.delete(sessionId)
      const snapshot = this.runtime
        .sessions(projectId)
        .find((item) => item.sessionId === sessionId)
      if (snapshot?.state === 'queued' && !snapshot.runId)
        this.observeSettled(projectId, sessionId)
      else this.publishSession(projectId, sessionId)
    }, 10)
    timer.unref?.()
    this.deferred.set(sessionId, timer)
  }

  private visible(projectId: string, message: LocalMessage): void {
    this.events.publish(
      { type: 'message', data: message },
      { projectId, sessionId: message.sessionId },
    )
  }

  private publishSession(projectId: string, sessionId: string): void {
    const session = this.runtime
      .sessions(projectId)
      .find((item) => item.sessionId === sessionId)
    if (session)
      this.events.publish(
        { type: 'session', data: { ...session, channel: 'local' } },
        { projectId, sessionId, runId: session.runId },
      )
  }
}
