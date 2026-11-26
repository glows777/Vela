import type { ModelMessage } from '../../driver/index.ts'
import type { RuntimeSessionInspection } from '../../driver/runtime-types.ts'
import {
  buildContextSnapshot,
  renderContextView,
  renderUsageView,
} from '../context-view.ts'
import type { CommandHandler } from './handler.ts'

export const contextCommands: CommandHandler[] = [
  (cmd, { print, session }) => {
    if (cmd !== '/context') return false
    return (async () => {
      try {
        const snap = await session.refresh({ previewPrompt: true })
        print(renderContextView(contextSnapshot(snap)))
      } catch (error) {
        print(
          `[context] Failed: ${error instanceof Error ? error.message : error}`,
        )
      }
    })()
  },

  (cmd, { print, session }) => {
    if (cmd !== '/usage') return false
    return (async () => {
      const snap = await session.refresh()
      print(renderUsageView(snap.usage.totals))
    })()
  },
]

function contextSnapshot(snap: RuntimeSessionInspection) {
  const info = snap.modelInfo
  const preview = snap.promptSnapshot
  if (!info || !preview) {
    throw new Error(snap.modelError ?? 'No model selected')
  }
  const windowTokens = info.contextWindow ?? preview.windowTokens
  const memoryChars = preview.extensionSections.memory?.length ?? 0
  return buildContextSnapshot({
    modelName: info.provider ? `${info.provider} / ${info.id}` : info.id,
    modelId: info.id,
    windowTokens,
    systemPromptChars: Math.max(
      0,
      preview.systemPromptChars - memoryChars - preview.skillsChars,
    ),
    toolDescriptionChars: preview.toolDescriptionChars,
    memoryChars,
    skillsChars: preview.skillsChars,
    messages: snap.branch.flatMap((entry): ModelMessage[] => {
      if (entry.type === 'message') return [entry.message]
      if (entry.type === 'custom_message')
        return [{ role: 'user', content: entry.content }]
      return []
    }),
    autocompactBufferTokens: Math.max(
      0,
      windowTokens - snap.limits.summaryThreshold,
    ),
  })
}
