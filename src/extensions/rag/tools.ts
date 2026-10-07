import { resolve } from 'node:path'
import z from 'zod'
import type { ToolDefinition } from '../../index'
import { chunkDocument } from './chunker'
import { type EmbeddingFn, embed } from './embedder'
import type { SqliteVectorStore } from './sqllite-store'

export const createRagToolsInputSchema = z.object({
  path: z.string().describe('文档路径'),
})

export const ragSearchToolInputSchema = z.object({
  query: z.string().describe('搜索查询'),
  top_k: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe('返回结果数量（默认 5）'),
})

/** 把一个文档分块、向量化后存进知识库；相对路径按 cwd 解析（和文件工具一致）。返回给人看的结果。 */
export async function ingestDocument(
  vectorStore: SqliteVectorStore,
  embedFn: EmbeddingFn,
  cwd: string,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const text = await Bun.file(resolve(cwd, path)).text()
  const chunks = chunkDocument(path, text)
  const embeddings = await embed(
    embedFn,
    chunks.map((c) => c.text),
    signal,
  )
  vectorStore.addBatch(
    chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i]! })),
  )
  return `已导入 ${chunks.length} 个文档片段（来源: ${path}）。知识库共 ${vectorStore.size()} 个片段。`
}

/** rag 扩展的工具：模型看到的名字是 rag_ingest / rag_search。 */
export function createRagTools(
  vectorStore: SqliteVectorStore,
  embedFn: EmbeddingFn,
  cwd: string,
): ToolDefinition[] {
  const ragIngestTool: ToolDefinition = {
    name: 'ingest',
    description:
      '将文档导入知识库。path 为文件路径，内容会被分块、向量化后存储。',
    inputSchema: createRagToolsInputSchema,
    isConcurrencySafe: false,
    isReadOnly: false,
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
        return `导入失败: ${e instanceof Error ? e.message : String(e)}`
      }
    },
  }

  const ragSearchTool: ToolDefinition = {
    name: 'search',
    description: '从知识库中搜索相关信息。返回最相关的文档片段。',
    inputSchema: ragSearchToolInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async (
      { query, top_k }: { query: string; top_k?: number },
      context,
    ) => {
      if (vectorStore.size() === 0)
        return '知识库为空，请先使用 rag_ingest 导入文档。'
      const results = await vectorStore.hybridSearch(
        (texts) => embedFn(texts, context?.signal),
        query,
        top_k || 5,
      )
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
