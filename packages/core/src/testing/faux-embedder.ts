type EmbeddingFn = ((
  texts: string[],
  signal?: AbortSignal,
) => Promise<number[][]>) & { readonly id?: string }

/**
 * Deterministic offline embedder: splits text into words (CJK as adjacent character pairs),
 * hashes them into a fixed number of dimensions, then L2-normalizes.
 * Equal text gives equal vectors and more word overlap gives higher cosine similarity,
 * enough for RAG ingest/search to produce meaningful rankings in tests.
 */
export function createFauxEmbedder(
  options: {
    dims?: number
    /** Embedder id recorded by the knowledge base (default `faux`) */
    id?: string
    onCall?: (texts: string[]) => void
  } = {},
): EmbeddingFn {
  const dims = options.dims ?? 128
  const fn = async (texts: string[], signal?: AbortSignal) => {
    signal?.throwIfAborted()
    options.onCall?.(texts)
    return texts.map((text) => embedText(text, dims))
  }
  return Object.assign(fn, { id: options.id ?? 'faux' })
}

function embedText(text: string, dims: number): number[] {
  const vector = new Array<number>(dims).fill(0)
  for (const token of tokenize(text)) vector[hash(token) % dims]! += 1
  const norm = Math.hypot(...vector)
  // Empty text still yields a valid unit vector
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
