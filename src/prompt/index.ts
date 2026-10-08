import type { PipeFn, PromptContext } from './pipeline.ts'
import type { ToolResultStore } from '../session/tool-results.ts'

export * from './pipeline.ts'

/** 不传 results 时用 PromptContext 里当前会话的工具结果存储。 */
export function toolHistoryGuide(results?: ToolResultStore): PipeFn {
  // No counters/timestamps in the system prefix; only the session's stable path/schema.
  return (ctx) => (results ?? ctx.toolResults)?.readingGuide() ?? null
}

/**
 * 核心 system prompt（结构同 pi：开场一段 + <rules> + <cwd>）。guest（通道外部用户）没有文件 / shell
 * 工具，不给文件相关规则，也不暴露工作目录。
 */
export function coreRules(cwd?: string): PipeFn {
  return (ctx) => {
    const guest = ctx.role === 'guest'
    const rules = [
      'Use tools to check facts about files, code, data and the environment instead of guessing.',
      'When a tool you need is not in your tool list, call tool_search to find and load it.',
      ...(guest
        ? []
        : [
            'Read a file before you change it. Use edit_file for targeted changes and write_file for new files or full rewrites.',
            'Show file paths clearly when working with files.',
          ]),
      'Be concise and direct in your responses.',
    ]
    const sections = [
      guest
        ? 'You are Vela, an AI assistant that answers questions and uses the tools available to it.'
        : 'You are Vela, an AI agent that helps users by calling the tools this session provides: reading, searching and editing files, running commands, and any extra tools from extensions.',
      `<rules>\n${rules.map((rule) => `- ${rule}`).join('\n')}\n</rules>`,
    ]
    if (cwd && !guest) sections.push(`<cwd>\n${cwd.replace(/\\/g, '/')}\n</cwd>`)
    return sections.join('\n\n')
  }
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
