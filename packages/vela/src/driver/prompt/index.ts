import { existsSync } from 'node:fs'
import type { DocsPaths } from '../../shared/docs-paths.ts'
import { type ContextFile, renderContextFiles } from './context-files.ts'
import type { PromptContext, SectionRender } from './system-prompt.ts'

export * from './environment.ts'
export * from './system-prompt.ts'
export type { DocsPaths }

/**
 * The default intro paragraph (pi's preamble). It names no capability: a session's tools vary, and
 * `<tools>` and `<rules>` describe the ones it can actually call.
 */
const PREAMBLE =
  'You are Vela, an AI agent that helps users by calling the tools this session provides.'

/**
 * The untagged first section: the default intro, or the prompt that replaces it (SYSTEM.md,
 * `--system-prompt`, the SDK's `systemPrompt`, or a before_agent_start handler).
 */
export function preamble(systemPrompt?: string): SectionRender {
  return (ctx) => ctx.systemPromptOverride ?? systemPrompt ?? PREAMBLE
}

/** `<tools>`: one line per active tool that has a `promptSnippet`, like pi. */
export function toolList(): SectionRender {
  return (ctx) => {
    const lines = (ctx.activeTools ?? [])
      .filter((tool) => tool.exposure !== 'deferred' && tool.promptSnippet)
      .map((tool) => `- ${tool.name}: ${tool.promptSnippet}`)
    return lines.length ? lines.join('\n') : '(none)'
  }
}

/** `<deferred_tools>`: what `tool_search` can load (the deferred tool lines from the registry). */
export function deferredTools(): SectionRender {
  return (ctx) => {
    if (!ctx.deferredToolSummary) return null
    // Without tool_search the model cannot load them, so the list would only describe an unreachable tool
    if (!(ctx.activeTools ?? []).some((tool) => tool.name === 'tool_search'))
      return null
    return [
      'These tools are available but not loaded. Call tool_search with keywords or tool names to load the ones you need:',
      ctx.deferredToolSummary,
    ].join('\n')
  }
}

/** The first rule; the tool guidelines follow it, then the rest of the standing rules. */
const FACTS_RULE =
  'Use tools to check facts about files, code, data and the environment instead of guessing.'

/** Rules that hold in every session; tool-specific ones come from the active tools. */
const STANDING_RULES: readonly string[] = [
  'Show file paths clearly when working with files.',
  'Lead with the answer or result; no preamble, and no closing summary unless asked.',
  "Keep responses concise and proportional to the task: focus on what matters, include concrete details or file paths when helpful, and don't close by restating the answer.",
  "Don't restate the request or repeat what was already said; point back to it in one line if needed.",
  "Don't add unrequested suggestions or next steps unless they matter.",
  "Don't state unchecked things as fact. Say plainly when something failed, can't be done or is uncertain, and say something was saved, sent or done only after the tool call for it succeeded.",
]

/**
 * `<rules>`: what the active tools say about themselves (pi's `promptGuidelines`), then the standing
 * rules. A rule is only written for a tool the model can actually call.
 */
export function rules(): SectionRender {
  return (ctx) => {
    const lines: string[] = []
    const seen = new Set<string>()
    const add = (rule: string) => {
      const text = rule.trim()
      if (!text || seen.has(text)) return
      seen.add(text)
      lines.push(`- ${text}`)
    }
    add(FACTS_RULE)
    for (const tool of ctx.activeTools ?? []) {
      if (tool.exposure === 'deferred') continue
      for (const guideline of tool.promptGuidelines ?? []) add(guideline)
    }
    for (const rule of STANDING_RULES) add(rule)
    return lines.join('\n')
  }
}

/**
 * The folders to point `<docs>` at, keeping only those that exist. Without a `docs` folder there is
 * nothing to read, so the section stays off (a source checkout that was never built has no docs).
 */
export function resolveDocs(
  paths: DocsPaths | false | undefined,
): DocsPaths | undefined {
  if (typeof paths !== 'object' || !paths.docs) return undefined
  if (!existsSync(paths.docs)) return undefined
  return {
    ...(paths.readme && existsSync(paths.readme)
      ? { readme: paths.readme }
      : {}),
    docs: paths.docs,
    ...(paths.examples && existsSync(paths.examples)
      ? { examples: paths.examples }
      : {}),
  }
}

/**
 * `<docs>` (pi's docs section): where Vela's own documentation lives. It is read only when the user asks
 * about Vela itself, so naming the paths costs a few lines and no tool calls.
 */
export function docs(paths: DocsPaths | undefined): SectionRender {
  return paths
    ? () =>
        [
          "Vela's own documentation (read only when the user asks about the harness itself, its SDK, extensions, tools, settings or CLI):",
          ...(paths.readme ? [`- Main documentation: ${paths.readme}`] : []),
          `- Additional docs: ${paths.docs}`,
          ...(paths.examples
            ? [`- Examples: ${paths.examples} (extensions, SDK usage)`]
            : []),
          '- Resolve docs/... under Additional docs and examples/... under Examples, not the current working directory',
          '- Before changing Vela itself, read the relevant docs in full and follow their cross-references',
        ].join('\n')
    : () => null
}

/** Text appended from `--append-system-prompt` / `APPEND_SYSTEM.md` / the SDK's appendSystemPrompt (pi's `<addendum>`). */
export function addendum(text: string | undefined): SectionRender {
  return () => text || null
}

/** AGENTS.md / CLAUDE.md files (pi's `<project_context>`). */
export function projectContext(files: readonly ContextFile[]): SectionRender {
  return () => renderContextFiles(files)
}

/** `<cwd>` (like pi). */
export function workingDirectory(cwd: string): SectionRender {
  return () => cwd.replace(/\\/g, '/')
}

/** Sections written by extensions in before_agent_start, each under its own tag (memory → `<memory>`). */
export function extensionSections(): SectionRender {
  return (ctx: PromptContext) => ctx.extensionSections ?? null
}
