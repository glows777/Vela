import type { MemoryEntry } from './store.ts'

export interface SearchHit {
  entry: MemoryEntry
  score: number
}

/**
 * Simple tokenizer for English and Chinese:
 * - English and digits split on non-alphanumerics
 * - Chinese splits per character (crude, but memory entries are short)
 */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()
  let buf = ''
  for (const ch of lower) {
    if (/[a-z0-9_]/.test(ch)) {
      buf += ch
    } else if (/[一-龥]/.test(ch)) {
      if (buf) {
        tokens.push(buf)
        buf = ''
      }
      tokens.push(ch)
    } else {
      if (buf) {
        tokens.push(buf)
        buf = ''
      }
    }
  }
  if (buf) tokens.push(buf)
  return tokens
}

const K1 = 1.5
const B = 0.75

/**
 * BM25 ranking, much more accurate than a plain `includes` keyword match:
 * - tf saturation: a term appearing 10 times scores close to one appearing 100 times
 * - idf: common terms weigh less, rare terms weigh more
 * - length normalization: long documents do not rank first just for having more text
 */
export function bm25Search(
  entries: MemoryEntry[],
  query: string,
  topK = 5,
): SearchHit[] {
  if (entries.length === 0 || !query.trim()) return []

  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return []

  // One document per memory; name/description are weighted by repetition
  const docs = entries.map((e) => {
    const weighted = `${e.name} ${e.name} ${e.name} ${e.description} ${e.description} ${e.content}`
    return tokenize(weighted)
  })

  const N = docs.length
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / N

  // df: number of documents containing each term
  const df = new Map<string, number>()
  for (const doc of docs) {
    const seen = new Set(doc)
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1)
  }

  const hits: SearchHit[] = entries.map((entry, i) => {
    const doc = docs[i]!
    const dl = doc.length
    let score = 0
    for (const qt of queryTokens) {
      const dfQ = df.get(qt) || 0
      if (dfQ === 0) continue
      const tf = doc.filter((t) => t === qt).length
      if (tf === 0) continue
      const idf = Math.log((N - dfQ + 0.5) / (dfQ + 0.5) + 1)
      const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * dl) / avgdl))
      score += idf * norm
    }
    return { entry, score }
  })

  return hits
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}
