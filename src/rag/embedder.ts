import { createOpenAI } from '@ai-sdk/openai'
import { embedMany } from 'ai'

const DIMS = 128

export type EmbeddingFn = (texts: string[], signal?: AbortSignal) => Promise<number[][]>

export function createEmbedder({
  modelId,
  apiKey,
  url,
}: {
  modelId: string
  apiKey: string
  url: string
}): EmbeddingFn {
  return async (texts: string[], signal?: AbortSignal) => {
    const model = createOpenAI({
      baseURL: url,
      apiKey,
    }).embedding(modelId)
    const { embeddings } = await embedMany({
      model,
      values: texts,
      abortSignal: signal,
      providerOptions: { openai: { dimensions: DIMS } },
    })
    return embeddings
  }
}

const embedCache = new Map<string, number[]>()

export async function embed(
  fn: EmbeddingFn,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  signal?.throwIfAborted()
  const results: number[][] = new Array(texts.length)
  const uncached: { idx: number; text: string }[] = []

  for (let i = 0; i < texts.length; i++) {
    const cached = embedCache.get(texts[i]!)
    if (cached) {
      results[i] = cached
    } else {
      uncached.push({ idx: i, text: texts[i]! })
    }
  }

  if (uncached.length > 0) {
    const vectors = await fn(uncached.map((u) => u.text), signal)
    signal?.throwIfAborted()
    for (let i = 0; i < uncached.length; i++) {
      results[uncached[i]!.idx] = vectors[i]!
      embedCache.set(uncached[i]!.text, vectors[i]!)
    }
  }

  return results
}

// 1000 个 chunk 以内的场景，纯 JS 的实现够用。
// 生产环境可以考虑 用 sqlite-vec 的 vec_distance_cosine 做向量搜索也会快很多（C 实现 + 索引加速）
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0,
    normA = 0,
    normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1)
}

export { DIMS }
