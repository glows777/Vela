import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ExtensionConfigDefinition,
  VelaExtension,
  VelaSession,
} from '../../extension-api.ts'
import {
  customMessageIfChanged,
  customMessageMissing,
  lastCustomMessage,
} from '../../extension-api.ts'
import { createEmbedder, type EmbeddingFn } from './embedder.ts'
import { SqliteVectorStore } from './sqlite-store.ts'
import { createRagTools, ingestDocument } from './tools.ts'

export interface RagOptions {
  /**
   * Text embedding function, e.g. `createEmbedder({ apiKey })`; in tests, createFauxEmbedder() from vela/testing.
   * When omitted, one is created from the config section `embedding: { baseUrl, model, apiKey }`
   * (an OpenAI-compatible embedding API). The knowledge base records the embedder's `id` and refuses
   * vectors from another one; a function without `id` is recorded as `custom`.
   */
  embedder?: EmbeddingFn
}

/**
 * Local knowledge base (`<dataDir>/rag/knowledge.db`): the `rag_ingest` / `rag_search` tools, a knowledge
 * base summary as a message after the user message, and the `/rag [ingest <path>]` command.
 * Without an embedder or `embedding` config, registers only /rag to explain how to configure it.
 */
export function rag(options: RagOptions = {}): VelaExtension {
  return function rag(vela) {
    const embedding = embeddingConfig(vela.config)
    const embedder =
      options.embedder ?? (embedding && createEmbedder(embedding))
    if (!embedder) {
      vela.registerCommand('rag', {
        description: 'Explain how to configure the knowledge base',
        handler: (_args, ctx) => {
          ctx.ui.notify(
            'Knowledge base disabled: embedding is not configured.\nCLI: set extensionConfig.rag.embedding with baseUrl, model and apiKey in ~/.vela/settings.json (or $VELA_DIR/settings.json), or set EMBEDDING_MODEL_BASE_URL, EMBEDDING_MODEL and EMBEDDING_MODEL_KEY.\nSDK: pass rag({ embedder }) or set extensionConfig.rag.embedding in createVela().',
          )
        },
      })
      return
    }
    const dir = join(vela.dataDir, 'rag')
    mkdirSync(dir, { recursive: true })
    const store = new SqliteVectorStore(join(dir, 'knowledge.db'), {
      embedder: embedder.id,
    })
    // Session shutdown drains running tools and commands before shared resources close.
    vela.onShutdown(() => store.close())
    if (store.assumedEmbedder)
      vela.logger.warn(
        `[rag] The knowledge base has no record of the embedder that built it (it predates Vela 0.2.0); assuming the configured one, "${store.embedder}". If it was built with another model, run /rag clear and ingest the documents again.`,
      )
    for (const tool of createRagTools(store, embedder, vela.cwd))
      vela.registerTool(tool)

    const contentFor = (session: VelaSession): string | null => {
      const size = store.size()
      const summary =
        size === 0
          ? null
          : `[knowledge base] ${size} document chunks ingested (sources: ${store.sources().join(', ')}). Use the rag_search tool to search the knowledge base.`
      // Clearing the knowledge base must replace the old summary; a session that never had one stays quiet
      return (
        summary ||
        (lastCustomMessage(session, 'rag')
          ? '[knowledge base] The knowledge base is empty. Ingest documents with rag_ingest first.'
          : null)
      )
    }

    /** Sessions whose context carried a summary when the prompt started: only those can lose one to compaction. */
    const summarized = new WeakSet<VelaSession>()

    vela.on('before_agent_start', (_event, ctx) => {
      const content = contentFor(ctx.session)
      const message = content
        ? customMessageIfChanged(ctx.session, 'rag', content)
        : undefined
      if (message || lastCustomMessage(ctx.session, 'rag'))
        summarized.add(ctx.session)
      else summarized.delete(ctx.session)
      return message ? { message } : undefined
    })

    // Automatic compaction can drop that message after the check above and before this request goes out
    vela.on('context', (event, ctx) => {
      if (!summarized.has(ctx.session)) return
      if (!customMessageMissing(event.messages, ['[knowledge base]'])) return
      const content = contentFor(ctx.session)
      if (content) event.messages.push({ role: 'user', content })
    })

    vela.registerCommand('rag', {
      description:
        'Show the knowledge base; /rag ingest <path> to ingest a document, /rag clear to empty it',
      handler: async (args, ctx) => {
        if (args.trim() === 'clear') {
          const size = store.size()
          store.clear()
          ctx.ui.notify(
            `[knowledge base] Deleted ${size} chunks; new documents are embedded with "${store.embedder}"`,
          )
          return
        }
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
        const stored = store.storedEmbedder()
        const embedderLine =
          stored === store.embedder
            ? `Embedder: ${stored}`
            : `Embedder: ${stored}, but the configured embedder is ${store.embedder}: run /rag clear and ingest again, or switch back`
        ctx.ui.notify(
          `[knowledge base] ${store.size()} chunks${sources.length ? `\n  Sources: ${sources.join(', ')}` : ''}\n  ${embedderLine}`,
          stored === store.embedder ? undefined : 'error',
        )
      },
    })
  }
}

function embeddingConfig(config: Readonly<Record<string, unknown>>) {
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
    return { url: baseUrl, modelId: model, apiKey }
}

export const ragConfig: ExtensionConfigDefinition = {
  name: 'rag',
  resolve(section, context) {
    const defaults = {
      baseUrl: context.env.EMBEDDING_MODEL_BASE_URL,
      model: context.env.EMBEDDING_MODEL,
      apiKey: context.env.EMBEDDING_MODEL_KEY,
    }
    const embedding = section.embedding
    return {
      embedding: defaults,
      ...section,
      ...(embedding &&
      typeof embedding === 'object' &&
      !Array.isArray(embedding)
        ? { embedding: { ...defaults, ...embedding } }
        : {}),
    }
  },
}
