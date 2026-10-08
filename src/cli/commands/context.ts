import {
  buildContextSnapshot,
  renderContextView,
  renderUsageView,
} from '../../context/view.ts'
import type { VelaSession } from '../../vela-session.ts'
import type { CommandHandler } from './index.ts'

export const contextCommands: CommandHandler[] = [
  (cmd, { print, session, internals }) => {
    if (cmd !== '/context' && cmd !== 'context') return false
    return (async () => {
      try {
        // Sections are built per prompt: preview the next prompt's sections so memory usage shows even before the first prompt
        const sections = await session.previewSections()
        const skills =
          internals.skillLoader.buildPromptSection(session.activeSkills) ?? ''
        print(renderContextView(contextSnapshot(session, sections, skills)))
      } catch (error) {
        print(`[context] Failed: ${error instanceof Error ? error.message : error}`)
      }
    })()
  },

  (cmd, { print, session }) => {
    if (cmd !== '/usage' && cmd !== 'usage') return false
    print(renderUsageView(session.tracker))
    return true
  },
]

/**
 * The memory section and the skills index are part of the system prompt; they get their own slices, so the
 * System prompt slice is the rest. The autocompact buffer is the window above the summary threshold.
 */
function contextSnapshot(
  session: VelaSession,
  sections: Record<string, string>,
  skills: string,
) {
  const info = session.modelInfo
  const windowTokens = info.contextWindow ?? session.tracker.contextWindow
  const memoryChars = sections.memory?.length ?? 0
  return buildContextSnapshot({
    modelName: info.provider ? `${info.provider} / ${info.id}` : info.id,
    modelId: info.id,
    windowTokens,
    systemPromptChars: Math.max(
      0,
      session.buildSystem(sections).length - memoryChars - skills.length,
    ),
    toolDescriptionChars: session.registry
      .getActiveTools()
      .reduce(
        (a, t) =>
          a +
          t.name.length +
          (t.description?.length || 0) +
          JSON.stringify(t.inputSchema || {}).length,
        0,
      ),
    memoryChars,
    skillsChars: skills.length,
    messages: session.messages,
    autocompactBufferTokens: Math.max(
      0,
      windowTokens - session.limits.summaryThreshold,
    ),
  })
}
