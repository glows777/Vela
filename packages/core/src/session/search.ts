import { messageText, type SessionFileEntry } from './entries.ts'

/** One session a `Vela.searchSessions()` query matched. */
export interface SessionSearchHit {
  /** Session id */
  id: string
  /** The first matching message text, shortened around the query */
  match: string
}

/** Characters of text shown before and after the query */
const CONTEXT = 40
/** Upper bound for a match, so a long message still reads as one line */
const MAX_MATCH = 120

/**
 * The first user or assistant message text containing `query` (case-insensitive, whitespace collapsed),
 * with a little context around it. Tool output, `!` commands, summaries and custom messages are not searched.
 */
export function searchSessionText(
  entries: SessionFileEntry[],
  query: string,
): string | undefined {
  const needle = query.trim().replace(/\s+/g, ' ').toLowerCase()
  if (!needle) return
  for (const entry of entries) {
    if (entry.type !== 'message') continue
    if (entry.message.role !== 'user' && entry.message.role !== 'assistant')
      continue
    const text = messageText(entry.message.content).replace(/\s+/g, ' ').trim()
    const at = text.toLowerCase().indexOf(needle)
    if (at < 0) continue
    const start = Math.max(0, at - CONTEXT)
    const end = Math.min(text.length, at + needle.length + CONTEXT)
    const match = `${start > 0 ? '…' : ''}${text.slice(start, end)}${
      end < text.length ? '…' : ''
    }`
    return match.length > MAX_MATCH
      ? `${match.slice(0, MAX_MATCH - 1)}…`
      : match
  }
}
