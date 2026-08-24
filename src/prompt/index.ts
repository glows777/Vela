import type { MemoryStore } from '../memory'
import type { VectorStore } from '../rag/store'
import type { PipeFn, PromptContext } from './pipelins'

export * from './pipelins'

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
  return (ctx) => {
    if (ctx.sessionMessageCount === 0) return null
    return `[会话信息] 已有 ${ctx.sessionMessageCount} 条历史消息`
  }
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
  vectorStore: VectorStore,
): (ctx: PromptContext) => string | null {
  return () => {
    const size = vectorStore.size()
    if (size === 0) return null
    const sources = vectorStore.sources()
    return `[知识库] 已导入 ${size} 个文档片段（来源: ${sources.join(', ')}）。使用 rag_search 工具搜索知识库。`
  }
}
