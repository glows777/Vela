import type { EmbeddingFn } from '../extensions/rag/embedder.ts'

/**
 * 确定性的离线 embedder：把文本切成词（中文按相邻两字）后哈希到固定维度，再做 L2 归一化。
 * 相同文本得到相同向量，词重叠越多余弦相似度越高，足够让 RAG 的 ingest/search 在测试里跑出有意义的排序。
 */
export function createFauxEmbedder(
  options: { dims?: number; onCall?: (texts: string[]) => void } = {},
): EmbeddingFn {
  const dims = options.dims ?? 128
  return async (texts, signal) => {
    signal?.throwIfAborted()
    options.onCall?.(texts)
    return texts.map((text) => embedText(text, dims))
  }
}

function embedText(text: string, dims: number): number[] {
  const vector = new Array<number>(dims).fill(0)
  for (const token of tokenize(text)) vector[hash(token) % dims]! += 1
  const norm = Math.hypot(...vector)
  // 空文本也返回一个合法的单位向量
  if (norm === 0) {
    vector[0] = 1
    return vector
  }
  return vector.map((v) => v / norm)
}

function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const word of text.toLowerCase().match(/[a-z0-9_]+|[一-鿿]+/g) ?? []) {
    if (/^[一-鿿]+$/.test(word)) {
      const chars = Array.from(word)
      if (chars.length === 1) tokens.push(word)
      for (let i = 0; i + 1 < chars.length; i++)
        tokens.push(chars[i]! + chars[i + 1]!)
    } else tokens.push(word)
  }
  return tokens
}

function hash(token: string): number {
  let h = 2166136261
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
