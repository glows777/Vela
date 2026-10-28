import type { VelaEvent } from '../agent/events.ts'
import type { VelaSession } from '../vela-session.ts'

/** Publishes platform lifecycle output; core agent, tool and storage events remain core-owned. */
export function publishChannelEvent(
  session: VelaSession,
  event: Extract<
    VelaEvent,
    { type: 'channel_message' | 'channel_reply' | 'channel_error' }
  >,
): void {
  if (
    !['channel_message', 'channel_reply', 'channel_error'].includes(event.type)
  )
    throw new Error('Only channel events may be published')
  session.emit(event)
}
