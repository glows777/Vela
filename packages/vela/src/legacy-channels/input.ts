import type { IncomingMessage } from './types.ts'

/**
 * Marks untagged group discussion in the text the model receives. The channel prompt is fixed per
 * session kind, so each input says what it is instead of the prompt saying it for one wake.
 */
export const UNTAGGED_INPUT =
  '[untagged group discussion, not addressed to you]'

/** The text the model receives. A passive input identifies itself; every other input passes through. */
export function modelInputText(msg: IncomingMessage): string {
  if (!msg.passive || msg.text.startsWith(UNTAGGED_INPUT)) return msg.text
  return `${UNTAGGED_INPUT}\n${msg.text}`
}
