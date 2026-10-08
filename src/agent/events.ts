import type { ModelMessage } from 'ai'
import type { StepRecord, StepUsage } from '../usage/tracker.ts'

/**
 * Events the agent reports while it runs. Core code only emits events and never
 * writes to the terminal; the CLI, channels and tests decide how to show or assert them.
 */
export type VelaEvent =
  /** session.prompt() starts handling a user input (including skills / dream triggered by slash commands) */
  | { type: 'agent_start'; input: string }
  /** A message entered the session history: user input, model reply, tool result, loop-detection reminder */
  | { type: 'message'; message: ModelMessage }
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; text: string }
  /** Model thinking / reasoning text (only when the provider returns it) */
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; input: unknown }
  | {
      type: 'tool_result'
      toolCallId: string
      toolName: string
      input: unknown
      output: unknown
    }
  | {
      type: 'tool_error'
      toolCallId: string
      toolName: string
      input: unknown
      error: unknown
    }
  | {
      type: 'loop_detected'
      level: 'warning' | 'critical'
      detector: string
      message: string
    }
  | {
      type: 'retry'
      attempt: number
      maxRetries: number
      delayMs: number
      error: unknown
    }
  | {
      type: 'usage'
      modelId: string
      usage: StepUsage
      record?: StepRecord
    }
  | { type: 'turn_end'; turn: number; needsToolCall: boolean }
  | {
      type: 'agent_end'
      reason: 'done' | 'loop' | 'aborted' | 'error'
      error?: unknown
    }
  /** Queued messages changed (steer / followUp enqueued, dequeued, cleared); both fields hold the full current queue */
  | { type: 'queue_update'; steering: string[]; followUp: string[] }
  /**
   * All work from prompt() is done (including the loops run for steer / followUp queued after it)
   * and the session is idle again. Same as pi's agent_settled.
   */
  | { type: 'agent_settled' }
  | {
      type: 'context'
      /** compact = manual summary via session.compact() */
      action: 'micro' | 'summary' | 'summary-required' | 'compact'
      before: number
      after?: number
      saved?: number
      calls?: number
      messages?: number
    }
  | { type: 'session_save_failed'; error: unknown }
  /** Audit record before a file-writing tool call (emitted by a pre hook) */
  | { type: 'audit'; toolName: string; path: string }
  /** A bash command was rated medium risk; it still runs, with a warning */
  | { type: 'security_warning'; toolName: string; reason: string; command: string }
  /** An extension called ui.notify() in a session without a UI */
  | { type: 'notify'; message: string; level: 'info' | 'warning' | 'error' }
  /** A channel received a message (channel session) */
  | {
      type: 'channel_message'
      channel: string
      senderId: string
      senderName: string
      text: string
    }
  /** A channel sent a reply */
  | { type: 'channel_reply'; channel: string; recipientId: string; text: string }
  /** A channel turn failed (including aborts) */
  | {
      type: 'channel_error'
      channel: string
      senderId: string
      error: unknown
      aborted: boolean
    }

export type VelaEventListener = (event: VelaEvent) => void

/** Callback for vela.subscribe(): events from all sessions; the second argument is the event's session id. */
export type VelaSessionEventListener = (
  event: VelaEvent,
  sessionId: string,
) => void
