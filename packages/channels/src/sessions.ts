import type {
  SessionOptions,
  VelaSession,
} from '@glows777/vela-core/extension-api'
import type { ChannelDirectory } from './directory.ts'
import { storedMessage } from './recovery.ts'
import { resolveChannelScope } from './scope.ts'
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
      topic: address.topic,
    }
    if (!channel || !msg) throw new Error('Missing logical channel scope')
    const chatKind =
      record?.chatKind ?? (msg.topic || msg.replyToId ? 'group' : 'direct')
    if (channel.canRecover?.(msg, chatKind) === false)
      throw new Error('Channel scope is no longer enabled')
    const scope = resolveChannelScope(
      this.dataDir,
      channel.name,
      msg.channelId,
      chatKind,
    )
    return this.session(this.directory.sessionId(key), {
      ...channel.sessionOptions?.(msg),
      channel: channel.name,
      scope: { id: scope.id, kind: scope.kind, dataDir: scope.dataDir },
    })
  }
}
