import { join } from 'node:path'
import type { VelaExtension } from '../../index'
import type { EmbeddingFn } from './embedder'
import { SqliteVectorStore } from './sqllite-store'
import { createRagTools, ingestDocument } from './tools'

export interface RagOptions {
  /** 文本向量化函数，例如 `createEmbedder({ apiKey })`；测试用 vela/testing 的 createFauxEmbedder() */
  embedder: EmbeddingFn
}

/**
 * 本地知识库（`<dataDir>/knowledge.db`）：`rag_ingest` / `rag_search` 工具，system prompt 里的知识库概况，
 * 以及 `/rag [ingest <路径>]` 命令。guest 会话也能用 rag_search 检索。
 */
export function rag(options: RagOptions): VelaExtension {
  return function rag(vela) {
    const { embedder } = options
    const store = new SqliteVectorStore(join(vela.dataDir, 'knowledge.db'))
    for (const tool of createRagTools(store, embedder, vela.cwd))
      vela.registerTool(tool)

    vela.on('before_agent_start', (event) => {
      const size = store.size()
      if (size === 0) return
      event.sections.rag = `[知识库] 已导入 ${size} 个文档片段（来源: ${store.sources().join(', ')}）。使用 rag_search 工具搜索知识库。`
    })

    vela.registerCommand('rag', {
      description: '查看知识库；/rag ingest <路径> 导入文档',
      handler: async (args, ctx) => {
        if (args.startsWith('ingest ')) {
          const path = args.slice('ingest '.length).trim()
          ctx.ui.notify(`[导入] 正在处理 ${path}...`)
          try {
            ctx.ui.notify(
              await ingestDocument(store, embedder, vela.cwd, path, ctx.signal),
            )
          } catch (error) {
            ctx.ui.notify(
              `[导入] 已停止: ${error instanceof Error ? error.message : String(error)}`,
              'error',
            )
          }
          return
        }
        const sources = store.sources()
        ctx.ui.notify(
          `[知识库] ${store.size()} 个片段${sources.length ? `\n  来源: ${sources.join(', ')}` : ''}`,
        )
      },
    })
  }
}
