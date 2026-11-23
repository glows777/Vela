import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { LarkTransport } from '@glows777/vela'

/** The settings journey only opens and closes a connection. Never contact a tenant. */
export function settingsTransport(
  appId: unknown,
  secret: unknown,
): LarkTransport {
  const unavailable = () => {
    throw new Error('The settings journey only verifies connections')
  }
  return {
    async start() {
      await verifySettingsCredentials(appId, secret)
    },
    async getBotId() {
      return 'settings-bot'
    },
    stop() {},
    startTopic: unavailable,
    forward: unavailable,
    send: unavailable,
    reply: unavailable,
    sendCard: unavailable,
    patchCard: unavailable,
    addReaction: unavailable,
    removeReaction: unavailable,
    getResource: unavailable,
    getSenderName: unavailable,
    listTopicMessages: unavailable,
    searchMessages: unavailable,
    listMessages: unavailable,
  }
}
export async function verifySettingsCredentials(
  appId: unknown,
  secret: unknown,
) {
  if (appId === 'verify-held' && process.env.VELA_DIR) {
    const dir = process.env.VELA_DIR
    await writeFile(join(dir, 'verification-started'), '')
    for (let i = 0; i < 300; i++) {
      if (existsSync(join(dir, 'release-verification'))) return
      await delay(100)
    }
    throw new Error('Test verification timed out')
  }
  if (appId !== 'verify-app' || !secret || secret === 'invalid')
    throw new Error('Invalid test credentials')
}
