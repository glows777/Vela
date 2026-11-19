import { setDefaultToolModifiers } from '@glows777/vela-core'
import type {
  SessionOptions,
  VelaSession,
} from '@glows777/vela-core/extension-api'
import { LarkDeliveryRefusedError } from './delivery.ts'
import {
  type ChannelDirectory,
  type ChannelRecord,
  isGroupInput,
} from './directory.ts'
import { storedMessage } from './recovery.ts'
import { resolveChannelScope } from './scope.ts'
import { topicSessionOptions } from './topics.ts'
import type { ChannelDefinition, IncomingMessage } from './types.ts'

/** Every opening path resolves current options from the logical chat, before resume or hooks. */
export class ChannelSessions {
  /** Sessions this class has already given the chat's tool split (once per object, like resume). */
  private readonly toolSplitApplied = new WeakSet<VelaSession>()

  private readonly targets = new WeakMap<
    VelaSession,
    NonNullable<SessionOptions['location']>
  >()

  matchesLocation(session: VelaSession) {
    const target = this.targets.get(session)
    return (
      !target ||
      (session.location.environment === target.environment &&
        // A local group binding preserves the cwd of a topic already opened by its host.
        (target.environment === 'local' || session.cwd === target.cwd))
    )
  }

  async reconcile(
    key: string,
    session: VelaSession,
    msg: IncomingMessage,
    send: (
      msg: IncomingMessage,
      text: string,
      identity: string,
    ) => Promise<boolean>,
    recovering = false,
  ) {
    const target = this.targets.get(session)
    if (!target) return
    let notice = this.directory.get(key)?.locationNotice
    if (
      notice &&
      (target.environment !== notice.environment || target.cwd !== notice.cwd)
    ) {
      await this.directory.setLocationNotice(key, session.id, undefined)
      notice = undefined
    }
    if (!this.matchesLocation(session)) {
      // Startup can finish delivery of a committed move. Only normal admission can initiate one.
      if (recovering) return
      if (!notice) {
        notice = {
          ...target,
          token: crypto.randomUUID(),
          senderId: msg.senderId,
          replyToId: msg.replyToId,
        }
        await this.directory.setLocationNotice(key, session.id, notice)
      }
      await this.whenIdle(session, () => session.setLocation(target))
    }
    if (!notice) return
    if (!notice.text) {
      let text = `Moved this session to the ${target.environment} workspace.`
      if (target.environment !== 'local') {
        try {
          const env = await session.execEnv()
          const entries = await env.listDir(target.cwd)
          if (entries.ok && !entries.value.length)
            text +=
              ' The workspace was empty at the time of the move. To use the repository, clone it there.'
        } catch {
          /* An unreadable destination has no verified contents. */
        }
      }
      notice = { ...notice, text }
      await this.directory.setLocationNotice(key, session.id, notice)
    }
    const address = {
      ...msg,
      senderId: notice.senderId,
      replyToId: notice.replyToId,
      routine: undefined,
      handoff: undefined,
    }
    try {
      if (!(await send(address, notice.text!, `move:${notice.token}`))) return
    } catch (error) {
      // An expired or conflicting saved intent must never get a new delivery identity.
      if (!(error instanceof LarkDeliveryRefusedError)) throw error
    }
    await this.directory.setLocationNotice(key, session.id, undefined)
  }

  resume(session: VelaSession) {
    return this.whenIdle(session, () => session.resume())
  }

  private async whenIdle<T>(
    session: VelaSession,
    task: () => Promise<T>,
  ): Promise<T> {
    while (!this.stopped()) {
      try {
        return await task()
      } catch (error) {
        if (
          !this.targets.has(session) ||
          (error as { code?: string })?.code !== 'SESSION_BUSY'
        )
          throw error
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    throw Error('Channel is shutting down')
  }

  constructor(
    private directory: ChannelDirectory,
    private channel: (name: string) => ChannelDefinition | undefined,
    private session: (id: string, options?: SessionOptions) => VelaSession,
    /** The open session with this id, without opening one: did something else create it first? */
    private find: (id: string) => VelaSession | undefined,
    private dataDir: string,
    /** Queues an input on the channel's existing path; a background result arrives this way. */
    private deliver: (name: string, msg: IncomingMessage) => void,
    private stopped: () => boolean,
  ) {}

  open(id: string, name?: string, message?: IncomingMessage): VelaSession {
    const key = this.directory.keyForSession(id)
    const record = this.directory.get(key)
    const channel = this.channel(record?.channel ?? name ?? '')
    const address = record ? storedMessage(record) : message
    const msg = address && {
      ...address,
      ...message,
      channelId: address.channelId,
      chatKind: address.chatKind,
      topic: address.topic,
    }
    if (!channel || !msg) throw new Error('Missing logical channel scope')
    const chatKind =
      record?.chatKind ?? (isGroupInput(msg) ? 'group' : 'direct')
    if (channel.canRecover?.(msg, chatKind) === false)
      throw new Error('Channel scope is no longer enabled')
    const scope = resolveChannelScope(
      this.dataDir,
      channel.name,
      msg.channelId,
      chatKind,
      this.directory.storageKey(channel.name, msg.channelId),
    )
    const options: SessionOptions | undefined = channel.sessionOptions?.(msg)
    const modifiers = [
      channel.sendFile && !options?.tools?.includes('-channel_send_file')
        ? '+channel_send_file'
        : '-channel_send_file',
      ...topicSessionOptions({ ...msg, chatKind }).tools,
      ...(!channel.topicCapabilities
        ? [
            '-channel_start_topic',
            '-channel_forward_to_topic',
            '-channel_read_topic',
          ]
        : []),
    ]
    const tools = options?.tools
    const selection =
      tools &&
      !tools.some((name) => name.startsWith('+') || name.startsWith('-'))
    const split = selection
      ? tools.filter((name) => !modifiers.includes(`-${name}`))
      : [...(tools ?? []), ...modifiers]
    const topic =
      record?.rootId && record.threadId
        ? { rootId: record.rootId, threadId: record.threadId }
        : undefined
    const sessionId = this.directory.sessionId(key)
    // A host can open the chat's session first (SDK `vela.session(id, { tools })`, or a read after idle
    // cleanup closed it); core then keeps that object and reads `tools` only when it constructs one.
    const opened = this.find(sessionId) === undefined
    const session = this.session(sessionId, {
      ...options,
      tools: split,
      channel: channel.name,
      scope: { id: scope.id, kind: scope.kind, dataDir: scope.dataDir },
      // A background command's exit is an ordinary queued input for its conversation, not a run
      // started from an extension: the gateway supplies the anchor, card, reaction, Stop and
      // ordering. A group hub is such a conversation, not only a topic.
      host:
        chatKind === 'group'
          ? {
              deliver: (text: string) =>
                this.deliverResult(key, channel.name, topic, text),
              background: async (event) => {
                if (this.stopped()) {
                  if (event.type === 'started')
                    throw new Error('Channel is shutting down')
                  return
                }
                if (this.directory.get(key)?.activeSessionId !== sessionId) {
                  if (event.type === 'started')
                    throw new Error('Channel session was replaced')
                  return
                }
                if (event.type === 'started')
                  await this.directory.startBackground(key, sessionId, {
                    token: event.token,
                    id: event.id,
                    commandHead: event.commandHead,
                  })
                else if (event.type === 'stopped')
                  await this.directory.forgetBackground(
                    key,
                    event.token,
                    sessionId,
                  )
                else {
                  const job = this.directory
                    .get(key)
                    ?.outstandingJobs?.find((job) => job.token === event.token)
                  if (!job || job.sessionId !== sessionId) return
                  this.deliverResult(
                    key,
                    channel.name,
                    topic,
                    event.text,
                    event.token,
                  )
                }
              },
            }
          : undefined,
    })
    if (options?.location) this.targets.set(session, options.location)
    // The chat's own split applies to a session something else opened too: a tool its chat turns off is
    // removed, and a hub's background commands are added, as when this call constructs the session.
    // What it never does is widen an allowlist the session already had: a positive list is
    // intersected, so a chat cannot turn back on a tool that list dropped. Applied once per object, so
    // a session_start hook's later choice survives.
    if (!this.toolSplitApplied.has(session)) {
      if (!opened) {
        if (!selection) setDefaultToolModifiers(session, split)
        // A modifier cannot reach an explicit selection, so a tool the chat turns off that is still
        // active means the session has one: keep that selection minus those tools.
        const off = split.filter((name) => name.startsWith('-'))
        const allowed = new Set(split)
        const active = session.getActiveTools()
        const narrowed = active.filter((name) =>
          selection ? allowed.has(name) : !off.includes(`-${name}`),
        )
        if (narrowed.length !== active.length) session.setActiveTools(narrowed)
      }
      this.toolSplitApplied.add(session)
    }
    if (typeof options?.model === 'string') {
      try {
        // Resolution is lazy; fail while opening rather than on the first prompt.
        void session.modelInfo
      } catch (error) {
        throw new Error(
          `Cannot resolve model "${options.model}" for chat ${msg.channelId}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
    }
    return session
  }

  /** A result produced outside a turn joins its conversation's queue, as a note from its requester. */
  private deliverResult(
    key: string,
    channelName: string,
    topic: { rootId: string; threadId: string } | undefined,
    text: string,
    backgroundJobToken?: string,
  ): void {
    const message = this.resultMessage(key, topic, text, backgroundJobToken)
    if (message) this.deliver(channelName, message)
  }

  private resultMessage(
    key: string,
    topic: { rootId: string; threadId: string } | undefined,
    text: string,
    backgroundJobToken?: string,
  ): IncomingMessage | undefined {
    const record = this.directory.get(key)
    if (!record) return
    // The conversation this result belongs to is gone: a closed hub, or another topic generation.
    if (topic ? record.rootId !== topic.rootId : !!record.rootId) return
    // Attributed to the conversation's requester, like a routine: the reply then mentions a person
    // who exists, and the text says where the result came from.
    return {
      backgroundJobToken,
      channelId: record.chatId,
      chatKind: 'group',
      senderId: record.requester.id,
      senderName: record.requester.name,
      text,
      ...(topic ? { topic } : {}),
      replyToId: topic?.rootId ?? record.replyTarget,
    }
  }

  /** Only jobs present at startup are lost; recovery itself may start new jobs. */
  async recoverBackground(
    record: ChannelRecord,
    session: VelaSession,
    hasInput: (token: string) => boolean,
    run: (message: IncomingMessage) => Promise<void>,
  ): Promise<void> {
    for (const job of record.outstandingJobs ?? []) {
      if (this.stopped()) return
      const current = this.directory.get(record.key)
      if (
        current?.activeSessionId !== job.sessionId ||
        !current.outstandingJobs?.some((item) => item.token === job.token)
      )
        continue
      if (hasInput(job.token)) {
        // A marker may have been appended during interrupted-turn recovery. Flush before trusting it.
        await session.save()
        await this.directory.forgetBackground(
          record.key,
          job.token,
          job.sessionId,
        )
        continue
      }
      const topic =
        record.rootId && record.threadId
          ? { rootId: record.rootId, threadId: record.threadId }
          : undefined
      const message = this.resultMessage(
        record.key,
        topic,
        `Background command ${job.id} ended with a restart; its result is unknown.\nCommand: ${job.commandHead}`,
        job.token,
      )
      if (message) await run(message)
    }
  }
}
