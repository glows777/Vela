import { mkdirSync } from 'node:fs'
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
