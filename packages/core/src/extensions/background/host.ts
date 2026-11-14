import type { VelaSession } from '../../vela-session.ts'

/** A finished background command, in the form its session receives it. */
export interface BackgroundResult {
  id: string
  command: string
  /** The message the session gets: exit state, command head and output tail. */
  text: string
}

/** Whether a session still has running commands; idle cleanup must not close it. */
export const BACKGROUND_BUSY = Symbol.for('vela.background.busy')

/** A channel's queue, so a job's exit becomes an ordinary queued input for its topic. */
export type BackgroundDelivery = (
  session: VelaSession,
  result: BackgroundResult,
) => void | Promise<void>

/**
 * Where a channel session carries the queue that delivers its background results. The channels
 * package binds it on every session it opens (`packages/channels/src/sessions.ts`); a session
 * without it delivers through `sendMessage`, which is the CLI and SDK path. A global symbol keeps
 * this one seam out of the public API.
 */
export const BACKGROUND_DELIVERY = Symbol.for('vela.background.delivery')

/** The queue bound to this session, if any. */
export function backgroundDelivery(
  session: VelaSession,
): BackgroundDelivery | undefined {
  return (session as unknown as Record<symbol, BackgroundDelivery | undefined>)[
    BACKGROUND_DELIVERY
  ]
}
