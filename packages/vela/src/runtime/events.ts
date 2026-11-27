/**
 * v0.9 Runtime event contracts:
 *
 * 1. `RuntimeEvent` — durable state-transition events persisted to `vela.db` `events` table
 *    with a monotonic `seq` cursor so disconnected clients (CLI / Desktop / Lark) can catch up
 *    via `afterSeq`.
 * 2. `StreamDeltaEvent` — high-frequency in-memory streaming frames broadcast to live
 *    subscribers without touching SQLite; reconnecting clients read the active in-memory buffer.
 */

import type { VelaMessage } from '../shared/messages.ts'
import type { AgentErrorKind, ProviderUsage } from '../shared/provider-types.ts'

export type RunEndStatus =
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'waiting_human'
  | 'interrupted'

export type RuntimeEventPayload =
  | {
      type: 'run_started'
      runId: string
      trigger:
        | 'user'
        | 'channel'
        | 'timer'
        | 'webhook'
        | 'approval'
        | 'job'
        | 'handoff'
        | 'session'
      inboxEventIds?: string[]
    }
  | {
      type: 'message_committed'
      runId: string
      messageId: string
      message: VelaMessage
      usage?: ProviderUsage
      customType?: string
      display?: boolean
    }
  | {
      type: 'tool_started'
      runId: string
      toolCallId: string
      toolName: string
      input: unknown
    }
  | {
      type: 'tool_finished'
      runId: string
      toolCallId: string
      toolName: string
      isError: boolean
      durationMs?: number
      details?: unknown
      result?: unknown
    }
  | {
      type: 'approval_requested'
      runId: string
      approvalId: string
      toolCallId: string
      toolName: string
      summary: string
      input: unknown
    }
  | {
      type: 'approval_resolved'
      runId?: string
      approvalId: string
      decision: 'approved' | 'denied' | 'cancelled'
      reason?: string
      decidedBy?: string
    }
  | {
      type: 'auto_retry_start'
      runId: string
      attempt: number
      maxAttempts: number
      delayMs: number
      errorMessage: string
    }
  | {
      type: 'auto_retry_end'
      runId: string
      attempt: number
      success: boolean
      finalError?: string
    }
  | {
      type: 'compaction_started'
      runId?: string
      reason: 'manual' | 'threshold' | 'overflow'
    }
  | {
      type: 'compaction_finished'
      runId?: string
      reason: 'manual' | 'threshold' | 'overflow'
      tokensBefore: number
      tokensAfter: number
      messages: number
    }
  | {
      type: 'compaction_failed'
      runId?: string
      reason: 'manual' | 'threshold' | 'overflow'
      aborted: boolean
      willRetry: boolean
      errorMessage: string
    }
  | {
      type: 'notify'
      runId?: string
      level: 'info' | 'warning' | 'error'
      message: string
    }
  | {
      type: 'audit'
      runId?: string
      toolName: string
      path: string
    }
  | {
      type: 'run_finished'
      runId: string
      status: RunEndStatus
      silent?: boolean
      replyPending?: boolean
      error?: string
      errorKind?: AgentErrorKind
      errorHint?: string
    }
  | {
      type: 'session_reset'
    }

/** Persisted Runtime event carrying a strictly monotonic `seq` cursor. */
export type RuntimeEvent = RuntimeEventPayload & {
  seq: number
  sessionId: string
  projectId: string | null
  timestamp: string
}

/** High-frequency in-memory streaming frames (never written to SQLite `events`). */
export type StreamDeltaEvent =
  | {
      type: 'text_delta'
      sessionId: string
      runId: string
      contentIndex: number
      delta: string
    }
  | {
      type: 'thinking_delta'
      sessionId: string
      runId: string
      contentIndex: number
      delta: string
    }
  | {
      type: 'toolcall_end'
      sessionId: string
      runId: string
      contentIndex: number
      toolCall: { toolCallId: string; toolName: string; input: unknown }
    }
  | {
      type: 'tool_output_delta'
      sessionId: string
      runId: string
      toolCallId: string
      toolName: string
      delta: string
    }
  | {
      type: 'bash_output_delta'
      sessionId: string
      runId?: string
      bashId?: string
      delta: string
    }
