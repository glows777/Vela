import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { CustomMessage, VelaEvent } from '../agent/events.ts'
import type { ImageContent, ModelMessage, ToolContent } from '../messages.ts'
import type { BranchSummaryEntry, SessionEntry } from '../session/entries.ts'

/**
 * Where an input came from (pi's sources plus Vela's): the TUI and `-p` send `interactive`, RPC clients `rpc`,
 * `session.sendUserMessage()` `extension`, channels (Lark) `channel`; SDK calls default to `sdk`.
 */
export type InputSource =
  | 'interactive'
  | 'rpc'
  | 'extension'
  | 'channel'
  | 'sdk'

/**
 * User input arrived (prompt / steer / followUp), after extension commands and before `/skill:` and prompt
 * template expansion (like pi).
 */
export interface InputEvent {
  type: 'input'
  images?: ImageContent[]
  text: string
  source: InputSource
  /** How the input will be queued while the session is running; undefined when idle */
  streamingBehavior?: 'steer' | 'followUp'
}

/** `transform` replaces the text (later handlers see the new text); `handled` drops the input (prompt() resolves). */
export type InputEventResult =
  | { action: 'continue' }
  | { action: 'transform'; text: string; images?: ImageContent[] }
  | { action: 'handled' }

/**
 * Before each model request (like pi's `context`): `messages` is a copy of the conversation this request sends
 * (no system prompt). Edit it in place or return `{ messages }`; only this request changes, not the history.
 */
export interface ContextEvent {
  type: 'context'
  messages: ModelMessage[]
}

export interface ContextEventResult {
  messages?: ModelMessage[]
}

/**
 * Before a request goes to the provider (pi's `before_provider_request`). Unlike pi, `params` are the AI SDK
 * call options (prompt, tools, providerOptions, headers, maxOutputTokens, …), not the provider's JSON body,
 * which the AI SDK builds inside the provider. Edit them in place or return replacement options.
 * Fires for summary requests too.
 */
export interface BeforeProviderRequestEvent {
  type: 'before_provider_request'
  params: LanguageModelV4CallOptions
}

/**
 * The provider answered, before the response is read (pi's `after_provider_response`). The AI SDK gives no
 * status for a successful response; a failed one is reported as the request's error.
 */
export interface AfterProviderResponseEvent {
  type: 'after_provider_response'
  headers: Record<string, string>
}

/** A raw provider stream chunk before the AI SDK normalizes it (pi's `provider_stream_event`); read-only. */
export interface ProviderStreamEvent {
  type: 'provider_stream_event'
  /** Provider id of the model, e.g. `anthropic.messages` */
  provider: string
  model: string
  data: unknown
}

/** Before a tool runs. A handler can mutate `input` in place or return `{ block: true, reason }` to block; a throwing handler also blocks. */
export interface ToolCallEvent {
  type: 'tool_call'
  toolCallId: string | undefined
  /** Set when another tool issued this call through `ctx.executeTool()` (its id is then `<parent id>/<n>`) */
  parentToolCallId?: string
  toolName: string
  input: Record<string, unknown>
}

export interface ToolCallEventResult {
  block?: boolean
  reason?: string
}

/** After a tool runs, before the model sees the result. Return `{ output }` to replace the text the model sees; handlers chain. */
export interface ToolResultEvent {
  type: 'tool_result'
  toolCallId: string | undefined
  /** Set when another tool issued this call through `ctx.executeTool()` */
  parentToolCallId?: string
  toolName: string
  input: unknown
  /** The text the model will see (a preview for oversized results) */
  output: string
  /** Ordered text/image blocks when the tool returned multimodal content. */
  content?: ToolContent
}

export interface ToolResultEventResult {
  /** Replace the caption while preserving images. */
  output?: string
  /** Replace all content, including images; [] removes it. Normalized after hooks. */
  content?: ToolContent
}

/**
 * At the start of each prompt(), before the first model request. Handlers write system prompt sections
 * into `sections` (keyed by section name); they stay fixed for the rest of the turn.
 */
export interface BeforeAgentStartEvent {
  type: 'before_agent_start'
  prompt: string
  sections: Record<string, string>
}

/** Return `{ message }` to add a custom message after the user message (like pi); each handler can add one. */
export interface BeforeAgentStartEventResult {
  message?: CustomMessage
}

/** Before the session's first prompt() (after history is restored). */
export interface SessionStartEvent {
  type: 'session_start'
}

/** The session closes (session.close() or vela.dispose()). */
export interface SessionShutdownEvent {
  type: 'session_shutdown'
}

/** What `session.navigateTree()` is about to do (pi's `TreePreparation`). */
export interface TreePreparation {
  /** The entry the user selected */
  targetId: string
  /** The leaf being left */
  oldLeafId: string | null
  /** Deepest entry shared by the old leaf's branch and the target's */
  commonAncestorId: string | null
  /** Entries of the branch being left, after the common ancestor (what a branch summary covers) */
  entriesToSummarize: SessionEntry[]
  /** Whether the caller asked for a branch summary */
  userWantsSummary: boolean
  /** What the summary should prefer to keep (pi's customInstructions) */
  focus?: string
  /** Label to put on the target (or on the summary entry) */
  label?: string
}

/** Before moving within the session tree (pi's session_before_tree). */
export interface SessionBeforeTreeEvent {
  type: 'session_before_tree'
  preparation: TreePreparation
  /** Aborted when the navigation is aborted */
  signal: AbortSignal
}

/**
 * `cancel` stops the navigation. `summary` replaces the built-in branch summary (used only when one was
 * asked for); `focus` and `label` override the caller's.
 */
export interface SessionBeforeTreeEventResult {
  cancel?: boolean
  summary?: { summary: string }
  focus?: string
  label?: string
}

/** After moving within the session tree (pi's session_tree). */
export interface SessionTreeEvent {
  type: 'session_tree'
  newLeafId: string | null
  oldLeafId: string | null
  /** The branch summary appended, if any */
  summaryEntry?: BranchSummaryEntry
  /** Whether that summary came from an extension */
  fromExtension?: boolean
}

/** Before `session.fork()` / `clone()` creates a new session (pi's session_before_fork). */
export interface SessionBeforeForkEvent {
  type: 'session_before_fork'
  entryId: string
  /** `before`: from before a user message; `at`: including the entry (clone) */
  position: 'before' | 'at'
}

export interface SessionBeforeForkEventResult {
  cancel?: boolean
}

// biome-ignore-start lint/suspicious/noConfusingVoidType: the second tuple member is a handler return type; `void` keeps async handlers that return nothing assignable (their type is Promise<void>, which `undefined` would reject)
type InterceptEvents = {
  tool_call: [ToolCallEvent, ToolCallEventResult]
  tool_result: [ToolResultEvent, ToolResultEventResult]
  before_agent_start: [BeforeAgentStartEvent, BeforeAgentStartEventResult]
  input: [InputEvent, InputEventResult]
  context: [ContextEvent, ContextEventResult]
  before_provider_request: [
    BeforeProviderRequestEvent,
    LanguageModelV4CallOptions,
  ]
  after_provider_response: [AfterProviderResponseEvent, void]
  provider_stream_event: [ProviderStreamEvent, void]
  session_start: [SessionStartEvent, void]
  session_shutdown: [SessionShutdownEvent, void]
  session_before_tree: [SessionBeforeTreeEvent, SessionBeforeTreeEventResult]
  session_tree: [SessionTreeEvent, void]
  session_before_fork: [SessionBeforeForkEvent, SessionBeforeForkEventResult]
}

/** Read-only notifications: every other VelaEvent. */
type NotifyEvents = {
  [K in Exclude<VelaEvent['type'], keyof InterceptEvents>]: [
    Extract<VelaEvent, { type: K }>,
    void,
  ]
}
// biome-ignore-end lint/suspicious/noConfusingVoidType: end of handler return-type tuples

export type ExtensionEvents = InterceptEvents & NotifyEvents
export type ExtensionEventName = keyof ExtensionEvents
