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

export { DIMS }
