import {
  buildContextSnapshot,
  renderContextView,
  renderUsageView,
} from '../../context/view'
import type { Vela } from '../../vela'
import type { VelaSession } from '../../vela-session'
import type { CommandHandler } from './index'

export const contextCommands: CommandHandler[] = [
  (cmd, { vela, session, ask }) => {
    if (cmd !== '/context' && cmd !== 'context') return false
    void (async () => {
      try {
        // 段落每次 prompt 才算：预览下一次 prompt 的段落，没 prompt 过时也能看到记忆占用
        const sections = await session.previewSections()
        console.log(renderContextView(contextSnapshot(vela, session, sections)))
      } catch (error) {
        console.error('[context] 失败:', error)
      } finally {
        ask()
      }
    })()
    return 'async'
  },

  (cmd, { session }) => {
    if (cmd !== '/usage' && cmd !== 'usage') return false
    console.log(renderUsageView(session.tracker))
    return true
  },
]

function contextSnapshot(
  vela: Vela,
  session: VelaSession,
  sections: Record<string, string>,
) {
  const model = vela.model
  const modelId = typeof model === 'string' ? model : model.modelId
  const provider = typeof model === 'string' ? '' : model.provider
  return buildContextSnapshot({
    modelName: provider ? `${provider} / ${modelId}` : modelId,
    modelId,
    // 窗口大小等第 4 步的模型配置再按模型给出
    windowTokens: 1_000_000,
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
