import type { VelaLogger } from '../logger.ts'
import type { ProviderDefinition } from '../models/index.ts'
import type { ToolDefinition } from '../tools/registry.ts'
import type { VelaSession } from '../vela-session.ts'
import type { ExtensionEventName, ExtensionEvents } from './events.ts'
import type { ExtensionUI } from './ui.ts'

export type { CustomMessage } from '../agent/events.ts'
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
export type { ExtensionUI, SessionUI } from './ui.ts'

/**
 * An extension: receives the ExtensionAPI and registers tools, commands, channels and event handlers
 * (modeled on pi's `(pi) => {}`).
 * Unlike pi, it runs once per Vela, and what it registers is shared by all concurrent sessions;
 * handlers learn which session fired the event from `ctx.session`.
 * Only register things in the factory; do not start processes, sockets or timers there. Put long-lived
 * resources in `session_start` or a channel's start().
 */
export type VelaExtension = (vela: ExtensionAPI) => void | Promise<void>

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
   * duplicate name throws. The prefix is not repeated when the tool name equals the extension name
   * (the memory extension's `memory` tool is just `memory`) or already starts with
   * `<extension name>_` (the mcp extension's `mcp__docs__search`).
   * Can be called at any time, e.g. when a server announces new tools; returns the registered name.
   */
  registerTool(tool: ToolDefinition): string
  /** Removes a tool this extension registered, by its registered name; returns whether it existed. */
  unregisterTool(name: string): boolean
  /**
   * Runs once when the Vela is disposed, after all sessions closed (for resources shared by all
   * sessions, such as MCP server connections). Errors are logged and collected by dispose().
   */
  onShutdown(handler: () => void | Promise<void>): void
  /**
   * Registers a model provider (like pi's registerProvider, but only the "return an AI SDK model" form).
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
}
