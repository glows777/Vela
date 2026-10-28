import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionScope } from '@glows777/vela-core/extension-api'
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

/** Resolve the shared workspace, without creating data for unowned-topic probes. */
export function groupWorkspace(
  dataDir: string,
  channel: string,
  chatId: string,
  create = true,
): string {
  const cwd = join(chatDirectory(dataDir, channel, chatId), 'workspace')
  if (create) mkdirSync(cwd, { recursive: true })
  return cwd
}
