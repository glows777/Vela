import { z } from 'zod'
import { LocalChannel } from './local-channel.ts'
import type { LocalOptions } from './local-protocol.ts'
import type { ChannelExtension } from './vela.ts'

const optionsSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0 && !/[\r\n]/.test(value))
      .optional(),
    port: z.number().int().min(0).max(65535).optional(),
    timezone: z.string().optional(),
  })
  .strict()

/** Explicit SDK configuration only. The CLI resolves its user-level settings before calling this. */
export function local(options: LocalOptions): ChannelExtension {
  const parsed = optionsSchema.safeParse(options)
  if (!parsed.success)
    throw new Error('Local requires a valid optional token, port and timezone')
  return function local(vela) {
    vela.registerChannel(
      new LocalChannel(parsed.data, vela.dataDir, vela.logger),
    )
  }
}
