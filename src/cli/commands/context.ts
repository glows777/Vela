import {
  buildContextSnapshot,
  renderContextView,
  renderUsageView,
} from '../../context/view.ts'
import type { VelaSession } from '../../vela-session.ts'
import type { CommandHandler } from './index.ts'

export const contextCommands: CommandHandler[] = [
  (cmd, { print, session }) => {
    if (cmd !== '/context' && cmd !== 'context') return false
    return (async () => {
      try {
        // Sections are built per prompt: preview the next prompt's sections so memory usage shows even before the first prompt
        const sections = await session.previewSections()
        print(renderContextView(contextSnapshot(session, sections)))
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

function contextSnapshot(
  session: VelaSession,
  sections: Record<string, string>,
) {
  const info = session.modelInfo
  return buildContextSnapshot({
    modelName: info.provider ? `${info.provider} / ${info.id}` : info.id,
    modelId: info.id,
    windowTokens: info.contextWindow ?? session.tracker.contextWindow,
    systemPromptChars: session.buildSystem(sections).length,
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
    memoryChars: sections.memory?.length ?? 0,
    skillsChars: 0,
    messages: session.messages,
  })
}
