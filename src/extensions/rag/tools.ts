import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import z from 'zod'
import type { ToolDefinition } from '../../index.ts'
import { chunkDocument } from './chunker.ts'
import { type EmbeddingFn, embed } from './embedder.ts'
import type { SqliteVectorStore } from './sqlite-store.ts'

export const createRagToolsInputSchema = z.object({
  path: z.string().describe('Document path'),
})

export const ragSearchToolInputSchema = z.object({
  query: z.string().describe('Search query'),
  top_k: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe('Number of results to return (default 5)'),
})

/** Chunks and embeds a document and stores it in the knowledge base. Relative paths resolve against cwd (like the file tools). Returns a human-readable result. */
export async function ingestDocument(
  vectorStore: SqliteVectorStore,
  embedFn: EmbeddingFn,
  cwd: string,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const text = await readFile(resolve(cwd, path), 'utf8')
  const chunks = chunkDocument(path, text)
  const embeddings = await embed(
    embedFn,
    chunks.map((c) => c.text),
    signal,
  )
  vectorStore.replaceSource(
    path,
    chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i]! })),
  )
  return `Ingested ${chunks.length} document chunks (source: ${path}). The knowledge base has ${vectorStore.size()} chunks.`
}

/** Tools of the rag extension; the model sees them as rag_ingest / rag_search. */
export function createRagTools(
  vectorStore: SqliteVectorStore,
  embedFn: EmbeddingFn,
  cwd: string,
): ToolDefinition[] {
  const ragIngestTool: ToolDefinition = {
    name: 'ingest',
    description:
      'Ingest a document into the knowledge base. path is the file path; the content is chunked, embedded and stored.',
    inputSchema: createRagToolsInputSchema,
    executionMode: 'sequential',
    annotations: { readOnlyHint: false },
    execute: async ({ path }: { path: string }, context) => {
      try {
        return await ingestDocument(
          vectorStore,
          embedFn,
          cwd,
          path,
          context?.signal,
        )
      } catch (e) {
        return `Ingest failed: ${e instanceof Error ? e.message : String(e)}`
      }
    },
  }

  const ragSearchTool: ToolDefinition = {
    name: 'search',
    description:
      'Search the knowledge base for relevant information. Returns the most relevant document chunks.',
    inputSchema: ragSearchToolInputSchema,
    annotations: { readOnlyHint: true },
    execute: async (
      { query, top_k }: { query: string; top_k?: number },
      context,
    ) => {
      if (vectorStore.size() === 0)
        return 'The knowledge base is empty. Ingest documents with rag_ingest first.'
      const results = await vectorStore.hybridSearch(
        (texts) => embedFn(texts, context?.signal),
        query,
        top_k || 5,
      )
      if (results.length === 0) return `No content found for "${query}".`
      return results
        .map(
          (r, i) =>
            `[${i + 1}] Source: ${r.chunk.source} | Score: ${r.score.toFixed(3)} (vector: ${r.vectorScore.toFixed(2)}, keyword: ${r.keywordScore.toFixed(2)})\n${r.chunk.text.slice(0, 500)}`,
        )
        .join('\n\n---\n\n')
    },
  }

  return [ragIngestTool, ragSearchTool]
}
