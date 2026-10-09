import type { ToolResultStore } from '../session/tool-results.ts'
import type { PipeFn, PromptContext } from './pipeline.ts'

export * from './pipeline.ts'

/** Without results, uses the current session's tool result store from PromptContext. */
export function toolHistoryGuide(results?: ToolResultStore): PipeFn {
  // No counters/timestamps in the system prefix; only the session's stable path/schema.
  return (ctx) => (results ?? ctx.toolResults)?.readingGuide() ?? null
}

/**
 * Core system prompt (same structure as pi: an intro paragraph + <rules> + <cwd>). Guests (external
 * channel users) have no file / shell tools, so they get no file rules and no working directory.
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
    if (cwd && !guest)
      sections.push(`<cwd>\n${cwd.replace(/\\/g, '/')}\n</cwd>`)
    return sections.join('\n\n')
  }
}

export function deferredTools(): PipeFn {
  return (ctx) => {
    return ctx.deferredToolSummary
  }
}

/** Sections written by extensions in before_agent_start, joined in write order */
export function extensionSections(): PipeFn {
  return (ctx) => {
    const sections = Object.values(ctx.extensionSections ?? {}).filter(Boolean)
    return sections.length ? sections.join('\n\n') : null
  }
}
