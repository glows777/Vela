import type { Role } from '../security/roles.ts'
import type { ToolResultStore } from '../session/tool-results.ts'

export interface PromptContext {
  toolCount: number
  deferredToolSummary: string
  sessionMessageCount: number
  sessionId: string
  /** Current session's tool result store (used by toolHistoryGuide) */
  toolResults?: ToolResultStore
  /** Names of the tools the model can call this turn (the skills index needs read_file or bash) */
  activeTools?: readonly string[]
  /** Current session's role; defaults to owner */
  role?: Role
  /** Sections written by extensions in before_agent_start (name → content); fixed within a turn */
  extensionSections?: Readonly<Record<string, string>>
}

export type PipeFn = (ctx: PromptContext) => string | null

export class PromptPipeline {
  private pipeLines: Array<{ name: string; fn: PipeFn }> = []

  pipe(name: string, fn: PipeFn) {
    this.pipeLines.push({ name, fn })
    return this
  }

  build(ctx: PromptContext) {
    const prompts: string[] = []

    for (const { fn } of this.pipeLines) {
      const prompt = fn(ctx)
      if (prompt !== null) {
        prompts.push(prompt)
      }
    }

    return prompts.join('\n\n')
  }

  /** Whether each section is enabled and its length in chars (null means the section is off). */
  status(ctx: PromptContext): Array<{ name: string; chars: number | null }> {
    return this.pipeLines.map(({ name, fn }) => {
      const result = fn(ctx)
      return { name, chars: result === null ? null : result.length }
    })
  }
}
