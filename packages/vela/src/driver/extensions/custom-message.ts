import type { CustomMessage } from '../agent/events.ts'
import type { ModelMessage } from '../messages.ts'
import { messageText } from '../session/message-queue.ts'
import type { VelaSession } from '../vela-session.ts'

/**
 * Per-turn content for after the cached prefix: a custom message only when the last message of
 * `customType` in the model-visible context differs. Comparing against the context instead of
 * remembered state keeps it correct after compaction summarized the old message, after a resume in a
 * new process and after switching branches. Fixed instructions stay in the system prompt.
 */
export function customMessageIfChanged(
  session: VelaSession,
  customType: string,
  content: string,
): CustomMessage | undefined {
  const last = lastCustomMessage(session, customType)
  if (last && messageText(last) === content) return undefined
  return { customType, content, display: false }
}

/** The last message of `customType` in the model-visible context, if any (used to announce that its content is now empty). */
export function lastCustomMessage(
  session: VelaSession,
  customType: string,
): ModelMessage | undefined {
  return session.messages.findLast(
    (message) => session.customMessageOf(message)?.customType === customType,
  )
}

/**
 * Whether this request's messages lack the content of `customType`. Extensions pass the prefixes their message
 * text can start with (`[memory]`, `Group memory:`): the request's messages are a copy without the custom
 * metadata, so the text is what identifies one. An extension's `context` handler uses this to restore content
 * that automatic compaction removed after `before_agent_start` decided not to send it again.
 */
export function customMessageMissing(
  messages: readonly ModelMessage[],
  markers: readonly string[],
): boolean {
  return !messages.some(
    (message) =>
      message.role === 'user' &&
      markers.some((marker) => messageText(message).startsWith(marker)),
  )
}
