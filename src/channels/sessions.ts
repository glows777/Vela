import type { SessionOptions, VelaSession } from '../vela-session.ts'
import type { ChannelDirectory } from './directory.ts'
import { storedMessage } from './recovery.ts'
import { channelScopes } from './scope.ts'
import type { ChannelDefinition, IncomingMessage } from './types.ts'

/** Every opening path resolves current options from the logical chat, before resume or hooks. */
export class ChannelSessions {
  constructor(
    private directory: ChannelDirectory,
    private channel: (name: string) => ChannelDefinition | undefined,
    private session: (id: string, options?: SessionOptions) => VelaSession,
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
      topic: address.topic,
    }
    if (!channel || !msg) throw new Error('Missing logical channel scope')
    const chatKind =
      record?.chatKind ?? (msg.topic || msg.replyToId ? 'group' : 'direct')
    if (channel.canRecover?.(msg, chatKind) === false)
      throw new Error('Channel scope is no longer enabled')
    const session = this.session(
      this.directory.sessionId(key),
      channel.sessionOptions?.(msg),
    )
    session.channel = channel.name
    channelScopes.set(session.registry, {
      channel: channel.name,
      chatId: msg.channelId,
      chatKind,
    })
    return session
  }
}
