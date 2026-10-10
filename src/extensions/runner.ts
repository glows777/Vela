import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { ModelMessage } from 'ai'
import type { VelaEvent } from '../agent/events.ts'
import type { ChannelGateway } from '../channels/gateway.ts'
import { errorMessage, type VelaLogger } from '../logger.ts'
import type { ModelRegistry } from '../models/index.ts'
import type { HookPipeline } from '../security/hooks.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { VelaSession } from '../vela-session.ts'
import type {
  AfterProviderResponseEvent,
  BeforeAgentStartEventResult,
  ContextEventResult,
  CustomMessage,
  ExtensionAPI,
  ExtensionCommand,
  ExtensionContext,
  ExtensionEventName,
  ExtensionHandler,
  InputEventResult,
  InputSource,
  ProviderStreamEvent,
  ToolCallEventResult,
  ToolResultEventResult,
  VelaExtension,
} from './types.ts'

interface RunnerDeps {
  cwd: string
  dataDir: string
  extensionConfig: Record<string, Record<string, unknown>>
  logger: VelaLogger
  registry: ToolRegistry
  models: ModelRegistry
  hooks: HookPipeline
  gateway: ChannelGateway
  /** Look up an open session by id (hooks only know the session id) */
  session: (id: string) => VelaSession | undefined
}

export interface LoadedExtension {
  name: string
  tools: string[]
  /** Registered model providers */
  providers: string[]
  commands: string[]
  channels: string[]
}

type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown

const COMMAND_NAME = /^[A-Za-z0-9][\w-]*$/

/**
 * Extension runtime: runs extension factories, keeps the handlers and commands they register, and
 * calls them in registration order at the right time.
 * Tool call interception hangs off the HookPipeline (the same chain as internal hooks such as audit).
 */
export class ExtensionRunner {
  private readonly handlers = new Map<
    ExtensionEventName,
    { extension: string; fn: AnyHandler }[]
  >()
  private readonly commandMap = new Map<
    string,
    { extension: string; command: ExtensionCommand }
  >()
  private readonly loadedList: LoadedExtension[] = []
  /** Resolves when all extension factories (including async ones) finish; rejects on failure */
  readonly ready: Promise<void>

  constructor(
    private readonly deps: RunnerDeps,
    extensions: readonly VelaExtension[],
  ) {
    deps.hooks.registerPre('extensions', async (toolName, input, context) => {
      const session = context.sessionId
        ? deps.session(context.sessionId)
        : undefined
      if (!session) return { action: 'allow' }
      const result = await this.toolCall(
        session,
        context.toolCallId,
        context.parentToolCallId,
        toolName,
        input,
      )
      if (result.block)
        return {
          action: 'block',
          reason: result.reason ?? 'Blocked by an extension',
        }
      return result.input === input
        ? { action: 'allow' }
        : { action: 'modify', modifiedInput: result.input }
    })
    deps.hooks.registerPost(
      'extensions',
      async (toolName, input, output, context) => {
        const session = context.sessionId
          ? deps.session(context.sessionId)
          : undefined
        if (!session) return { action: 'allow' }
        const text = await this.toolResult(
          session,
          context.toolCallId,
          context.parentToolCallId,
          toolName,
          input,
          String(output),
        )
        return text === output
          ? { action: 'allow' }
          : { action: 'modify', modifiedOutput: text }
      },
    )

    const pending: Promise<void>[] = []
    extensions.forEach((extension, index) => {
      const name = extension.name || `extension-${index + 1}`
      const result = extension(this.api(name))
      if (result instanceof Promise)
        pending.push(
          result.catch((error) => {
            throw new Error(
              `Extension ${name} failed to load: ${errorMessage(error)}`,
            )
          }),
        )
    })
    this.ready = Promise.all(pending).then(() => {})
    // Avoid an unhandled rejection when nobody awaits it; prompt() awaits it and reports the error
    this.ready.catch(() => {})
  }

  private api(name: string): ExtensionAPI {
    const loaded: LoadedExtension = {
      name,
      tools: [],
      providers: [],
      commands: [],
      channels: [],
    }
    this.loadedList.push(loaded)
    const { deps } = this
    const prefix = name.replace(/[^A-Za-z0-9_-]/g, '_')
    return {
      cwd: deps.cwd,
      dataDir: deps.dataDir,
      config: Object.freeze({ ...deps.extensionConfig[name] }),
      logger: deps.logger,
      registerProvider: (providerName, provider) => {
        deps.models.register(providerName, provider)
        loaded.providers.push(providerName)
      },
      registerTool: (tool) => {
        // Prefix tool names with the extension name so they cannot clash with built-in or other
        // extensions' tools; skip the prefix when the tool name equals it (memory's tool is not memory_memory)
        const toolName =
          tool.name === prefix ? prefix : `${prefix}_${tool.name}`
        deps.registry.register({ ...tool, name: toolName })
        loaded.tools.push(toolName)
      },
      registerCommand: (commandName, command) => {
        if (!COMMAND_NAME.test(commandName))
          throw new Error(`Invalid command name "${commandName}"`)
        const existing = this.commandMap.get(commandName)
        if (existing)
          throw new Error(
            `Command /${commandName} is already registered by extension ${existing.extension}`,
          )
        this.commandMap.set(commandName, { extension: name, command })
        loaded.commands.push(commandName)
      },
      registerChannel: (channel) => {
        deps.gateway.register(channel)
        loaded.channels.push(channel.name)
      },
      on: <K extends ExtensionEventName>(
        event: K,
        handler: ExtensionHandler<K>,
      ) => {
        const list = this.handlers.get(event) ?? []
        const entry = { extension: name, fn: handler as AnyHandler }
        list.push(entry)
        this.handlers.set(event, list)
        return () => {
          const index = list.indexOf(entry)
          if (index !== -1) list.splice(index, 1)
        }
      },
    }
  }

  /** Loaded extensions and what they registered */
  loaded(): LoadedExtension[] {
    return this.loadedList.map((e) => ({
      ...e,
      tools: [...e.tools],
      commands: [...e.commands],
      channels: [...e.channels],
    }))
  }

  commands(): { name: string; description?: string; extension: string }[] {
    return [...this.commandMap].map(([name, { extension, command }]) => ({
      name,
      description: command.description,
      extension,
    }))
  }

  context(session: VelaSession, signal = session.signal): ExtensionContext {
    return {
      session,
      ui: session.ui,
      hasUI: session.hasUI,
      cwd: this.deps.cwd,
      signal,
    }
  }

  /** A copy of the handler list, so unsubscribing during dispatch does not affect the current dispatch */
  private list(event: ExtensionEventName) {
    return [...(this.handlers.get(event) ?? [])]
  }

  private report(extension: string, event: string, error: unknown) {
    this.deps.logger.error(
      `[extension:${extension}] ${event} handler failed: ${errorMessage(error)}`,
    )
  }

  /** Read-only notification: handlers are not awaited and errors are logged. */
  notify(event: VelaEvent, session: VelaSession): void {
    this.dispatch(event.type, event, session)
  }

  private dispatch(
    name: ExtensionEventName,
    event: unknown,
    session: VelaSession,
  ): void {
    const handlers = this.list(name)
    if (!handlers.length) return
    const ctx = this.context(session)
    for (const { extension, fn } of handlers) {
      try {
        const result = fn(event, ctx)
        if (result instanceof Promise)
          result.catch((error) => this.report(extension, name, error))
      } catch (error) {
        this.report(extension, name, error)
      }
    }
  }

  /** Lifecycle events: await each handler in order; log errors and continue. */
  private async lifecycle(
    event: { type: 'session_start' | 'session_shutdown' },
    session: VelaSession,
  ) {
    const ctx = this.context(session)
    for (const { extension, fn } of this.list(event.type)) {
      try {
        await fn(event, ctx)
      } catch (error) {
        this.report(extension, event.type, error)
      }
    }
  }

  sessionStart(session: VelaSession) {
    return this.lifecycle({ type: 'session_start' }, session)
  }

  sessionShutdown(session: VelaSession) {
    return this.lifecycle({ type: 'session_shutdown' }, session)
  }

  /** Whether any extension handles `event` (lets callers skip copying data for nobody, like pi's hasHandlers). */
  hasHandlers(event: ExtensionEventName): boolean {
    return (this.handlers.get(event)?.length ?? 0) > 0
  }

  /**
   * before_agent_start: collect this turn's system prompt sections and the custom messages handlers return
   * (added after the user message, like pi).
   */
  async beforeAgentStart(
    session: VelaSession,
    prompt: string,
  ): Promise<{ sections: Record<string, string>; messages: CustomMessage[] }> {
    const event = { type: 'before_agent_start' as const, prompt, sections: {} }
    const messages: CustomMessage[] = []
    const ctx = this.context(session)
    for (const { extension, fn } of this.list('before_agent_start')) {
      try {
        const result = (await fn(event, ctx)) as
          | BeforeAgentStartEventResult
          | undefined
        if (result?.message) messages.push(result.message)
      } catch (error) {
        this.report(extension, event.type, error)
      }
    }
    return { sections: event.sections, messages }
  }

  /**
   * input: transforms chain and `handled` stops (like pi). Returns the text to use, or undefined when a handler
   * handled the input. A throwing handler is logged and skipped.
   */
  async input(
    session: VelaSession,
    text: string,
    source: InputSource,
    streamingBehavior?: 'steer' | 'followUp',
  ): Promise<string | undefined> {
    let current = text
    const ctx = this.context(session)
    for (const { extension, fn } of this.list('input')) {
      try {
        const result = (await fn(
          {
            type: 'input',
            text: current,
            source,
            ...(streamingBehavior ? { streamingBehavior } : {}),
          },
          ctx,
        )) as InputEventResult | undefined
        if (result?.action === 'handled') return undefined
        if (result?.action === 'transform') current = result.text
      } catch (error) {
        this.report(extension, 'input', error)
      }
    }
    return current
  }

  /**
   * context: each handler gets a copy of the messages the request will send, edits it in place or returns new
   * ones (like pi). Returns `messages` itself when nobody handles the event; a throwing handler is logged and
   * the previous result kept.
   */
  async transformContext(
    session: VelaSession,
    messages: ModelMessage[],
  ): Promise<ModelMessage[]> {
    const handlers = this.list('context')
    if (!handlers.length) return messages
    let current = copyMessages(messages)
    const ctx = this.context(session)
    for (const { extension, fn } of handlers) {
      try {
        const event = { type: 'context' as const, messages: current }
        const result = (await fn(event, ctx)) as ContextEventResult | undefined
        current = result?.messages ?? event.messages
      } catch (error) {
        this.report(extension, 'context', error)
      }
    }
    return current
  }

  /** before_provider_request: handlers edit `params` in place or return replacements; errors are logged. */
  async beforeProviderRequest(
    session: VelaSession,
    params: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4CallOptions> {
    let current = params
    const ctx = this.context(session)
    for (const { extension, fn } of this.list('before_provider_request')) {
      try {
        const event = {
          type: 'before_provider_request' as const,
          params: current,
        }
        const result = (await fn(event, ctx)) as
          | LanguageModelV4CallOptions
          | undefined
        current = result ?? event.params
      } catch (error) {
        this.report(extension, 'before_provider_request', error)
      }
    }
    return current
  }

  /** after_provider_response: awaited in order before the response is read; errors are logged. */
  async afterProviderResponse(
    session: VelaSession,
    headers: Record<string, string>,
  ): Promise<void> {
    const event: AfterProviderResponseEvent = {
      type: 'after_provider_response',
      headers,
    }
    const ctx = this.context(session)
    for (const { extension, fn } of this.list('after_provider_response')) {
      try {
        await fn(event, ctx)
      } catch (error) {
        this.report(extension, event.type, error)
      }
    }
  }

  /** provider_stream_event: a read-only notification like the VelaEvents (not awaited). */
  providerStreamEvent(session: VelaSession, event: ProviderStreamEvent): void {
    this.dispatch(event.type, event, session)
  }

  /**
   * tool_call: handlers mutate input in place or return `{ block }`. A throwing handler counts as a
   * block (as in pi: better not to run the tool).
   * The returned input is the same object as the one passed in when nothing changed.
   */
  private async toolCall(
    session: VelaSession,
    toolCallId: string | undefined,
    parentToolCallId: string | undefined,
    toolName: string,
    input: unknown,
  ): Promise<ToolCallEventResult & { input: unknown }> {
    const handlers = this.list('tool_call')
    if (!handlers.length) return { input }
    const before = JSON.stringify(input)
    const event = {
      type: 'tool_call' as const,
      toolCallId,
      ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
      toolName,
      input: structuredClone(input) as Record<string, unknown>,
    }
    const ctx = this.context(session)
    for (const { extension, fn } of handlers) {
      try {
        const result = (await fn(event, ctx)) as ToolCallEventResult | undefined
        if (result?.block) return { block: true, reason: result.reason, input }
      } catch (error) {
        this.report(extension, event.type, error)
        return {
          block: true,
          reason: `Extension ${extension} check failed: ${errorMessage(error)}`,
          input,
        }
      }
    }
    return {
      input: JSON.stringify(event.input) === before ? input : event.input,
    }
  }

  /** tool_result: a handler returns `{ output }` to replace the text the model sees; handlers chain. On error the previous result is kept. */
  private async toolResult(
    session: VelaSession,
    toolCallId: string | undefined,
    parentToolCallId: string | undefined,
    toolName: string,
    input: unknown,
    output: string,
  ): Promise<string> {
    const event = {
      type: 'tool_result' as const,
      toolCallId,
      ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
      toolName,
      input,
      output,
    }
    const ctx = this.context(session)
    for (const { extension, fn } of this.list('tool_result')) {
      try {
        const result = (await fn(event, ctx)) as
          | ToolResultEventResult
          | undefined
        if (typeof result?.output === 'string') event.output = result.output
      } catch (error) {
        this.report(extension, event.type, error)
      }
    }
    return event.output
  }

  /**
   * Runs `/name args` and returns true when it is an extension command; returns false otherwise
   * (the text goes to the model as normal input).
   * Only owner sessions can run commands: a `/xxx` from a channel sender is plain text.
   * `signal` is this command's own abort signal (ctx.signal).
   */
  async runCommand(
    session: VelaSession,
    text: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const match = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/)
    if (!match) return false
    await this.ready
    const entry = this.commandMap.get(match[1] ?? '')
    if (!entry || session.role !== 'owner') return false
    await entry.command.handler(
      (match[2] ?? '').trim(),
      this.context(session, signal),
    )
    return true
  }
}

/**
 * Copies messages for a `context` handler: a deep copy when the content can be cloned, otherwise copies of
 * each message and its parts (values inside a part, like a tool's JSON output, are then shared).
 */
function copyMessages(messages: ModelMessage[]): ModelMessage[] {
  try {
    return structuredClone(messages)
  } catch {
    return messages.map(
      (message) =>
        ({
          ...message,
          content: Array.isArray(message.content)
            ? message.content.map((part) => ({ ...part }))
            : message.content,
        }) as ModelMessage,
    )
  }
}
