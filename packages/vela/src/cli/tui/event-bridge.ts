import {
  branchSummaryMessageText,
  contextEntries,
  isToolResultError,
  summaryMessageText,
} from '../../driver/diagnostics.ts'
import {
  failureHint,
  type ModelMessage,
  type SessionEntry,
} from '../../driver/index.ts'
import type { RuntimeEvent, StreamDeltaEvent } from '../../runtime/events.ts'
import type { ChatLog } from './chat-log.ts'
import { errorMessage, oneLine, sanitize } from './components.ts'
import type { StatusLine } from './status-line.ts'

export interface InteractiveEventHost {
  readonly log: ChatLog
  readonly statusLine: StatusLine
  readonly requestRender: () => void
  addNotice(text: string, level?: 'info' | 'warning' | 'error' | 'dim'): void
  setShownError(error: string | undefined): void
  movePendingBash(): void
  onRunFinished(): void
}

/**
 * Renders an active session branch's history into the `ChatLog` on resume, fork, or tree navigation.
 */
export function renderSessionBranchHistory(
  log: ChatLog,
  branch: SessionEntry[],
): void {
  const { compaction, entries: shown } = contextEntries(branch)
  if (compaction) {
    log.renderMessage(
      {
        role: 'user',
        content: summaryMessageText(compaction.summary),
      },
      true,
    )
  }
  for (const entry of shown) {
    if (entry.type === 'bash_execution') {
      log.endTurn()
      log.addBash(entry.command, !!entry.excludeFromContext).setResult(entry)
      continue
    }
    if (entry.type === 'branch_summary') {
      if (entry.summary) {
        log.renderMessage(
          {
            role: 'user',
            content: branchSummaryMessageText(entry.summary),
          },
          true,
        )
      }
      continue
    }
    if (entry.type === 'custom_message') {
      log.renderMessage({ role: 'user', content: entry.content }, true, {
        customType: entry.customType,
        display: entry.display,
      })
      continue
    }
    if (entry.type !== 'message' || entry.stopReason) continue
    const { message } = entry
    if (message.role !== 'tool') log.renderMessage(message, true)
    if (message.role === 'user' || typeof message.content === 'string') {
      continue
    }
    for (const part of message.content) {
      if (part.type !== 'tool_result') continue
      const block = log.tool(part.toolCallId)
      if (!block) continue
      log.settleTool(
        block,
        part.output,
        isToolResultError(part.output),
        entry.details?.[part.toolCallId],
      )
    }
  }
  log.endTurn()
}

/** Handles one v0.9 `RuntimeEvent` for the active TUI session. */
export function handleRuntimeEventForTui(
  host: InteractiveEventHost,
  event: RuntimeEvent,
  activeSessionId: string,
): void {
  if (event.sessionId !== activeSessionId) return
  switch (event.type) {
    case 'run_started':
      host.log.endTurn()
      host.setShownError(undefined)
      host.statusLine.start('Thinking…')
      break
    case 'message_committed': {
      const msg = event.message as ModelMessage
      if (msg.role === 'user') {
        const custom = event.customType
          ? { customType: event.customType, display: event.display === true }
          : undefined
        host.log.renderMessage(msg, false, custom)
      } else if (msg.role === 'assistant') {
        host.log.nextMessage()
      }
      break
    }
    case 'tool_started':
      if (!host.log.hasTool(event.toolCallId)) {
        host.log.addTool(event.toolCallId, event.toolName, event.input)
      }
      host.log.startTool(event.toolCallId)
      host.statusLine.set(`Running ${event.toolName}…`)
      break
    case 'tool_finished':
      host.log.settleTool(
        host.log.tool(event.toolCallId),
        event.result,
        event.isError,
        event.details,
        event.durationMs,
      )
      break
    case 'auto_retry_start':
      host.log.markFailed()
      host.statusLine.retry(
        `Request failed, retrying in ${Math.round(event.delayMs / 1000)}s (${event.attempt}/${event.maxAttempts}): ${sanitize(oneLine(event.errorMessage))}`,
        event.delayMs,
      )
      break
    case 'auto_retry_end':
      if (!event.success && event.finalError) {
        host.addNotice(
          `Retry failed: ${errorMessage(event.finalError)}`,
          'error',
        )
      }
      break
    case 'compaction_started':
      host.statusLine.set('Compacting context…')
      break
    case 'compaction_finished': {
      host.statusLine.set('Thinking…')
      const label =
        event.reason === 'threshold'
          ? `[context] Summarized ${event.tokensBefore} → ${event.tokensAfter} tokens`
          : event.reason === 'manual'
            ? `[context] Manually compacted ${event.tokensBefore} → ${event.tokensAfter} tokens`
            : `[context] The model said the context is too long; summarized ${event.tokensBefore} → ${event.tokensAfter} tokens and retrying`
      host.addNotice(label, 'dim')
      break
    }
    case 'compaction_failed':
      host.statusLine.set('Thinking…')
      if (event.errorMessage) {
        host.addNotice(
          `[context] Compaction failed: ${event.errorMessage}`,
          'error',
        )
      }
      break
    case 'notify':
      host.addNotice(event.message, event.level)
      break
    case 'run_finished': {
      host.log.endTurn()
      host.log.stopTools()
      host.statusLine.stop()
      host.movePendingBash()
      if (event.status === 'stopped') {
        host.addNotice('Interrupted', 'dim')
      } else if (event.status === 'failed') {
        host.log.markFailed()
        host.setShownError(event.error)
        const hint =
          event.errorHint ?? failureHint(event.errorKind, event.error)
        host.addNotice(
          `Error: ${event.error}${hint ? `\n${hint}` : ''}`,
          'error',
        )
      }
      host.onRunFinished()
      break
    }
  }
  host.requestRender()
}

/** Handles one v0.9 `StreamDeltaEvent` for the active TUI session. */
export function handleRuntimeDeltaForTui(
  host: InteractiveEventHost,
  delta: StreamDeltaEvent,
  activeSessionId: string,
  bashHandlers: Map<string, (chunk: string) => void>,
): void {
  if (delta.sessionId !== activeSessionId) return
  if (delta.type === 'thinking_delta') {
    host.log.appendThinking(delta.delta)
  } else if (delta.type === 'text_delta') {
    host.log.appendText(delta.delta)
    host.statusLine.set('Answering…')
  } else if (delta.type === 'toolcall_end') {
    host.log.addTool(
      delta.toolCall.toolCallId,
      delta.toolCall.toolName,
      delta.toolCall.input,
    )
  } else if (delta.type === 'tool_output_delta') {
    host.log.updateTool(delta.toolCallId, delta.delta)
  } else if (delta.type === 'bash_output_delta' && delta.bashId) {
    bashHandlers.get(delta.bashId)?.(delta.delta)
  }
  host.requestRender()
}
