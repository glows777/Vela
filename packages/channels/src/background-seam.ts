import type { VelaSession } from '@glows777/vela-core/extension-api'

/**
 * The two keys the background extension uses on a session
 * (`packages/core/src/extensions/background/host.ts`). A global symbol keeps the seam out of the
 * public API: channels supplies the queue, the extension decides when a result arrives.
 */
const DELIVERY = Symbol.for('vela.background.delivery')
const BUSY = Symbol.for('vela.background.busy')

/** Delivers a finished command's result through the channel's own input queue. */
export type BackgroundDelivery = (
  session: VelaSession,
  result: { text: string },
) => void

/** Bind the topic's queue to this session, or unbind it where a result has no topic to answer. */
export function bindBackgroundDelivery(
  session: VelaSession,
  delivery: BackgroundDelivery | undefined,
): void {
  const bound = session as unknown as Record<symbol, unknown>
  if (delivery) bound[DELIVERY] = delivery
  else delete bound[DELIVERY]
}

/** Whether a running background command needs this session to stay open. */
export function backgroundRunning(session: VelaSession): boolean {
  const busy = (
    session as unknown as Record<symbol, (() => boolean) | undefined>
  )[BUSY]
  return busy?.() === true
}
