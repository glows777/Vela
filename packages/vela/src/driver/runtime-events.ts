import type { DriverTurnRequest } from '../runtime/driver.ts'
import type { VelaEvent } from './agent/events.ts'
import type { AssistantModelMessage } from './messages.ts'

/** Bridges internal `VelaDriver` events & streaming chunks onto `DriverTurnRequest` callbacks. */
export function createRuntimeEventForwarder(
  request: DriverTurnRequest,
  onAssistantMessage: (message: AssistantModelMessage) => void,
): (event: VelaEvent) => void {
  return (event) => {
    switch (event.type) {
      case 'message_update': {
        const inner = event.assistantMessageEvent
        if (inner.type === 'text_delta' || inner.type === 'thinking_delta') {
          request.onDelta({
            type: inner.type,
            sessionId: request.sessionId,
            runId: request.runId,
            contentIndex: inner.contentIndex,
            delta: inner.delta,
          })
        } else if (inner.type === 'toolcall_end') {
          request.onDelta({
            type: 'toolcall_end',
            sessionId: request.sessionId,
            runId: request.runId,
            contentIndex: inner.contentIndex,
            toolCall: {
              toolCallId: inner.toolCall.toolCallId,
              toolName: inner.toolCall.toolName,
              input: inner.toolCall.input,
            },
          })
        }
        break
      }
      case 'tool_execution_update': {
        const delta =
          typeof event.partialResult === 'string'
            ? event.partialResult
            : JSON.stringify(event.partialResult ?? '')
        request.onDelta({
          type: 'tool_output_delta',
          sessionId: request.sessionId,
          runId: request.runId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          delta,
        })
        break
      }
      case 'tool_execution_start':
        request.onEvent({
          type: 'tool_started',
          runId: request.runId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.args,
        })
        break
      case 'tool_execution_end':
        request.onEvent({
          type: 'tool_finished',
          runId: request.runId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          durationMs: event.durationMs,
          details: event.details,
          result: event.result,
        })
        break
      case 'auto_retry_start':
        request.onEvent({
          type: 'auto_retry_start',
          runId: request.runId,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage,
        })
        break
      case 'auto_retry_end':
        request.onEvent({
          type: 'auto_retry_end',
          runId: request.runId,
          attempt: event.attempt,
          success: event.success,
          ...(event.finalError !== undefined
            ? { finalError: event.finalError }
            : {}),
        })
        break
      case 'approval_requested':
        request.onEvent({
          type: 'approval_requested',
          runId: request.runId,
          approvalId: event.approvalId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          summary: event.summary,
          input: event.input ?? {},
        })
        break
      case 'message_end':
        if (event.message.role === 'assistant') {
          onAssistantMessage(event.message)
        }
        break
      case 'compaction_start':
        request.onEvent({
          type: 'compaction_started',
          runId: request.runId,
          reason: event.reason,
        })
        break
      case 'compaction_end':
        if (event.result) {
          request.onEvent({
            type: 'compaction_finished',
            runId: request.runId,
            reason: event.reason,
            tokensBefore: event.result.tokensBefore,
            tokensAfter: event.result.tokensAfter,
            messages: event.result.messages,
          })
        } else if (event.aborted || event.errorMessage) {
          request.onEvent({
            type: 'compaction_failed',
            runId: request.runId,
            reason: event.reason,
            aborted: event.aborted,
            willRetry: event.willRetry,
            errorMessage: event.errorMessage ?? 'Compaction aborted',
          })
        }
        break
      case 'notify':
        request.onEvent({
          type: 'notify',
          runId: request.runId,
          level: event.level,
          message: event.message,
        })
        break
    }
  }
}
