import type { StoredChunk } from './sqlite-store.ts'

export interface SearchResult {
  chunk: StoredChunk
  score: number
  vectorScore: number
  keywordScore: number
}

const MMR_LAMBDA = 0.7

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1)
}

export function normalizeFtsQuery(query: string): string {
  return tokenize(query)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' ')
}

// ── Normalization ──────────────────────────
export function normalizeMinMax(scores: number[]): number[] {
  if (scores.length === 0) return []
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  if (min === max) return scores.map(() => 0.5)
  const range = max - min
  return scores.map((s) => (s - min) / range)
}

// ── MMR deduplication ──────────────────────
export function mmrSelect(
  results: SearchResult[],
  topK: number,
): SearchResult[] {
  if (results.length <= topK) return results

  const selected: SearchResult[] = [results[0]!]
  const remaining = results.slice(1)

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0
    let bestMmr = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i]!.score
      const maxSim = Math.max(
        ...selected.map((s) =>
          jaccardSimilarity(s.chunk.text, remaining[i]!.chunk.text),
        ),
      )
      const mmr = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim
      if (mmr > bestMmr) {
        bestMmr = mmr
        bestIdx = i
      }
    }

    selected.push(remaining[bestIdx]!)
    remaining.splice(bestIdx, 1)
  }

  return selected
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a))
  const setB = new Set(tokenize(b))
  const intersection = [...setA].filter((t) => setB.has(t)).length
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 0 : intersection / union
}
