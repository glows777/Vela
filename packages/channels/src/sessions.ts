import type {
  SessionOptions,
  VelaSession,
} from '@glows777/vela-core/extension-api'
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
    const modifiers = [
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
    const topic =
      record?.rootId && record.threadId
        ? { rootId: record.rootId, threadId: record.threadId }
        : undefined
    const session = this.session(this.directory.sessionId(key), {
      ...options,
      tools: selection
        ? tools.filter((name) => !modifiers.includes(`-${name}`))
        : [...(tools ?? []), ...modifiers],
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
            }
          : undefined,
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
    return session
  }

  /** A result produced outside a turn joins its conversation's queue, as a note from its requester. */
  private deliverResult(
    key: string,
    channelName: string,
    topic: { rootId: string; threadId: string } | undefined,
    text: string,
  ): void {
    const record = this.directory.get(key)
    if (!record) return
    // The conversation this result belongs to is gone: a closed hub, or another topic generation.
    if (topic ? record.rootId !== topic.rootId : !!record.rootId) return
    // Attributed to the conversation's requester, like a routine: the reply then mentions a person
    // who exists, and the text says where the result came from.
    this.deliver(channelName, {
      channelId: record.chatId,
      chatKind: 'group',
      senderId: record.requester.id,
      senderName: record.requester.name,
      text,
      ...(topic ? { topic } : {}),
      replyToId: topic?.rootId ?? record.replyTarget,
    })
  }
}
