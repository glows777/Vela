import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { VelaExtension } from '../../index.ts'
import { createEmbedder, type EmbeddingFn } from './embedder.ts'
import { SqliteVectorStore } from './sqlite-store.ts'
import { createRagTools, ingestDocument } from './tools.ts'

export interface RagOptions {
  /**
   * Text embedding function, e.g. `createEmbedder({ apiKey })`; in tests, createFauxEmbedder() from vela/testing.
   * When omitted, one is created from the config section `embedding: { baseUrl, model, apiKey }`
   * (an OpenAI-compatible embedding API).
   */
  embedder?: EmbeddingFn
}

/**
 * Local knowledge base (`<dataDir>/rag/knowledge.db`): the `rag_ingest` / `rag_search` tools, a knowledge
 * base summary in the system prompt, and the `/rag [ingest <path>]` command. Guest sessions can also use rag_search.
 * Registers nothing when there is neither an embedder nor an `embedding` config.
 */
export function rag(options: RagOptions = {}): VelaExtension {
  return function rag(vela) {
    const embedder = options.embedder ?? embedderFromConfig(vela.config)
    if (!embedder) {
      vela.logger.info(
        '[rag] embedding (baseUrl / model / apiKey) not configured; knowledge base disabled',
      )
      return
    }
    const dir = join(vela.dataDir, 'rag')
    mkdirSync(dir, { recursive: true })
    const store = new SqliteVectorStore(join(dir, 'knowledge.db'))
    for (const tool of createRagTools(store, embedder, vela.cwd))
      vela.registerTool(tool)

    vela.on('before_agent_start', (event) => {
      const size = store.size()
      if (size === 0) return
      event.sections.rag = `[knowledge base] ${size} document chunks ingested (sources: ${store.sources().join(', ')}). Use the rag_search tool to search the knowledge base.`
    })

    vela.registerCommand('rag', {
      description:
        'Show the knowledge base; /rag ingest <path> to ingest a document',
      handler: async (args, ctx) => {
        if (args.startsWith('ingest ')) {
          const path = args.slice('ingest '.length).trim()
          ctx.ui.notify(`[ingest] Processing ${path}...`)
          try {
            ctx.ui.notify(
              await ingestDocument(store, embedder, vela.cwd, path, ctx.signal),
            )
          } catch (error) {
            ctx.ui.notify(
              `[ingest] Stopped: ${error instanceof Error ? error.message : String(error)}`,
              'error',
            )
          }
          return
        }
        const sources = store.sources()
        ctx.ui.notify(
          `[knowledge base] ${store.size()} chunks${sources.length ? `\n  Sources: ${sources.join(', ')}` : ''}`,
        )
      },
    })
  }
}

function embedderFromConfig(
  config: Readonly<Record<string, unknown>>,
): EmbeddingFn | undefined {
  const embedding = config.embedding as Record<string, unknown> | undefined
  const { baseUrl, model, apiKey } = embedding ?? {}
  if (
    typeof baseUrl === 'string' &&
    baseUrl &&
    typeof model === 'string' &&
    model &&
    typeof apiKey === 'string' &&
    apiKey
  )
    return createEmbedder({ url: baseUrl, modelId: model, apiKey })
}
