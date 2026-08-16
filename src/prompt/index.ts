import type { PipeFn } from "./pipelins"

export * from "./pipelins"

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
