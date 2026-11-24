import { createHash } from 'node:crypto'
import type { VelaSession } from '../extension-api.ts'
import type { ChannelDefinition, OutgoingMessage } from './types.ts'

const MARKER = 'channel.lark_delivery'
const WINDOW_MS = 60 * 60 * 1000

/** A persisted intent cannot safely be retried; unlike transport/save failures, this is terminal. */
export class LarkDeliveryRefusedError extends Error {}

interface Intent {
  identity: string
  fingerprint: string
  uuid: string
  startedAt: number
  payload?: unknown
  confirmed?: boolean
  result?: unknown
}
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')

/** Persist before the API call. A lost receipt may retry only inside Lark's one-hour window. */
export async function larkDelivery<T>(
  session: VelaSession,
  identity: string,
  payload: unknown,
  send: (uuid: string) => Promise<T>,
): Promise<T> {
  const fingerprint = digest(JSON.stringify(payload))
  const previous = savedIntent(session, identity)
  const uuid = digest(`${session.id}\n${identity}`).slice(0, 40)
  if (
    previous &&
    (previous.fingerprint !== fingerprint ||
      previous.uuid !== uuid ||
      !Number.isFinite(previous.startedAt) ||
      (previous.confirmed !== undefined &&
        typeof previous.confirmed !== 'boolean'))
  )
    throw new LarkDeliveryRefusedError(
      'Lark delivery identity does not match its saved intent; not sent',
    )
  if (previous?.confirmed) return previous.result as T
  const intent: Intent = previous ?? {
    identity,
    fingerprint,
    payload,
    uuid,
    startedAt: Date.now(),
  }
  const age = Date.now() - intent.startedAt
  if (age < 0 || age >= WINDOW_MS)
    throw new LarkDeliveryRefusedError(
      'Lark delivery is unknown: its deduplication window expired; not resent',
    )
  if (!previous) session.appendEntry(MARKER, intent)
  // Also flush a still-buffered intent after a failed save before attempting any send.
  await session.save()
  const result = await send(uuid)
  session.appendEntry(MARKER, { ...intent, confirmed: true, result })
  await session.save()
  return result
}

function savedIntent(
  session: VelaSession,
  identity: string,
): Intent | undefined {
  return session
    .getEntries()
    .filter((entry) => entry.type === 'custom')
    .filter((entry) => entry.customType === MARKER)
    .map((entry) => entry.data as Intent | undefined)
    .findLast((intent) => intent?.identity === identity)
}

/** Only actual saved final answers participate; status/error notices have no assistant identity. */
function finalAnswerIdentity(
  session: VelaSession,
  text: string,
): string | undefined {
  const last = session
    .getBranch()
    .filter((entry) => entry.type === 'message')
    .at(-1)
  if (last?.message.role !== 'assistant' || last.stopReason) return
  const content = last.message.content
  if (
    Array.isArray(content) &&
    content.some((part) => part.type === 'tool_call')
  )
    return
  const answer =
    typeof content === 'string'
      ? content
      : content.map((part) => (part.type === 'text' ? part.text : '')).join('')
  return answer === text ? `answer:${last.id}` : undefined
}

export async function sendAnswer(
  session: VelaSession,
  channel: ChannelDefinition,
  message: OutgoingMessage,
  recovering = false,
): Promise<void> {
  const identity =
    channel.name === 'lark'
      ? finalAnswerIdentity(session, message.text)
      : undefined
  if (!identity) return channel.send(message)
  // A topic's requester is its creator, not necessarily the sender of this turn.
  // Restore the live recipient only for recovery; other routing/payload changes still fail closed.
  const saved = recovering ? savedIntent(session, identity) : undefined
  if (saved?.payload && typeof saved.payload === 'object') {
    const recipientId = (saved.payload as { recipientId?: unknown }).recipientId
    if (recipientId !== undefined && typeof recipientId !== 'string')
      throw new LarkDeliveryRefusedError(
        'Lark delivery has an invalid saved recipient; not sent',
      )
    message = { ...message, recipientId }
  }
  await larkDelivery(
    session,
    identity,
    {
      channelId: message.channelId,
      replyToId: message.replyToId,
      recipientId: message.recipientId,
      text: message.text,
      mention: !!(message.topic || message.routine || message.handoff),
    },
    (deliveryId) => channel.send({ ...message, deliveryId }),
  )
}
