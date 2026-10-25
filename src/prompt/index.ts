import { type ContextFile, renderContextFiles } from './context-files.ts'
import type { PipeFn } from './pipeline.ts'

export * from './pipeline.ts'

/**
 * Core system prompt (same structure as pi: an intro paragraph + <rules>; `<cwd>` is its own section near the end).
 */
export function coreRules(): PipeFn {
  return () => {
    const rules = [
      'Use tools to check facts about files, code, data and the environment instead of guessing.',
      'When a tool you need is not in your tool list, call tool_search to find and load it.',
      'Read a file before you change it. Use edit_file for targeted changes and write_file for new files or full rewrites.',
      'Show file paths clearly when working with files.',
      'Be concise and direct in your responses.',
    ]
    const sections = [
      'You are Vela, an AI agent that helps users by calling the tools this session provides: reading, searching and editing files, running commands, and any extra tools from extensions.',
      `<rules>\n${rules.map((rule) => `- ${rule}`).join('\n')}\n</rules>`,
    ]
    return sections.join('\n\n')
  }
}

/** `<cwd>` (like pi). */
export function workingDirectory(cwd: string): PipeFn {
  return () => `<cwd>\n${cwd.replace(/\\/g, '/')}\n</cwd>`
}

/** Text appended from `--append-system-prompt` / `APPEND_SYSTEM.md` / the SDK's appendSystemPrompt (pi's `<addendum>`). */
export function addendum(text: string | undefined): PipeFn {
  return () => (text ? `<addendum>\n${text}\n</addendum>` : null)
}

/** AGENTS.md / CLAUDE.md files (pi's `<project_context>`). */
export function projectContext(files: readonly ContextFile[]): PipeFn {
  return () => renderContextFiles(files)
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
