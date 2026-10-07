import type { PipeFn, PromptContext } from './pipelins.ts'
import type { ToolResultStore } from '../session/tool-results.ts'

export * from './pipelins.ts'

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

/** 扩展在 before_agent_start 里写的段落，按写入顺序拼接 */
export function extensionSections(): PipeFn {
  return (ctx) => {
    const sections = Object.values(ctx.extensionSections ?? {}).filter(Boolean)
    return sections.length ? sections.join('\n\n') : null
  }
}
