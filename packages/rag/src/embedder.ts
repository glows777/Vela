import { createOpenAI } from '@ai-sdk/openai'
import { embedMany } from 'ai'

const DIMS = 128

/**
 * Turns texts into 128-dimension vectors. `id` names the model behind it (`createEmbedder` sets it):
 * the knowledge base records it and refuses to mix vectors from different embedders.
 */
export type EmbeddingFn = ((
  texts: string[],
  signal?: AbortSignal,
) => Promise<number[][]>) & { readonly id?: string }

export function createEmbedder({
  modelId,
  apiKey,
  url,
}: {
  modelId: string
  apiKey: string
  url: string
}): EmbeddingFn {
  const fn = async (texts: string[], signal?: AbortSignal) => {
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
  return Object.assign(fn, { id: `${modelId} at ${url}` })
}

// Cached vectors are only valid for the embedder that produced them, so each
// EmbeddingFn gets its own cache. Keyed by the function itself: a different
// model or endpoint means a different function, and its cache goes with it.
// Bounded: every ingested chunk passes through here, and its vector is already stored in the knowledge base.
const embedCaches = new WeakMap<EmbeddingFn, Map<string, number[]>>()
/** Most recently used texts kept per embedder */
export const EMBED_CACHE_SIZE = 1000

export async function embed(
  fn: EmbeddingFn,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  signal?.throwIfAborted()
  let embedCache = embedCaches.get(fn)
  if (!embedCache) {
    embedCache = new Map()
    embedCaches.set(fn, embedCache)
  }
  const results: number[][] = new Array(texts.length)
  const uncached: { idx: number; text: string }[] = []

  for (const [i, text] of texts.entries()) {
    const cached = embedCache.get(text)
    if (cached) {
      results[i] = cached
      // Move to the end: the oldest entry is the least recently used
      embedCache.delete(text)
      embedCache.set(text, cached)
    } else {
      uncached.push({ idx: i, text })
    }
  }

  if (uncached.length > 0) {
    const vectors = await fn(
      uncached.map((u) => u.text),
      signal,
    )
    signal?.throwIfAborted()
    for (let i = 0; i < uncached.length; i++) {
      results[uncached[i]!.idx] = vectors[i]!
      embedCache.set(uncached[i]!.text, vectors[i]!)
    }
    for (const text of embedCache.keys()) {
      if (embedCache.size <= EMBED_CACHE_SIZE) break
      embedCache.delete(text)
    }
  }

  return results
}

export { DIMS }
