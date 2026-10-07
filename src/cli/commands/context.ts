import {
  buildContextSnapshot,
  renderContextView,
  renderUsageView,
} from '../../context/view'
import type { CommandHandler } from './index'

export const contextCommands: CommandHandler[] = [
  (cmd, { vela, session }) => {
    if (cmd !== '/context' && cmd !== 'context') return false
    const SYSTEM = session.buildSystem()
    // memory 扩展在上一轮 prompt 开始时写入的记忆段落
    const memoryChars =
      session.promptContext().extensionSections?.memory?.length ?? 0
    const model = vela.model
    const modelId = typeof model === 'string' ? model : model.modelId
    const provider = typeof model === 'string' ? '' : model.provider
    const snapshot = buildContextSnapshot({
      modelName: provider ? `${provider} / ${modelId}` : modelId,
      modelId,
      // 窗口大小等第 4 步的模型配置再按模型给出
      windowTokens: 1_000_000,
      systemPromptChars: SYSTEM.length,
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
      skillsChars: 0,
      messages: session.messages,
    })
    console.log(renderContextView(snapshot))
    return true
  },

  (cmd, { session }) => {
    if (cmd !== '/usage' && cmd !== 'usage') return false
    console.log(renderUsageView(session.tracker))
    return true
  },
]
