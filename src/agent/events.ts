import type {
  AssistantModelMessage,
  ModelMessage,
  ToolCallPart,
  ToolResultPart,
} from 'ai'
import type { StepRecord, StepUsage } from '../usage/tracker.ts'

/**
 * Events the agent reports while it runs. Core code only emits events and never
 * writes to the terminal; the CLI, channels and tests decide how to show or assert them.
 */
/** Why an assistant message ended (like pi's `stopReason`; on the event because `ModelMessage` has no such field). */
export type StopReason = 'stop' | 'length' | 'toolUse' | 'aborted' | 'error'

/** Why earlier history is summarized (pi's compaction reasons). */
export type CompactionReason = 'manual' | 'threshold' | 'overflow'

/** What a summary did (like pi's `CompactionResult`). */
export interface CompactionResult {
  summary: string
  /** Session entry the kept history starts at */
  firstKeptEntryId: string
  tokensBefore: number
  tokensAfter: number
  /** How many messages were summarized */
  messages: number
}

/**
 * What changed in a streaming assistant message (same names and fields as pi's `AssistantMessageEvent`).
 * `contentIndex` is the index of the changed part in `message.content`.
 */
export type AssistantMessageEvent =
  | { type: 'text_start'; contentIndex: number }
  | { type: 'text_delta'; contentIndex: number; delta: string }
  | { type: 'text_end'; contentIndex: number; content: string }
  | { type: 'thinking_start'; contentIndex: number }
  | { type: 'thinking_delta'; contentIndex: number; delta: string }
  | { type: 'thinking_end'; contentIndex: number; content: string }
  | { type: 'toolcall_start'; contentIndex: number }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCallPart }

/**
 * Events the agent reports while it runs. Core code only emits events and never
 * writes to the terminal; the CLI, channels and tests decide how to show or assert them.
 * Message and tool events have pi's shape (`message_start / message_update / message_end`,
 * `tool_execution_start / update / end`), with AI SDK `ModelMessage`s as the messages.
 */
export type VelaEvent =
  /** session.prompt() starts handling a user input (including skills / dream triggered by slash commands) */
  | { type: 'agent_start'; input: string }
  | { type: 'turn_start'; turn: number }
  /**
   * A message starts. User, tool and loop-reminder messages get `message_start` and `message_end` back to back;
   * an assistant message streams `message_update`s in between.
   */
  | { type: 'message_start'; message: ModelMessage }
  /** The assistant message so far (`message`) and what just changed (`assistantMessageEvent`). */
  | {
      type: 'message_update'
      message: AssistantModelMessage
      assistantMessageEvent: AssistantMessageEvent
    }
  /**
   * A message is complete. Assistant messages carry `stopReason` (and `errorMessage` when it is `error` / `aborted`).
   * An assistant message that ended in a retried error is not in the session history; every other one is
   * (an aborted / failed one with the text and whole tool calls received so far).
   */
  | {
      type: 'message_end'
      message: ModelMessage
      stopReason?: StopReason
      errorMessage?: string
    }
  /** A tool call is about to run (after the assistant message's `message_end`). */
  | {
      type: 'tool_execution_start'
      toolCallId: string
      toolName: string
      args: unknown
      /** Set on a call made by another tool through `ctx.executeTool()`: the calling tool's id */
      parentToolCallId?: string
    }
  /** Partial output of a running tool (like pi; tools that stream their output emit it). */
  | {
      type: 'tool_execution_update'
      toolCallId: string
      toolName: string
      args: unknown
      partialResult: unknown
      /** Set on a call made by another tool through `ctx.executeTool()`: the calling tool's id */
      parentToolCallId?: string
    }
  /** A tool call finished: `result` is the tool's output, or the error when `isError`. */
  | {
      type: 'tool_execution_end'
      toolCallId: string
      toolName: string
      result: unknown
      isError: boolean
      /** How long the tool ran; absent when it did not run */
      durationMs?: number
      /** Set on a call made by another tool through `ctx.executeTool()`: the calling tool's id */
      parentToolCallId?: string
    }
  | {
      type: 'loop_detected'
      level: 'warning' | 'critical'
      detector: string
      message: string
    }
  /** A request failed with a retryable error; the step is sent again after `delayMs` (like pi). */
  | {
      type: 'auto_retry_start'
      attempt: number
      maxAttempts: number
      delayMs: number
      errorMessage: string
    }
  /** Retrying ended: the step succeeded, or failed for good (`finalError`). */
  | {
      type: 'auto_retry_end'
      success: boolean
      attempt: number
      finalError?: string
    }
  | {
      type: 'usage'
      modelId: string
      usage: StepUsage
      record?: StepRecord
    }
  /** A turn (one assistant message and its tool results) ended. */
  | {
      type: 'turn_end'
      turn: number
      message: AssistantModelMessage
      toolResults: ToolResultPart[]
    }
  /**
   * The agent loop ended. `messages` are the messages it added (like pi); `reason` / `error` say why it stopped
   * (Vela keeps them: `loop` is Vela's loop detection, and `prompt()` still rejects with `error`).
   */
  | {
      type: 'agent_end'
      messages: ModelMessage[]
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
  /**
   * Old tool output was folded into file references (`micro`), or the context needs a summary that this
   * request may not run (`summary-required`). Vela-specific; summaries are compaction_start / compaction_end.
   */
  | {
      type: 'context'
      action: 'micro' | 'summary-required'
      before: number
      after?: number
      saved?: number
      calls?: number
    }
  /** Summarizing earlier history starts (like pi): `threshold` before a request, `manual` from session.compact(), `overflow` after the provider said the context is too long. */
  | { type: 'compaction_start'; reason: CompactionReason }
  /**
   * Summarizing ended (like pi). `result` is set when it succeeded; `aborted` when it was interrupted;
   * otherwise `errorMessage` says why it failed. `willRetry`: the request that overflowed is sent again.
   */
  | {
      type: 'compaction_end'
      reason: CompactionReason
      result?: CompactionResult
      aborted: boolean
      willRetry: boolean
      errorMessage?: string
    }
  /** Writing the session's entries failed; they are kept and written with the next entry or at the end of the run. */
  | { type: 'session_save_failed'; error: unknown }
  /** Audit record before a file-writing tool call (emitted by a pre hook) */
  | { type: 'audit'; toolName: string; path: string }
  /** A bash command was rated medium risk; it still runs, with a warning */
  | {
      type: 'security_warning'
      toolName: string
      reason: string
      command: string
    }
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
  | {
      type: 'channel_reply'
      channel: string
      recipientId: string
      text: string
    }
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
