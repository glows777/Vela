import type { CustomMessage } from '../agent/events.ts'
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
  const last = session.messages.findLast(
    (message) => session.customMessageOf(message)?.customType === customType,
  )
  if (last && messageText(last) === content) return undefined
  return { customType, content, display: false }
}
