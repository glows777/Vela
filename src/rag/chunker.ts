export interface Chunk {
  id: string
  text: string
  source: string
  index: number
  tokenEstimate: number
}

const TARGET_TOKENS = 256
const CHARS_PER_TOKEN = 4
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN

export function chunkDocument(source: string, text: string): Chunk[] {
  const paragraphs = text.split(/\n{2,}/)
  const chunks: Chunk[] = []
  let current = ''
  let idx = 0

  for (const para of paragraphs) {
    const trimmed = para.trim()
    if (!trimmed) continue

    if (
      current.length + trimmed.length + 2 > TARGET_CHARS &&
      current.length > 0
    ) {
      chunks.push(makeChunk(source, current.trim(), idx++))
      current = ''
    }

    if (trimmed.length > TARGET_CHARS) {
      if (current.length > 0) {
        chunks.push(makeChunk(source, current.trim(), idx++))
        current = ''
      }
      const sentences = trimmed.split(/(?<=[。！？.!?])\s*/)
      let sentBuf = ''
      for (const sent of sentences) {
        if (
          sentBuf.length + sent.length + 1 > TARGET_CHARS &&
          sentBuf.length > 0
        ) {
          chunks.push(makeChunk(source, sentBuf.trim(), idx++))
          sentBuf = ''
        }
        sentBuf += (sentBuf ? ' ' : '') + sent
      }
      if (sentBuf.trim()) {
        current = sentBuf.trim()
      }
    } else {
      current += (current ? '\n\n' : '') + trimmed
    }
  }

  if (current.trim()) {
    chunks.push(makeChunk(source, current.trim(), idx++))
  }

  return chunks
}

function makeChunk(source: string, text: string, index: number): Chunk {
  return {
    id: `${source}#${index}`,
    text,
    source,
    index,
    tokenEstimate: Math.ceil(text.length / CHARS_PER_TOKEN),
  }
}
