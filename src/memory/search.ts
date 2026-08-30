import type { MemoryEntry } from './store'

export interface SearchHit {
  entry: MemoryEntry
  score: number
}

/**
 * 简单的中英文分词：
 * - 英文 / 数字按非字母数字分隔
 * - 中文按字切分（粗暴但够用——记忆条目都很短）
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
 * BM25 排序——比简单的 includes 关键词搜索准很多：
 * - tf 饱和：一个词出现 10 次和 100 次差距不大
 * - idf：常见词权重低，罕见词权重高
 * - 文档长度归一化：长文档不会因为内容多就一定排前面
 */
export function bm25Search(
  entries: MemoryEntry[],
  query: string,
  topK = 5,
): SearchHit[] {
  if (entries.length === 0 || !query.trim()) return []

  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return []

  // 把每条记忆拼成单一文档——name/description 适当加权（重复几遍）
  const docs = entries.map((e) => {
    const weighted = `${e.name} ${e.name} ${e.name} ${e.description} ${e.description} ${e.content}`
    return tokenize(weighted)
  })

  const N = docs.length
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / N

  // df：包含每个词的文档数
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
