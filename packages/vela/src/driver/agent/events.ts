import type {
  AssistantModelMessage,
  ModelMessage,
  ToolCallPart,
  ToolResultPart,
  UserContent,
} from '../messages.ts'
import type { StepRecord, StepUsage } from '../usage/tracker.ts'

/**
 * Events the agent reports while it runs. Core code only emits events and never
 * writes to the terminal; the CLI, channels and tests decide how to show or assert them.
 */
/** Why an assistant message ended (like pi's `stopReason`; on the event because `ModelMessage` has no such field). */
export type StopReason = 'stop' | 'length' | 'toolUse' | 'aborted' | 'error'

/** A terminal failure category for hosts; it does not decide retries. */
export type AgentErrorKind =
  | 'auth'
  | 'billing'
  | 'rate_limit'
  | 'network'
  | 'context_overflow'
  | 'provider'
  | 'unknown'

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
 * Marks a message an extension sent with `session.sendMessage()` (pi's custom message). The model sees it as a
 * user message; `display` says whether a UI shows it, `details` is the extension's own data (not sent to the model).
 */
export interface CustomMessageInfo {
  customType: string
  display: boolean
  details?: unknown
}

/**
 * A message an extension adds to a session's conversation (pi's custom message), for
 * `session.sendMessage()` and `before_agent_start` results. The model sees `content` as a user message;
 * `display` says whether UIs show it; `details` is the extension's own data, saved but never sent to the model.
 */
export interface CustomMessage {
  customType: string
  content: UserContent
  display: boolean
  details?: unknown
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
  | {
      type: 'message_start'
      message: ModelMessage
      /** Set when the message is a custom message (an extension's `session.sendMessage()`, or a loop notice) */
      custom?: CustomMessageInfo
    }
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
      /** Set when the message is a custom message (an extension's `session.sendMessage()`, or a loop notice) */
      custom?: CustomMessageInfo
    }
  /** A tool call is about to run (after the assistant message's `message_end`). */
  | {
      type: 'tool_execution_start'
      toolCallId: string
      toolName: string
      args: unknown
    }
  /** Partial output of a running tool (like pi; tools that stream their output emit it). */
  | {
      type: 'tool_execution_update'
      toolCallId: string
      toolName: string
      args: unknown
      partialResult: unknown
    }
  /** A tool call finished: `result` is the tool's output, or the error when `isError`. */
  | {
      type: 'tool_execution_end'
      toolCallId: string
      toolName: string
      result: unknown
      isError: boolean
      /**
       * Structured data for display that the model does not get (like pi's `result.details`), e.g. edit's
       * `{ diff, patch, firstChangedLine }`: the `value` of a `ToolExecutionResult`
       */
      details?: unknown
      /** How long the tool ran; absent when it did not run */
      durationMs?: number
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
   * The agent loop ended. `messages` are the messages it added (like pi); `reason` / `error` say why it stopped.
   */
  | {
      type: 'agent_end'
      messages: ModelMessage[]
      reason: 'done' | 'aborted' | 'error' | 'waiting_human'
      error?: unknown
      /** Present on failed runs; the original error and prompt rejection stay unchanged. */
      errorKind?: AgentErrorKind
    }
  /** Queued steer messages changed; holds the full current steering queue. */
  | { type: 'queue_update'; steering: string[] }
  /** A tool call was suspended awaiting human approval. */
  | {
      type: 'approval_requested'
      approvalId: string
      toolCallId: string
      toolName: string
      summary: string
      input?: Record<string, unknown>
    }
  /**
   * All work from prompt() is done (including loops run for steer queued after it)
   * and the session is idle (or waiting for human approval). Same as pi's agent_settled.
   */
  | { type: 'agent_settled' }
  /**
   * Output of a running `session.executeBash()` command (`!cmd`, RPC `bash`), chunk by chunk (like pi). `id` is
   * the `id` passed to `executeBash()` (the RPC command's id).
   */
  | { type: 'bash_execution_update'; id?: string; delta: string }
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
  /** Audit record before a file-writing tool call (emitted by a pre hook) */
  | { type: 'audit'; toolName: string; path: string }
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
  /** A channel turn failed (including aborts); `feedback` marks a failed progress update instead */
  | {
      type: 'channel_error'
      channel: string
      senderId: string
      error: unknown
      aborted: boolean
      /**
       * `feedback`: updating the user-visible progress (card, acknowledgement) failed. The turn may
       * still be running and delivering its answer, so this is not a turn failure.
       */
      source?: 'feedback'
    }

export type VelaEventListener = (event: VelaEvent) => void

/** Callback for vela.subscribe(): events from all sessions; the second argument is the event's session id. */
export type VelaSessionEventListener = (
  event: VelaEvent,
  sessionId: string,
) => void
