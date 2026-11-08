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
    const session = this.session(this.directory.sessionId(key), {
      ...options,
      permissions: {
        ...options?.permissions,
        ...topicSessionOptions({ ...msg, chatKind }).permissions,
        ...(!channel.topicCapabilities
          ? {
              channel_start_topic: 'deny' as const,
              channel_forward_to_topic: 'deny' as const,
              channel_read_topic: 'deny' as const,
            }
          : {}),
      },
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
    return session
  }
}
