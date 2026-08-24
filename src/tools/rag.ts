import fs from 'node:fs'
import z from 'zod'
import { chunkDocument } from '../rag/chunker'
import { type EmbeddingFn, embed } from '../rag/embedder'
import type { SqliteVectorStore } from '../rag/sqllite-store'
import type { ToolDefinition } from './registry'

export const createRagToolsInputSchema = z.object({
  path: z.string().describe('文档路径'),
})

export const ragSearchToolInputSchema = z.object({
  query: z.string().describe('搜索查询'),
  top_k: z.string().optional().describe('返回结果数量（默认 5）'),
})

export function createRagTools(
  vectorStore: SqliteVectorStore,
  embedFn: EmbeddingFn,
): ToolDefinition[] {
  const ragIngestTool: ToolDefinition = {
    name: 'rag_ingest',
    description:
      '将文档导入知识库。path 为文件路径，内容会被分块、向量化后存储。',
    inputSchema: createRagToolsInputSchema,
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async ({ path }: { path: string }) => {
      try {
        const text = fs.readFileSync(path, 'utf-8')
        const chunks = chunkDocument(path, text)
        const embeddings = await embed(
          embedFn,
          chunks.map((c) => c.text),
        )
        vectorStore.addBatch(
          chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i]! })),
        )
        return `已导入 ${chunks.length} 个文档片段（来源: ${path}）。知识库共 ${vectorStore.size()} 个片段。`
      } catch (e: any) {
        return `导入失败: ${e.message}`
      }
    },
  }

  const ragSearchTool: ToolDefinition = {
    name: 'rag_search',
    description: '从知识库中搜索相关信息。返回最相关的文档片段。',
    inputSchema: ragSearchToolInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ query, top_k }: { query: string; top_k?: number }) => {
      if (vectorStore.size() === 0)
        return '知识库为空，请先使用 rag_ingest 导入文档。'
      const results = await vectorStore.hybridSearch(embedFn, query, top_k || 5)
      if (results.length === 0) return `没有找到与 "${query}" 相关的内容。`
      return results
        .map(
          (r, i) =>
            `[${i + 1}] 来源: ${r.chunk.source} | 综合分: ${r.score.toFixed(3)} (向量: ${r.vectorScore.toFixed(2)}, 关键词: ${r.keywordScore.toFixed(2)})\n${r.chunk.text.slice(0, 500)}`,
        )
        .join('\n\n---\n\n')
    },
  }

  return [ragIngestTool, ragSearchTool]
}
