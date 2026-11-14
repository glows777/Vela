import type {
  SessionOptions,
  VelaSession,
} from '@glows777/vela-core/extension-api'
import { bindBackgroundDelivery } from './background-seam.ts'
import { type ChannelDirectory, isGroupInput } from './directory.ts'
import { storedMessage } from './recovery.ts'
import { resolveChannelScope } from './scope.ts'
import { topicSessionOptions } from './topics.ts'
import type { ChannelDefinition, IncomingMessage } from './types.ts'

/** Every opening path resolves current options from the logical chat, before resume or hooks. */
export class ChannelSessions {
  constructor(
    private directory: ChannelDirectory,
    private channel: (name: string) => ChannelDefinition | undefined,
    private session: (id: string, options?: SessionOptions) => VelaSession,
    private dataDir: string,
    /** Queues an input on the channel's existing path; a background result arrives this way. */
    private deliver: (name: string, msg: IncomingMessage) => void,
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
    const options = channel.sessionOptions?.(msg)
    const hidden = [
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
    const session = this.session(this.directory.sessionId(key), {
      ...options,
      tools: selection
        ? tools.filter((name) => !hidden.includes(`-${name}`))
        : [...(tools ?? []), ...hidden],
      channel: channel.name,
      scope: { id: scope.id, kind: scope.kind, dataDir: scope.dataDir },
    })
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
    // A background command's exit is an ordinary queued input for this topic, not a run started
    // from an extension: the gateway supplies the anchor, card, reaction, Stop and ordering.
    const topic =
      record?.rootId && record.threadId
        ? { rootId: record.rootId, threadId: record.threadId }
        : undefined
    bindBackgroundDelivery(
      session,
      topic
        ? (_session, result) =>
            this.deliverBackground(
              key,
              channel.name,
              topic.rootId,
              topic.threadId,
              result.text,
            )
        : undefined,
    )
    return session
  }

  private deliverBackground(
    key: string,
    channelName: string,
    rootId: string,
    threadId: string,
    text: string,
  ): void {
    const record = this.directory.get(key)
    if (!record || record.rootId !== rootId) return
    // A topic result is attributed to the topic's requester, like a routine: the reply then
    // mentions a person who exists, and the text says it came from a background command.
    this.deliver(channelName, {
      channelId: record.chatId,
      chatKind: 'group',
      senderId: record.requester.id,
      senderName: record.requester.name,
      text,
      topic: { rootId, threadId },
      replyToId: rootId,
    })
  }
}
