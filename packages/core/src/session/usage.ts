import type { TokenTracker } from '../usage/tracker.ts'
import type { SessionUsage } from './options.ts'

/** Token estimate, context usage and a session's total usage. */
export function sessionUsage(tracker: TokenTracker): SessionUsage {
  const last = tracker.recent(1)[0]
  return {
    ...tracker.status,
    totals: tracker.totals(),
    contextWindow: tracker.contextWindow,
    ...(last ? { lastRecord: { ...last } } : {}),
  }
}
