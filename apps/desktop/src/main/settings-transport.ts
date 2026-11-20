import type { LarkTransport } from '@glows777/vela-lark'

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
  if (appId !== 'verify-app' || !secret || secret === 'invalid')
    throw new Error('Invalid test credentials')
}
