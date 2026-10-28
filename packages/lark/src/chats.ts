import { z } from 'zod'

const chatSchema = z
  .object({
    id: z.string().trim().min(1),
    tools: z.array(z.string().min(1)).optional(),
    readUntagged: z.boolean().optional(),
  })
  .strict()

export type LarkChat = z.infer<typeof chatSchema>

/** Keep legacy strings/comma-separated environment config; reject malformed and duplicate entries. */
export function parseChats(value: unknown): LarkChat[] {
  const input =
    value === undefined
      ? []
      : typeof value === 'string'
        ? value
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
        : value
  const chats = z
    .array(z.union([z.string().trim().min(1), chatSchema]))
    .parse(input)
    .map((chat) => (typeof chat === 'string' ? { id: chat } : chat))
  if (new Set(chats.map((chat) => chat.id)).size !== chats.length)
    throw new Error('Duplicate Lark chat id')
  return chats
}
