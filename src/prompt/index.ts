import type { MemoryStore } from '../memory/store'
import type { SqliteVectorStore } from '../rag/sqllite-store'
import type { PipeFn, PromptContext } from './pipelins'
import type { ToolResultStore } from '../session/tool-results'

export * from './pipelins'

/** 不传 results 时用 PromptContext 里当前会话的工具结果存储。 */
export function toolHistoryGuide(results?: ToolResultStore): PipeFn {
  // No counters/timestamps in the system prefix; only the session's stable path/schema.
  return (ctx) => (results ?? ctx.toolResults)?.readingGuide() ?? null
}

export function coreRules(): PipeFn {
  return () => `You are Vela, a helpful agent that can call tool.
    You have serval built-in tools and mcp tools to use.
    When the tools you need don't list in your tool call list, you can use tool_search tool to search it.
    Answer should be clean and direct.`
}

export function toolGuide(): PipeFn {
  return (ctx) => {
    if (ctx.toolCount === 0) return null
    return null
  }
}

export function sessionContext(): PipeFn {
  // Message counts belong in status output, not the cached system prefix.
  return () => null
}

export function deferredTools(): PipeFn {
  return (ctx) => {
    return ctx.deferredToolSummary
  }
}

export function memoryContext(
  memoryStore: MemoryStore,
): (ctx: PromptContext) => string | null {
  return () => memoryStore.buildPromptSection()
}

export function ragContext(
  vectorStore: SqliteVectorStore,
): (ctx: PromptContext) => string | null {
  return () => {
    const size = vectorStore.size()
    if (size === 0) return null
    const sources = vectorStore.sources()
    return `[知识库] 已导入 ${size} 个文档片段（来源: ${sources.join(', ')}）。使用 rag_search 工具搜索知识库。`
  }
}
