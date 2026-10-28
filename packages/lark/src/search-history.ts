import { z } from 'zod'
import { messageText } from './messages.ts'
import type { LarkTransport } from './transport.ts'

export const historySearchSchema = z.object({
  keyword: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Case-insensitive literal text to match locally'),
  start_time: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      'Inclusive ISO 8601 start; defaults to seven days before end_time',
    ),
  end_time: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      'ISO 8601 end; defaults to now. Use an earlier end to search further',
    ),
})

/** Bounded, stateless chat listing; the caller supplies trusted logical group scope. */
export async function searchHistory(
  transport: LarkTransport,
  chatId: string,
  input: z.infer<typeof historySearchSchema>,
) {
  const end = input.end_time ? Date.parse(input.end_time) : Date.now()
  const start = input.start_time
    ? Date.parse(input.start_time)
    : end - 7 * 86400_000
  if (start >= end) throw new Error('start_time must be earlier than end_time')
  const result = {
    range: {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    },
    scannedRange: {
      newest: undefined as string | undefined,
      oldest: undefined as string | undefined,
    },
    scanned: 0,
    truncated: false,
    coverage:
      'Chat listing includes topic roots, not all thread replies. A missing thread reply is not evidence of indexing delay. Keyword matching is local to supported text/post and attachment descriptions; deleted and unsupported messages are omitted from matches. All returned times are ISO 8601 UTC. matchCounts counts only returned matches, not scanned messages or all group history; use senderType rather than guessing from text. If truncated, search again with an earlier end_time; messages sharing a boundary second may overlap or be omitted.',
    matches: [] as {
      messageId?: string
      createTime?: string
      senderId?: string
      senderType?: string
      text: string
    }[],
  }
  const complete = () => {
    const matchCounts = {
      total: result.matches.length,
      user: 0,
      app: 0,
      unknown: 0,
    }
    for (const match of result.matches) {
      const type = match.senderType
      matchCounts[type === 'user' || type === 'app' ? type : 'unknown']++
    }
    return { ...result, matchCounts }
  }
  const seen = new Set<string>()
  let pageToken: string | undefined
  const keyword = input.keyword?.toLocaleLowerCase()
  for (let page = 0; page < 5; page++) {
    const response = await transport.searchMessages(chatId, {
      startTime: String(Math.floor(start / 1000)),
      endTime: String(Math.floor(end / 1000)),
      limit: 50,
      pageToken,
    })
    for (let index = 0; index < response.items.length; index++) {
      const item = response.items[index]!
      result.scanned++
      if (item.create_time) {
        const time = new Date(Number(item.create_time)).toISOString()
        result.scannedRange.newest ??= time
        result.scannedRange.oldest = time
      }
      if (item.deleted || (item.message_id && seen.has(item.message_id)))
        continue
      if (item.message_id) seen.add(item.message_id)
      const text = messageText({
        chat_id: chatId,
        message_type: item.msg_type ?? '',
        content: item.body?.content ?? '',
        mentions: item.mentions,
      })
      if (!text || (keyword && !text.toLocaleLowerCase().includes(keyword)))
        continue
      result.matches.push({
        messageId: item.message_id,
        createTime: item.create_time
          ? new Date(Number(item.create_time)).toISOString()
          : undefined,
        senderId: item.sender?.id,
        senderType: item.sender?.sender_type,
        text,
      })
      if (JSON.stringify(complete(), null, 2).length > 20000) {
        result.matches.pop()
        result.truncated = true
        return complete()
      }
      if (result.matches.length === 20) {
        result.truncated =
          index + 1 < response.items.length || !!response.pageToken
        return complete()
      }
    }
    pageToken = response.pageToken
    if (!pageToken) return complete()
  }
  result.truncated = !!pageToken
  return complete()
}
