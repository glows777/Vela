import { z } from 'zod'
import { eventSchema } from './events.ts'
import type { ChannelEvent } from './types.ts'

export const genericOptions = z
  .object({
    secret: z.string().min(1),
    source: z
      .string()
      .trim()
      .min(1)
      .max(510)
      .refine(
        (source) => source.toLowerCase() !== 'github',
        'github is reserved',
      ),
  })
  .strict()

const payloadSchema = eventSchema
  .omit({ source: true, deliveryId: true })
  .extend({
    // Remote keys are kept unchanged, not silently normalized into another subscription.
    key: z
      .string()
      .min(1)
      .max(512)
      .refine((key) => key === key.trim()),
  })

/** Maps one authenticated producer to its configured source and exact key namespace. */
export function genericEvent(
  input: unknown,
  deliveryId: string,
  options: z.infer<typeof genericOptions>,
): ChannelEvent {
  const payload = payloadSchema.parse(input)
  const prefix = `${options.source}:`
  if (
    !payload.key.startsWith(prefix) ||
    !payload.key.slice(prefix.length).trim()
  )
    throw new Error('Event key is outside the configured source namespace')
  return eventSchema.parse({ ...payload, source: options.source, deliveryId })
}
