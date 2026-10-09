import type { VelaEvent } from '../agent/events.ts'
import type { ChannelGateway } from '../channels/gateway.ts'
import { errorMessage, type VelaLogger } from '../logger.ts'
import type { ModelRegistry } from '../models/index.ts'
import type { HookPipeline } from '../security/hooks.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { VelaSession } from '../vela-session.ts'
import type {
  ExtensionAPI,
  ExtensionCommand,
  ExtensionContext,
  ExtensionEventName,
  ExtensionHandler,
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

  /** Read-only notification: handlers are not awaited and errors are logged. tool_call / tool_result go through the intercepting versions. */
  notify(event: VelaEvent, session: VelaSession): void {
    if (event.type === 'tool_call' || event.type === 'tool_result') return
    const handlers = this.list(event.type)
    if (!handlers.length) return
    const ctx = this.context(session)
    for (const { extension, fn } of handlers) {
      try {
        const result = fn(event, ctx)
        if (result instanceof Promise)
          result.catch((error) => this.report(extension, event.type, error))
      } catch (error) {
        this.report(extension, event.type, error)
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

  /** before_agent_start: collect this turn's system prompt sections. */
  async beforeAgentStart(
    session: VelaSession,
    prompt: string,
  ): Promise<Record<string, string>> {
    const event = { type: 'before_agent_start' as const, prompt, sections: {} }
    const ctx = this.context(session)
    for (const { extension, fn } of this.list('before_agent_start')) {
      try {
        await fn(event, ctx)
      } catch (error) {
        this.report(extension, event.type, error)
      }
    }
    return event.sections
  }

  /**
   * tool_call: handlers mutate input in place or return `{ block }`. A throwing handler counts as a
   * block (as in pi: better not to run the tool).
   * The returned input is the same object as the one passed in when nothing changed.
   */
  private async toolCall(
    session: VelaSession,
    toolCallId: string | undefined,
    toolName: string,
    input: unknown,
  ): Promise<ToolCallEventResult & { input: unknown }> {
    const handlers = this.list('tool_call')
    if (!handlers.length) return { input }
    const before = JSON.stringify(input)
    const event = {
      type: 'tool_call' as const,
      toolCallId,
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
    toolName: string,
    input: unknown,
    output: string,
  ): Promise<string> {
    const event = {
      type: 'tool_result' as const,
      toolCallId,
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
