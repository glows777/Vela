import type { ProviderDefinition } from '../../providers/models/index.ts'
import type { VelaLogger } from '../../shared/logger.ts'
import type { CustomMessageInfo } from '../agent/events.ts'
import type { ModelMessage } from '../messages.ts'
import type { ToolDefinition } from '../tools/registry.ts'
import type { ExtensionEventName, ExtensionEvents } from './events.ts'

export type { CustomMessage, CustomMessageInfo } from '../agent/events.ts'
export type { SendMessageOptions } from '../session/options.ts'
export type {
  AfterProviderResponseEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BeforeProviderRequestEvent,
  ContextEvent,
  ContextEventResult,
  ExtensionEventName,
  ExtensionEvents,
  InputEvent,
  InputEventResult,
  InputSource,
  ProviderStreamEvent,
  SessionBeforeForkEvent,
  SessionBeforeForkEventResult,
  SessionBeforeTreeEvent,
  SessionBeforeTreeEventResult,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
  TreePreparation,
} from './events.ts'

/**
 * An extension: receives the ExtensionAPI and registers tools, commands, and event handlers
 * (modeled on pi's `(pi) => {}`).
 * Unlike pi, it runs once per Vela, and what it registers is shared by all concurrent sessions;
 * handlers learn which session fired the event from `ctx.session`.
 * Only register things in the factory; do not start processes, sockets or timers there. Put long-lived
 * resources in `session_start`.
 */
export type VelaExtension = (vela: ExtensionAPI) => void | Promise<void>

/** Session view exposed to extension hooks and commands via `ctx.session`. */
export interface ExtensionSession {
  readonly id: string
  readonly cwd: string
  readonly name?: string
  readonly channel?: string
  readonly messages: readonly ModelMessage[]
  readonly signal: AbortSignal | undefined
  getActiveTools(): string[]
  setActiveTools(names: string[] | undefined): void
  customMessageOf(message: ModelMessage): CustomMessageInfo | undefined
  notify(message: string, level?: 'info' | 'warning' | 'error'): void
}

/** A handler's second argument: the headless session context that fired the event. */
export interface ExtensionContext {
  session: ExtensionSession
  /** Emit a user-visible notification on the session event stream. */
  notify(message: string, level?: 'info' | 'warning' | 'error'): void
  cwd: string
  /** Abort signal while the session is running; undefined when idle */
  signal: AbortSignal | undefined
}

export interface ExtensionCommand {
  description?: string
  /** args is the text after the command name, trimmed */
  handler: (args: string, ctx: ExtensionContext) => void | Promise<void>
}

export type ExtensionHandler<K extends ExtensionEventName> = (
  event: ExtensionEvents[K][0],
  ctx: ExtensionContext,
) =>
  | ExtensionEvents[K][1]
  | undefined
  | Promise<ExtensionEvents[K][1] | undefined>

export interface ExtensionAPI {
  /** Directory where this extension instance was loaded; handler ctx.cwd is the session directory. */
  readonly cwd: string
  /** Vela's data directory; an extension keeps its own data in `<dataDir>/<extension name>/` */
  readonly dataDir: string
  /**
   * This extension's config section, looked up by extension name in `createRuntime({ extensionConfig })`
   * (in the CLI/daemon, from top-level sections or `extensionConfig.<extension name>` in `config.json`, with `$VAR` already
   * interpolated in strings). `{}` when there is no config.
   */
  readonly config: Readonly<Record<string, unknown>>
  readonly logger: VelaLogger
  /**
   * Registers a tool shared by sessions using this extension instance. The model sees it as `<extension name>_<name>` (e.g. the
   * web extension's `fetch` is `web_fetch`), so it cannot clash with built-in tools; a
   * duplicate name throws. The prefix is not repeated when the tool name equals the extension name
   * (the memory extension's `memory` tool is just `memory`) or already starts with
   * `<extension name>_` (the mcp extension's `mcp__docs__search`).
   * Can be called at any time, e.g. when a server announces new tools; returns the registered name.
   */
  registerTool(tool: ToolDefinition): string
  /** Removes a tool this extension registered, by its registered name; returns whether it existed. */
  unregisterTool(name: string): boolean
  /**
   * @internal Declares a static namespace line for `<deferred_tools>` so async server connects do not
   * mutate the cached system prompt between turns.
   */
  registerDeferredNamespace?(namespace: string, summaryLine: string): void
  /**
   * Runs once when the owning instance is disposed: host instances after all sessions close,
   * project instances after their last session releases them. Errors are logged and collected.
   */
  onShutdown(handler: () => void | Promise<void>): void
  /**
   * Registers a host model provider (like pi's registerProvider, only the "return an AI SDK model" form).
   * Project extensions cannot register providers; the attempt is reported and skipped.
   * Afterwards `provider/id` works in createVela's model, `session.setModel()`, and the CLI's
   * `--model` / `/model`. Provider names are not prefixed; a name that already exists throws.
   * With `oauth` (or `apiKeyLogin`) the provider appears in `/login`; `createModel(id, ctx)` reads the stored
   * credential with `ctx.credential()` on each request.
   */
  registerProvider(name: string, provider: ProviderDefinition): void
  /** Registers a `/name` command: `session.prompt('/name args')` runs it instead of sending it to the model. */
  registerCommand(name: string, command: ExtensionCommand): void
  /** Subscribes to an event; handlers run in extension load and registration order. Returns an unsubscribe function. */
  on<K extends ExtensionEventName>(
    event: K,
    handler: ExtensionHandler<K>,
  ): () => void
  /** Handle a single tool name; other tool calls bypass this handler. */
  on(
    event: 'tool_call',
    toolName: string,
    handler: ExtensionHandler<'tool_call'>,
  ): () => void
}
