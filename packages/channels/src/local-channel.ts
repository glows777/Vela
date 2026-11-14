import { randomUUID } from 'node:crypto'
import type { VelaLogger } from '@glows777/vela-core/extension-api'
import { z } from 'zod'
import { LocalEvents, localProgress } from './local-events.ts'
import { LocalHttp } from './local-http.ts'
import type {
  LocalHost,
  LocalMessage,
  LocalOptions,
  LocalProject,
  LocalSession,
} from './local-protocol.ts'
import { LocalError } from './local-protocol.ts'
import { LocalStore } from './local-store.ts'
import { errorMessage } from './log.ts'
import { channelSessionId } from './session-id.ts'
import { topicSessionOptions } from './topics.ts'
import type {
  ChannelDefinition,
  ChannelHost,
  ChannelRunFeedback,
  ChannelRuntime,
  IncomingMessage,
  OutgoingMessage,
} from './types.ts'

const projectSchema = z
  .object({
    cwd: z.string().min(1),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
const messageSchema = z
  .object({
    text: z.string().trim().min(1).max(100000),
    clientMessageId: z.string().min(1).max(200).optional(),
  })
  .strict()

export class LocalChannel implements ChannelDefinition {
  readonly name = 'local'
  readonly description =
    'Local project chat with optional authenticated HTTP and SSE'
  readonly store: LocalStore
  readonly events = new LocalEvents()
  private runtime!: ChannelRuntime
  private http?: LocalHttp
  private stopped = false
  private started = false
  private view?: LocalHost
  private unsubscribe?: () => void
  private readonly observed = new WeakSet<object>()
  private unsubscribeSession?: () => void
  private readonly epoch = new Date().toISOString()

  constructor(
    private options: LocalOptions,
    dataDir: string,
    private logger: VelaLogger,
  ) {
    this.store = new LocalStore(dataDir)
  }

  get timezone(): string | undefined {
    return this.options.timezone
  }

  connect(runtime: ChannelRuntime): void {
    this.runtime = runtime
  }

  async start(): Promise<boolean | undefined> {
    await this.store.load()
    if (this.stopped) return false
    this.unsubscribe = this.runtime.onStatus((line) => {
      this.events.publish(
        { type: 'status', data: { text: line.text } },
        {
          projectId: line.chatId,
          sessionId: channelSessionId('local', line.chatId, line.rootId),
        },
      )
    })
    this.unsubscribeSession = this.runtime.onSession(({ session, run }) => {
      const address = {
        projectId: session.chatId,
        sessionId: session.sessionId,
      }
      this.events.publish(
        { type: 'session', data: { ...session, channel: 'local' } },
        { ...address, runId: session.runId },
      )
      if (run?.type === 'started')
        this.events.publish(
          { type: 'run_started', data: {} },
          { ...address, runId: run.runId },
        )
      if (run?.type === 'finished')
        this.events.publish(
          { type: 'run_finished', data: { outcome: run.outcome } },
          { ...address, runId: run.runId },
        )
    })
    if (this.options.token !== undefined) {
      this.http = new LocalHttp(
        { ...this.options, token: this.options.token },
        {
          deploymentId: this.store.deploymentId,
          events: this.events,
          projects: () => this.projects(),
          openProject: (input) => this.openProject(input),
          sessions: (projectId) =>
            this.projectSessions(this.project(projectId)),
          session: (projectId, sessionId) => this.session(projectId, sessionId),
          messages: (input) => this.messages(input),
          submit: (projectId, sessionId, input) =>
            this.submitVisible(projectId, sessionId, input),
          stop: (projectId, sessionId, runId) =>
            this.runtime.stop(
              {
                chatId: projectId,
                rootId: this.session(projectId, sessionId).topic?.rootId,
              },
              runId,
            ),
        },
        this.logger,
      )
      await this.http.start()
    }
    if (this.stopped) return false
    this.started = true
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.started = false
    this.unsubscribe?.()
    this.unsubscribeSession?.()
    try {
      await this.http?.stop()
    } finally {
      this.events.stop()
    }
  }

  host(base: ChannelHost): LocalHost {
    this.view ??= {
      ...base,
      projects: () => this.projects(),
      openProject: (input) => this.openProject(input),
      sessions: (projectId) => {
        this.assertRunning()
        return projectId === undefined
          ? this.store
              .projects()
              .flatMap((project) => this.projectSessions(project))
          : this.projectSessions(this.project(projectId))
      },
      messages: (input) => this.messages(input),
      submit: ((
        input: IncomingMessage | Parameters<LocalHost['submit']>[0],
      ) => {
        if (!('projectId' in input)) return base.submit(input)
        const { projectId, sessionId, ...body } = input
        return this.submitVisible(projectId, sessionId, body)
      }) as LocalHost['submit'],
      onEvent: (listener, options) => {
        if (this.stopped) this.assertRunning()
        return this.events.subscribe(listener, options)
      },
    }
    return this.view
  }

  private assertRunning(): void {
    if (!this.started || this.stopped)
      throw new LocalError('unavailable', 'Local channel is not running')
  }

  private projects(): LocalProject[] {
    this.assertRunning()
    return this.store.projects()
  }

  private project(id: string): LocalProject {
    this.assertRunning()
    const project = this.store.project(id)
    if (!project) throw new LocalError('not_found', 'Project not found')
    return project
  }

  private session(projectId: string, sessionId: string): LocalSession {
    const session = this.projectSessions(this.project(projectId)).find(
      (item) => item.sessionId === sessionId,
    )
    if (!session) throw new LocalError('not_found', 'Session not found')
    return session
  }

  private async openProject(input: unknown): Promise<LocalProject> {
    this.assertRunning()
    const body = projectSchema.safeParse(input)
    if (!body.success)
      throw new LocalError('invalid_request', 'Invalid JSON request body')
    try {
      return await this.store.openProject(body.data.cwd, body.data.name)
    } catch (error) {
      if (
        ['ENOENT', 'ENOTDIR'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        ) ||
        (error instanceof Error && error.message.includes('directory'))
      )
        throw new LocalError(
          'invalid_request',
          'Project must be an existing directory',
        )
      throw error
    }
  }

  private messages(
    input: Parameters<LocalHost['messages']>[0],
  ): ReturnType<LocalHost['messages']> {
    this.session(input.projectId, input.sessionId)
    const limit = input.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new LocalError('invalid_request', 'Limit must be 1 to 100')
    const all = this.store.messages(input.projectId, input.sessionId)
    const index =
      input.after === undefined
        ? -1
        : all.findIndex((message) => message.id === input.after)
    if (input.after !== undefined && index === -1)
      throw new LocalError('invalid_request', 'Unknown history cursor')
    const messages = all.slice(index + 1, index + 1 + limit)
    return {
      messages,
      ...(index + 1 + messages.length < all.length
        ? { nextCursor: messages.at(-1)!.id }
        : {}),
    }
  }

  private async submitVisible(
    projectId: string,
    sessionId: string,
    input: unknown,
  ) {
    const project = this.project(projectId)
    const session = this.session(projectId, sessionId)
    const body = messageSchema.safeParse(input)
    if (!body.success)
      throw new LocalError('invalid_request', 'Invalid JSON request body')
    return this.submit(
      project,
      session,
      body.data.text,
      body.data.clientMessageId,
    )
  }

  canRecover(message: IncomingMessage, kind: 'group' | 'direct'): boolean {
    return kind === 'group' && !!this.store.project(message.channelId)
  }

  sessionOptions(message: IncomingMessage) {
    const project = this.store.project(message.channelId)
    if (!project) throw new Error('Unknown Local project')
    return { ...topicSessionOptions(message), cwd: project.cwd }
  }

  private projectSessions(project: LocalProject): LocalSession[] {
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
    return {
      event: (update) => {
        if (update.type !== 'agent') return // Hub inputs queue; task steering belongs to the gateway.
        // Steering inputs can share an event. Project it once, without tracking run lifetimes here.
        if (this.observed.has(update.event)) return
        this.observed.add(update.event)
        if (
          update.event.type === 'channel_error' &&
          !update.event.aborted &&
          // A failed progress update is not a failed task.
          update.event.source !== 'feedback'
        )
          this.events.publish(
            {
              type: 'error',
              data: {
                code: 'run_failed',
                message: `Task failed: ${errorMessage(update.event.error)}`,
              },
            },
            { projectId, sessionId },
          )
        const data = localProgress(update.event)
        if (data)
          this.events.publish(
            { type: 'progress', data },
            { projectId, sessionId },
          )
      },
      finish: async () => {}, // Gateway onSession owns preparation, execution and queue lifetimes.
    }
  }

  private visible(projectId: string, message: LocalMessage): void {
    this.events.publish(
      { type: 'message', data: message },
      { projectId, sessionId: message.sessionId },
    )
  }
}
