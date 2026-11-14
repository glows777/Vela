import type { ToolResultStore } from '../session/tool-results.ts'

/**
 * A tool the model can call this turn, as the system prompt reads it: a `ToolDefinition` fits as is. The
 * builder reads the session's active tools, so a tool that is off, not selected or still deferred
 * contributes neither a line in `<tools>` nor a rule.
 */
interface ToolPrompt {
  name: string
  /** One line for `<tools>`; a tool without one is not listed (pi's `promptSnippet`) */
  promptSnippet?: string
  /** Rules for `<rules>` while the tool is active (pi's `promptGuidelines`) */
  promptGuidelines?: readonly string[]
}

export interface PromptContext {
  /** Tools the model can call this turn, in registry order */
  activeTools?: readonly ToolPrompt[]
  /** The registry's deferred tool lines (tools `tool_search` can load); empty when nothing is deferred */
  deferredToolSummary: string
  sessionMessageCount: number
  sessionId: string
  /** Current session's tool result store */
  toolResults?: ToolResultStore
  /** Sections written by extensions in before_agent_start (name → content); fixed within a turn */
  extensionSections?: Readonly<Record<string, string>>
  /** Replaces the default prompt for this turn (a before_agent_start handler's `systemPrompt`); null for none */
  systemPromptOverride?: string | null
}

/**
 * Renders a section's text, several named sections at once (extensions), or nothing. Returned text is
 * wrapped in the section's tag; the `preamble` is the one section that stays plain text.
 */
export type SectionRender = (
  ctx: PromptContext,
) => string | Readonly<Record<string, string>> | null

export interface PromptSection {
  /** The tag: `<name>`; `preamble` is untagged */
  name: string
  /** Left out when a system prompt replaces the default: the preamble becomes it, core sections are dropped */
  core?: boolean
  render: SectionRender
}

/** Section names become XML tags; anything else is made safe before it is written. */
const NAME = /^[A-Za-z][A-Za-z0-9_-]*$/

function tagName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '_')
  return NAME.test(cleaned) ? cleaned : `section_${cleaned}`
}

function tag(name: string, content: string): string {
  return `<${name}>\n${content}\n</${name}>`
}

/**
 * The system prompt, built from ordered, named sections (like pi's `buildSystemPromptSections`): the
 * preamble, then tagged sections, then the sections extensions write in `before_agent_start`.
 *
 * A `systemPrompt` (SYSTEM.md, `--system-prompt`, the SDK) becomes the preamble and leaves out
 * `<tools>`, `<rules>` and `<docs>` (pi's customPrompt). A `before_agent_start` handler's
 * `systemPrompt` replaces the whole prompt for that turn (pi's forced prompt).
 */
export class SystemPromptBuilder {
  private readonly definitions: readonly PromptSection[]
  private readonly replacement?: string

  constructor(options: {
    /** Replaces the default prompt (pi's customPrompt) */
    systemPrompt?: string
    sections: readonly PromptSection[]
  }) {
    this.definitions = options.sections
    this.replacement = options.systemPrompt
  }

  /** Whether the configured `systemPrompt` is in effect (a handler's prompt replaces everything instead). */
  private replaced(ctx: PromptContext): boolean {
    return ctx.systemPromptOverride == null && this.replacement !== undefined
  }

  private *rendered(
    ctx: PromptContext,
  ): Generator<{ name: string; content: string }> {
    const replaced = this.replaced(ctx)
    for (const section of this.definitions) {
      if (replaced && section.core) continue
      const result = section.render(ctx)
      if (!result) continue
      if (typeof result === 'string') {
        yield {
          name: section.name,
          content:
            section.name === 'preamble' ? result : tag(section.name, result),
        }
        continue
      }
      for (const [name, content] of Object.entries(result)) {
        if (!content) continue
        const safe = tagName(name)
        yield { name: safe, content: tag(safe, content) }
      }
    }
  }

  /** The prompt's sections in order, rendered and tagged (the preamble plain); a feed for displays and tests. */
  sections(ctx: PromptContext): Record<string, string> {
    const sections: Record<string, string> = {}
    for (const { name, content } of this.rendered(ctx)) sections[name] = content
    return sections
  }

  /** What a request carries as its system prompt. */
  build(ctx: PromptContext): string {
    // A handler who returns a prompt decides what the model sees, sections and all
    if (ctx.systemPromptOverride != null) return ctx.systemPromptOverride
    return Object.values(this.sections(ctx)).join('\n\n')
  }

  /** Whether each section is on and its rendered length in characters (null means it is off). */
  status(ctx: PromptContext): Array<{ name: string; chars: number | null }> {
    if (ctx.systemPromptOverride != null)
      return [
        { name: 'systemPrompt', chars: ctx.systemPromptOverride.length },
        ...this.definitions.map((section) => ({
          name: section.name,
          chars: null,
        })),
      ]
    const replaced = this.replaced(ctx)
    return this.definitions.flatMap(
      (section): Array<{ name: string; chars: number | null }> => {
        if (replaced && section.core)
          return [{ name: section.name, chars: null }]
        const result = section.render(ctx)
        if (!result) return [{ name: section.name, chars: null }]
        if (typeof result === 'string')
          return [{ name: section.name, chars: result.length }]
        const entries = Object.entries(result).filter(([, content]) => content)
        return entries.length
          ? entries.map(([name, content]) => ({
              name: tagName(name),
              chars: content.length,
            }))
          : [{ name: section.name, chars: null }]
      },
    )
  }
}
