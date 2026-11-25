/**
 * Reading a compaction request, shared by the faux model and the demo model.
 *
 * `summarize()` (src/driver/context/compressor.ts) sends the dropped messages as one `<conversation>` block
 * and numbers each message in place: `[index] role` on its own line, then the message text.
 */

export interface CompactionSource {
  index: number
  role: string
  text: string
}

/** The `<conversation>` (or `<current-turn-prefix>`) block among the request's message texts, if this is a compaction request. */
export function findConversation(texts: string[]): string | undefined {
  for (const text of texts) {
    const match =
      /<(?:conversation|current-turn-prefix)>[\s\S]*?<\/(?:conversation|current-turn-prefix)>/.exec(
        text,
      )
    if (match) return match[0]
  }
  return undefined
}

/** Old messages of a compaction request, parsed from its `<conversation>` block. */
export function compactionSources(conversation: string): CompactionSource[] {
  const body = conversation
    .replace(/^<(?:conversation|current-turn-prefix)>\n/, '')
    .replace(/\n<\/(?:conversation|current-turn-prefix)>$/, '')
  return body.split(/\n\n(?=\[\d+\] )/).flatMap((block) => {
    const match = /^\[(\d+)\] ([a-z]+)\n([\s\S]*)$/.exec(block)
    if (!match || !match[3]!.trim()) return []
    return [{ index: Number(match[1]), role: match[2]!, text: match[3]! }]
  })
}
