import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { ModelMessage, UserContent } from 'ai'
import type { VelaEvent } from '../agent/events.ts'
import type { ChannelDefinition } from '../channels/types.ts'
import type { VelaLogger } from '../logger.ts'
import type { ProviderDefinition } from '../models/index.ts'
import type { ToolDefinition } from '../tools/registry.ts'
import type { VelaSession } from '../vela-session.ts'

/**
 * An extension: receives the ExtensionAPI and registers tools, commands, channels and event handlers
 * (modeled on pi's `(pi) => {}`).
 * Unlike pi, it runs once per Vela, and what it registers is shared by all concurrent sessions;
 * handlers learn which session fired the event from `ctx.session`.
 * Only register things in the factory; do not start processes, sockets or timers there. Put long-lived
 * resources in `session_start` or a channel's start().
 */
export type VelaExtension = (vela: ExtensionAPI) => void | Promise<void>

/**
 * How extensions interact with the user (a trimmed-down version of pi's ctx.ui). With no UI (SDK, `-p`,
 * channel sessions), notify becomes a `notify` event, confirm returns false, select / input return
 * undefined, and setStatus / setWidget do nothing.
 * In RPC mode they become `extension_ui_request` events that the client answers.
 */
export interface ExtensionUI {
  notify(message: string, level?: 'info' | 'warning' | 'error'): void
  confirm(title: string, message: string): Promise<boolean>
  select(title: string, options: string[]): Promise<string | undefined>
  input(title: string, placeholder?: string): Promise<string | undefined>
  /** A status entry in the footer (keyed by key; empty text clears it) */
  setStatus(key: string, text?: string): void
  /** Lines of text above the input box (keyed by key; empty lines clears them) */
  setWidget(key: string, lines?: string[]): void
}

/** The UI passed in session options: setStatus / setWidget are optional (no-ops when missing). */
export type SessionUI = Omit<ExtensionUI, 'setStatus' | 'setWidget'> &
  Partial<Pick<ExtensionUI, 'setStatus' | 'setWidget'>>

/** A handler's second argument: the session that fired the event and its UI. */
export interface ExtensionContext {
  session: VelaSession
  ui: ExtensionUI
  /** Whether there is a UI that can actually show confirm / select */
  hasUI: boolean
  cwd: string
  /** Abort signal while the session is running; undefined when idle */
  signal: AbortSignal | undefined
}

export interface ExtensionCommand {
  description?: string
  /** args is the text after the command name, trimmed */
  handler: (args: string, ctx: ExtensionContext) => void | Promise<void>
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

/** How `session.sendMessage()` delivers a custom message (same as pi). */
export interface SendMessageOptions {
  /** When idle: run the agent loop with the message as its input. Default false (the message is only appended) */
  triggerTurn?: boolean
  /**
   * `steer` / `followUp`: while running, queue it like steer() / followUp() (default steer).
   * `nextTurn`: hold it and add it after the user message of the next prompt.
   */
  deliverAs?: 'steer' | 'followUp' | 'nextTurn'
}

/**
 * Where an input came from (pi's sources plus Vela's): the TUI and `-p` send `interactive`, RPC clients `rpc`,
 * `session.sendUserMessage()` `extension`, channels (Feishu) `channel`; SDK calls default to `sdk`.
 */
export type InputSource =
  | 'interactive'
  | 'rpc'
  | 'extension'
  | 'channel'
  | 'sdk'

/**
 * User input arrived (prompt / steer / followUp), after extension commands and before `/skill:` and prompt
 * template expansion (like pi). Fires in sessions of every role; check `ctx.session.role`.
 */
export interface InputEvent {
  type: 'input'
  text: string
  source: InputSource
  /** How the input will be queued while the session is running; undefined when idle */
  streamingBehavior?: 'steer' | 'followUp'
}

/** `transform` replaces the text (later handlers see the new text); `handled` drops the input (prompt() resolves). */
export type InputEventResult =
  | { action: 'continue' }
  | { action: 'transform'; text: string }
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
}

export interface ToolResultEventResult {
  output?: string
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
}

/** Read-only notifications: every other VelaEvent. */
type NotifyEvents = {
  [K in Exclude<VelaEvent['type'], keyof InterceptEvents>]: [
    Extract<VelaEvent, { type: K }>,
    void,
  ]
}

export type ExtensionEvents = InterceptEvents & NotifyEvents
export type ExtensionEventName = keyof ExtensionEvents

export type ExtensionHandler<K extends ExtensionEventName> = (
  event: ExtensionEvents[K][0],
  ctx: ExtensionContext,
) =>
  | ExtensionEvents[K][1]
  | undefined
  | Promise<ExtensionEvents[K][1] | undefined>

export interface ExtensionAPI {
  /** Working directory for tools */
  readonly cwd: string
  /** Vela's data directory; an extension keeps its own data in `<dataDir>/<extension name>/` */
  readonly dataDir: string
  /**
   * This extension's config section, looked up by extension name in `createVela({ extensionConfig })`
   * (in the CLI, from `extensionConfig.<extension name>` in settings.json, with `$VAR` already
   * interpolated in strings). `{}` when there is no config.
   */
  readonly config: Readonly<Record<string, unknown>>
  readonly logger: VelaLogger
  /**
   * Registers a tool shared by all sessions. The model sees it as `<extension name>_<name>` (e.g. the
   * web extension's `fetch` is `web_fetch`), so it cannot clash with built-in tools; a
   * duplicate name throws. When the tool name equals the extension name the prefix is not repeated
   * (the memory extension's `memory` tool is just `memory`).
   */
  registerTool(tool: ToolDefinition): void
  /**
   * Registers a model provider (like pi's registerProvider, but only the "return an AI SDK model" form).
   * Afterwards `provider/id` works in createVela's model, `session.setModel()`, and the CLI's
   * `--model` / `/model`. Provider names are not prefixed; a name that already exists throws.
   */
  registerProvider(name: string, provider: ProviderDefinition): void
  /** Registers a `/name` command: in owner sessions, `session.prompt('/name args')` runs it instead of sending it to the model. */
  registerCommand(name: string, command: ExtensionCommand): void
  /** Registers a message channel (Vela-specific): one session per conversation and sender, guest role by default. */
  registerChannel(channel: ChannelDefinition): void
  /** Subscribes to an event; handlers run in extension load and registration order. Returns an unsubscribe function. */
  on<K extends ExtensionEventName>(
    event: K,
    handler: ExtensionHandler<K>,
  ): () => void
}
