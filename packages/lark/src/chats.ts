import type { ThinkingLevel } from '@glows777/vela-core'
import { THINKING_LEVELS } from '@glows777/vela-core/diagnostics'
import { z } from 'zod'

const chatSchema = z
  .object({
    id: z.string().trim().min(1),
    tools: z.array(z.string().min(1)).optional(),
    readUntagged: z.boolean().optional(),
    /** `provider/id` for the group session. */
    model: z.string().trim().min(1).optional(),
    thinkingLevel: z.string().optional(),
    /** `provider/id` for the group's topics; defaults to `model`. */
    topicModel: z.string().trim().min(1).optional(),
    topicThinkingLevel: z.string().optional(),
  })
  .strict()

type ParsedChat = z.infer<typeof chatSchema>

export interface LarkChat
  extends Omit<ParsedChat, 'thinkingLevel' | 'topicThinkingLevel'> {
  thinkingLevel?: ThinkingLevel
  topicThinkingLevel?: ThinkingLevel
}

const thinkingLevels: readonly string[] = THINKING_LEVELS

function validateThinkingLevel(chat: ParsedChat): void {
  for (const key of ['thinkingLevel', 'topicThinkingLevel'] as const) {
    const level = chat[key]
    if (level !== undefined && !thinkingLevels.includes(level))
      throw new Error(
        `Unknown Lark thinking level "${level}" for chat ${chat.id}`,
      )
  }
}

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
  for (const chat of chats) validateThinkingLevel(chat)
  return chats as LarkChat[]
}

/** A chat's configured tools must exist after extensions load; a typo fails startup. */
export function validateChatTools(
  chats: Iterable<LarkChat>,
  names: readonly string[],
): void {
  const known = new Set(names)
  for (const chat of chats)
    for (const name of chat.tools ?? [])
      if (!known.has(name))
        throw new Error(`Unknown Lark tool "${name}" for chat ${chat.id}`)
}
