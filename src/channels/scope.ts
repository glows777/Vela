import { join } from 'node:path'
import { channelSessionId } from './session-id.ts'

/** Transient binding for the session registry; durable routing remains in ChannelDirectory. */
export const channelScopes = new WeakMap<
  object,
  {
    channel: string
    chatId: string
    chatKind: 'group' | 'direct'
  }
>()

export function chatDirectory(
  dataDir: string,
  channel: string,
  chatId: string,
): string {
  return join(dataDir, 'channels', channelSessionId(channel, chatId))
}
