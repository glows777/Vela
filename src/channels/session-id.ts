import { createHash } from 'node:crypto'

const PLAIN = /^[A-Za-z0-9_]+$/

/**
 * Shared session id for a chat or topic, e.g. `feishu-oc_456`. Non-plain or long ids get a
 * hash suffix so different (channel, conversation, topic root) tuples cannot share history.
 */
export const channelSessionId = (
  channel: string,
  conversationId: string,
  topicRootId?: string,
) => {
  const parts = [channel, conversationId]
  if (topicRootId !== undefined) parts.push(topicRootId)
  const plain = parts.join('-')
  if (parts.every((part) => PLAIN.test(part)) && plain.length <= 128)
    return plain
  const hash = createHash('sha256')
    .update(parts.join('\0'))
    .digest('hex')
    .slice(0, 16)
  const safe = plain.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128 - 17)
  return `${safe}.${hash}`
}
