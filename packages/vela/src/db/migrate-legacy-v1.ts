import { createHash } from 'node:crypto'
import { isPlainObject } from '../shared/interpolate.ts'
import type { VelaMessage } from '../shared/messages.ts'

export interface RawTranscriptEntry {
  type: string
  id: string
  parentId: string | null
  timestamp: string
  [key: string]: unknown
}

function createSyntheticId(taken: Set<string>, seed: string): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const input = attempt === 0 ? seed : `${seed}\0${attempt}`
    const candidate = createHash('sha256')
      .update(input)
      .digest('hex')
      .slice(0, 8)
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
  const fallback = createHash('sha256')
    .update(`${seed}\0full\0${taken.size}`)
    .digest('hex')
    .slice(0, 16)
  taken.add(fallback)
  return fallback
}

export function isV1Transcript(lines: unknown[]): boolean {
  const first = lines[0] as { type?: unknown; id?: unknown } | undefined
  return (
    first?.type === 'checkpoint' ||
    (first?.type === 'message' && first.id === undefined)
  )
}

export function convertV1ToEntries(
  sessionId: string,
  lines: unknown[],
  filePath: string,
  warnings: string[],
): { header: Record<string, unknown>; entries: RawTranscriptEntry[] } {
  const pushValidV1Message = (
    target: { timestamp?: string; message: VelaMessage }[],
    rawItem: unknown,
    fallbackTs?: string,
  ) => {
    if (
      !isPlainObject(rawItem) ||
      !isPlainObject(rawItem.message) ||
      typeof rawItem.message.role !== 'string'
    ) {
      warnings.push(`Skipped malformed checkpoint message in ${filePath}`)
      return
    }
    target.push({
      timestamp:
        typeof rawItem.timestamp === 'string' ? rawItem.timestamp : fallbackTs,
      message: rawItem.message as unknown as VelaMessage,
    })
  }

  let checkpoint: {
    timestamp?: string
    messages: { timestamp?: string; message: VelaMessage }[]
    model?: string
    thinkingLevel?: string
    name?: string
    summary?: string
  } = { messages: [] }

  for (const rawLine of lines) {
    if (!isPlainObject(rawLine)) continue
    if (rawLine.type === 'checkpoint' && Array.isArray(rawLine.messages)) {
      const nextMessages: { timestamp?: string; message: VelaMessage }[] = []
      const cpTs =
        typeof rawLine.timestamp === 'string' ? rawLine.timestamp : undefined
      for (const member of rawLine.messages) {
        pushValidV1Message(nextMessages, member, cpTs)
      }
      checkpoint = {
        timestamp: cpTs,
        messages: nextMessages,
        model: typeof rawLine.model === 'string' ? rawLine.model : undefined,
        thinkingLevel:
          typeof rawLine.thinkingLevel === 'string'
            ? rawLine.thinkingLevel
            : undefined,
        name: typeof rawLine.name === 'string' ? rawLine.name : undefined,
        summary:
          typeof rawLine.summary === 'string' ? rawLine.summary : undefined,
      }
    } else if (rawLine.type === 'message') {
      pushValidV1Message(checkpoint.messages, rawLine, new Date().toISOString())
    }
  }

  const fallbackTime =
    checkpoint.timestamp ??
    checkpoint.messages[0]?.timestamp ??
    new Date().toISOString()
  const header: Record<string, unknown> = {
    type: 'session',
    version: 2,
    id: sessionId,
    timestamp: checkpoint.messages[0]?.timestamp ?? fallbackTime,
  }

  const entries: RawTranscriptEntry[] = []
  const taken = new Set<string>()
  const push = (entry: {
    type: string
    timestamp: string
    [key: string]: unknown
  }) => {
    const seed = `${sessionId}\0${entries.length}\0${entry.type}\0${entry.timestamp}`
    const id = createSyntheticId(taken, seed)
    entries.push({
      ...entry,
      id,
      parentId: entries.at(-1)?.id ?? null,
    })
  }

  const firstTime = checkpoint.messages[0]?.timestamp ?? fallbackTime
  if (checkpoint.model) {
    push({
      type: 'model_change',
      timestamp: firstTime,
      model: checkpoint.model,
    })
  }
  if (checkpoint.thinkingLevel) {
    push({
      type: 'thinking_level_change',
      timestamp: firstTime,
      thinkingLevel: checkpoint.thinkingLevel,
    })
  }

  const summary = checkpoint.summary
  const expectedSummaryText = summary
    ? `[Summary of the earlier conversation]\n${summary}`
    : undefined
  const firstContent = checkpoint.messages[0]?.message?.content
  const compacted = Boolean(summary && firstContent === expectedSummaryText)

  for (const item of checkpoint.messages.slice(compacted ? 1 : 0)) {
    push({
      type: 'message',
      timestamp: item.timestamp ?? fallbackTime,
      message: item.message,
    })
  }

  if (compacted && summary) {
    const firstKept = entries.find((entry) => entry.type === 'message')
    push({
      type: 'compaction',
      timestamp: checkpoint.messages[0]?.timestamp ?? fallbackTime,
      summary,
      firstKeptEntryId: firstKept?.id ?? '',
      tokensBefore: 0,
    })
    const compaction = entries.at(-1)!
    if (!compaction.firstKeptEntryId) {
      compaction.firstKeptEntryId = compaction.id
    }
  }

  if (checkpoint.name) {
    push({
      type: 'session_info',
      timestamp: fallbackTime,
      name: checkpoint.name,
    })
  }

  return { header, entries }
}
