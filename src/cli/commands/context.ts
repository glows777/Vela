import type { VelaSession } from '../../core.ts'
import { inspectSession } from '../../diagnostics.ts'
import {
  buildContextSnapshot,
  renderContextView,
  renderUsageView,
} from '../context-view.ts'
import type { CommandHandler } from './handler.ts'

export const contextCommands: CommandHandler[] = [
  (cmd, { print, session, vela }) => {
    if (cmd !== '/context') return false
    return (async () => {
      try {
        // Sections are built per prompt: preview the next prompt's sections so memory usage shows even before the first prompt
        const snapshot = await inspectSession(vela, session, {
          previewExtensions: true,
        })
        print(renderContextView(contextSnapshot(session, snapshot)))
      } catch (error) {
        print(
          `[context] Failed: ${error instanceof Error ? error.message : error}`,
        )
      }
    })()
  },

  (cmd, { print, session }) => {
    if (cmd !== '/usage') return false
    print(renderUsageView(session.usage.totals))
    return true
  },
]

/**
 * The memory rules and the skills index are part of the system prompt; they get their own slices, so the System
 * prompt slice is the rest. The memory index itself travels as a message and counts under messages. The autocompact
 * buffer is the window above the summary threshold.
 */
function contextSnapshot(
  session: VelaSession,
  snapshot: Awaited<ReturnType<typeof inspectSession>>,
) {
  const info = session.modelInfo
  const windowTokens = info.contextWindow ?? snapshot.windowTokens
  const memoryChars = snapshot.extensionSections.memory?.length ?? 0
  return buildContextSnapshot({
    modelName: info.provider ? `${info.provider} / ${info.id}` : info.id,
    modelId: info.id,
    windowTokens,
    systemPromptChars: Math.max(
      0,
      snapshot.systemPromptChars - memoryChars - snapshot.skillsChars,
    ),
    toolDescriptionChars: snapshot.toolDescriptionChars,
    memoryChars,
    skillsChars: snapshot.skillsChars,
    messages: session.messages,
    autocompactBufferTokens: Math.max(
      0,
      windowTokens - session.limits.summaryThreshold,
    ),
  })
}
