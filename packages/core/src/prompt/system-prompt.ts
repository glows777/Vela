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
  /** The session whose prompt this is (per-session context files and cwd) */
  sessionId: string
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

/** One rendered section: its tag name (the preamble keeps its own name) and the text it contributes. */
export interface RenderedSection {
  name: string
  content: string
}

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
  private readonly hasReplacement: (ctx: PromptContext) => boolean

  constructor(options: {
    /** Replaces the default prompt (pi's customPrompt) */
    systemPrompt?: string
    hasReplacement?: (ctx: PromptContext) => boolean
    sections: readonly PromptSection[]
  }) {
    this.definitions = options.sections
    this.hasReplacement =
      options.hasReplacement ?? (() => options.systemPrompt !== undefined)
  }

  /** Whether the configured `systemPrompt` is in effect (a handler's prompt replaces everything instead). */
  private replaced(ctx: PromptContext): boolean {
    return ctx.systemPromptOverride == null && this.hasReplacement(ctx)
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

  /**
   * The prompt's sections in order, tagged (the preamble plain). Each definition can render several sections
   * (an extension's) and names need not be unique: an extension that uses a built-in name adds its section
   * after the built-in one instead of replacing it.
   */
  sections(ctx: PromptContext): RenderedSection[] {
    return [...this.rendered(ctx)]
  }

  /** What a request carries as its system prompt. */
  build(ctx: PromptContext): string {
    // A handler who returns a prompt decides what the model sees, sections and all
    if (ctx.systemPromptOverride != null) return ctx.systemPromptOverride
    return this.sections(ctx)
      .map((section) => section.content)
      .join('\n\n')
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
