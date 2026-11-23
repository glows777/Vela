import { join } from 'node:path'
import type { SessionScope } from '../extension-api.ts'
import { channelSessionId } from './session-id.ts'

export interface ChannelScope extends SessionScope {
  readonly channel: string
  readonly chatId: string
  readonly chatKind: 'group' | 'direct'
}

export function resolveChannelScope(
  dataDir: string,
  channel: string,
  chatId: string,
  chatKind: 'group' | 'direct',
  storageKey?: string,
): ChannelScope {
  return {
    id: channelSessionId(channel, chatId),
    kind: chatKind === 'group' ? 'shared' : 'private',
    dataDir: storageKey
      ? join(dataDir, 'channels', storageKey)
      : chatDirectory(dataDir, channel, chatId),
    channel,
    chatId,
    chatKind,
  }
}

export function chatDirectory(
  dataDir: string,
  channel: string,
  chatId: string,
): string {
  return join(dataDir, 'channels', channelSessionId(channel, chatId))
}
