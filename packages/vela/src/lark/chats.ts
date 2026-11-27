import { z } from 'zod'
import { THINKING_LEVELS } from '../driver/diagnostics.ts'
import type { ThinkingLevel } from '../driver/index.ts'

const LEGACY_GROUP_CONTROL_TOOLS = [
  'channel_start_topic',
  'channel_forward_to_topic',
  'channel_list_topics',
  'channel_read_topic',
  'channel_skip_reply',
  'channel_routines',
  'channel_message_topic',
  'channel_message_group',
] as const

const chatSchema = z
  .object({
    id: z.string().trim().min(1),
    environment: z.string().trim().min(1).optional(),
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

export function groupSessionOptions(
  chat: LarkChat,
  cwd: string,
  topic: boolean,
) {
  const environment = chat.environment ?? 'local'
  return {
    cwd,
    location: {
      environment,
      cwd: environment === 'local' ? cwd : '/workspace',
    },
    model: (topic ? chat.topicModel : undefined) ?? chat.model,
    thinkingLevel:
      (topic ? chat.topicThinkingLevel : undefined) ?? chat.thinkingLevel,
    tools:
      chat.tools === undefined
        ? undefined
        : [
            ...new Set([
              ...chat.tools,
              ...LEGACY_GROUP_CONTROL_TOOLS,
              ...(topic ? ['channel_wait_for_input'] : []),
            ]),
          ],
  }
}

export function larkChatBindingConfig(chat: LarkChat): Record<string, unknown> {
  return {
    ...(chat.environment ? { environment: chat.environment } : {}),
    ...(chat.tools ? { tools: [...chat.tools] } : {}),
    ...(chat.readUntagged !== undefined
      ? { readUntagged: chat.readUntagged }
      : {}),
    ...(chat.model ? { model: chat.model } : {}),
    ...(chat.thinkingLevel ? { thinkingLevel: chat.thinkingLevel } : {}),
    ...(chat.topicModel ? { topicModel: chat.topicModel } : {}),
    ...(chat.topicThinkingLevel
      ? { topicThinkingLevel: chat.topicThinkingLevel }
      : {}),
  }
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
