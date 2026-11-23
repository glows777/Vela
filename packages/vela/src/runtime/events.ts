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
import type { ProviderUsage } from '../shared/provider-types.ts'

export type RunEndStatus = 'completed' | 'stopped' | 'failed' | 'waiting_human'

export type RuntimeEventPayload =
  | {
      type: 'run_started'
      runId: string
      trigger: 'user' | 'channel' | 'timer' | 'webhook' | 'approval' | 'job'
    }
  | {
      type: 'message_committed'
      runId: string
      messageId: string
      message: VelaMessage
      usage?: ProviderUsage
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
      approvalId: string
      decision: 'approved' | 'denied'
      reason?: string
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
      type: 'run_finished'
      runId: string
      status: RunEndStatus
      error?: string
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
      type: 'tool_output_delta'
      sessionId: string
      runId: string
      toolCallId: string
      toolName: string
      delta: string
    }
