import {
  buildContextSnapshot,
  renderContextView,
  renderUsageView,
} from '../../context/view'
import type { VelaSession } from '../../vela-session'
import type { CommandHandler } from './index'

export const contextCommands: CommandHandler[] = [
  (cmd, { print, session }) => {
    if (cmd !== '/context' && cmd !== 'context') return false
    return (async () => {
      try {
        // 段落每次 prompt 才算：预览下一次 prompt 的段落，没 prompt 过时也能看到记忆占用
        const sections = await session.previewSections()
        print(renderContextView(contextSnapshot(session, sections)))
      } catch (error) {
        print(`[context] 失败: ${error instanceof Error ? error.message : error}`)
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
