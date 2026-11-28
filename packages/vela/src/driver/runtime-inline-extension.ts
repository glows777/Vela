import type { ProviderDefinition } from '../providers/models/index.ts'
import { errorMessage } from '../shared/logger.ts'
import type { ExtensionEventName } from './extensions/events.ts'
import type {
  ExtensionAPI,
  ExtensionCommand,
  ExtensionContext,
  VelaExtension,
} from './extensions/types.ts'
import type { ToolDefinition } from './tools/registry.ts'

type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown

/**
 * Wraps an inline `VelaExtension` so its user factory executes once per runtime lifetime,
 * preserving closure state across owner-config reloads while replaying its registrations into each
 * new `ExtensionRunner` in caller order. Shutdown handlers run once on runtime disposal.
 */
export class PersistentInlineExtension {
  readonly name: string
  private activeApi?: ExtensionAPI
  private initialized = false
  private initPromise?: Promise<void>
  private readonly tools: Array<{ tool: ToolDefinition; toolName: string }> = []
  private readonly deferredNamespaces = new Map<string, string>()
  private readonly providers = new Map<string, ProviderDefinition>()
  private readonly commands = new Map<string, ExtensionCommand>()
  private nextHandlerId = 1
  private readonly handlers = new Map<
    number,
    { event: ExtensionEventName; toolName?: string; fn: AnyHandler }
  >()
  private activeUnsubs = new Map<number, () => void>()
  private readonly shutdownHandlers: Array<() => void | Promise<void>> = []
  private readonly proxyApi: ExtensionAPI

  constructor(
    private readonly ext: VelaExtension,
    fallbackName: string,
  ) {
    this.name = ext.name || fallbackName
    const self = this
    this.proxyApi = {
      get cwd() {
        return self.requireApi().cwd
      },
      get dataDir() {
        return self.requireApi().dataDir
      },
      get config() {
        return self.requireApi().config
      },
      get logger() {
        return self.requireApi().logger
      },
      registerProvider: (providerName, provider) => {
        const api = this.requireApi()
        api.registerProvider(providerName, provider)
        this.providers.set(providerName, provider)
      },
      registerTool: (tool) => {
        const toolName = this.requireApi().registerTool(tool)
        const existingIdx = this.tools.findIndex((t) => t.toolName === toolName)
        if (existingIdx >= 0) {
          this.tools[existingIdx] = { tool, toolName }
        } else {
          this.tools.push({ tool, toolName })
        }
        return toolName
      },
      unregisterTool: (toolName) => {
        const idx = this.tools.findIndex((t) => t.toolName === toolName)
        if (idx >= 0) this.tools.splice(idx, 1)
        return this.activeApi?.unregisterTool(toolName) ?? idx >= 0
      },
      registerDeferredNamespace: (namespace, summaryLine) => {
        this.deferredNamespaces.set(namespace, summaryLine)
        this.activeApi?.registerDeferredNamespace?.(namespace, summaryLine)
      },
      onShutdown: (handler) => {
        this.shutdownHandlers.push(handler)
      },
      registerCommand: (commandName, command) => {
        this.requireApi().registerCommand(commandName, command)
        this.commands.set(commandName, command)
      },
      on: ((
        event: ExtensionEventName,
        handlerOrName: AnyHandler | string,
        scopedHandler?: AnyHandler,
      ) => {
        const id = this.nextHandlerId++
        const toolName =
          typeof handlerOrName === 'string' ? handlerOrName : undefined
        const fn =
          typeof handlerOrName === 'string' ? scopedHandler! : handlerOrName
        const entry = {
          event,
          ...(toolName !== undefined ? { toolName } : {}),
          fn,
        }
        this.handlers.set(id, entry)
        if (this.activeApi) {
          const unsub =
            toolName !== undefined
              ? (
                  this.activeApi as {
                    on: (
                      event: ExtensionEventName,
                      toolName: string,
                      fn: AnyHandler,
                    ) => () => void
                  }
                ).on(event, toolName, fn)
              : this.activeApi.on(event, fn as never)
          this.activeUnsubs.set(id, unsub)
        }
        return () => {
          this.handlers.delete(id)
          this.activeUnsubs.get(id)?.()
          this.activeUnsubs.delete(id)
        }
      }) as ExtensionAPI['on'],
    }
  }

  asFactory(): VelaExtension {
    const { name } = this
    return {
      [name]: (runnerApi: ExtensionAPI) => this.attach(runnerApi),
    }[name] as VelaExtension
  }

  async shutdown(): Promise<string[]> {
    const errors: string[] = []
    for (const handler of this.shutdownHandlers) {
      try {
        await handler()
      } catch (error) {
        errors.push(
          `[extension:${this.name}] Shutdown handler failed: ${errorMessage(error)}`,
        )
      }
    }
    this.shutdownHandlers.length = 0
    this.activeApi = undefined
    this.activeUnsubs.clear()
    return errors
  }

  private requireApi(): ExtensionAPI {
    if (!this.activeApi) {
      throw new Error(
        `Extension "${this.name}" attempted registration outside an active host`,
      )
    }
    return this.activeApi
  }

  private attach(runnerApi: ExtensionAPI): void | Promise<void> {
    this.activeApi = runnerApi
    if (!this.initialized) {
      this.initialized = true
      const result = this.ext(this.proxyApi)
      if (result instanceof Promise) {
        this.initPromise = result.finally(() => {
          this.initPromise = undefined
        })
        return this.initPromise
      }
      return
    }
    if (this.initPromise) {
      return this.initPromise
        .catch(() => {})
        .then(() => {
          this.activeApi = runnerApi
          this.replayTo(runnerApi)
        })
    }
    this.replayTo(runnerApi)
  }

  private replayTo(runnerApi: ExtensionAPI): void {
    this.activeUnsubs.clear()
    for (const { tool } of this.tools) {
      runnerApi.registerTool(tool)
    }
    for (const [namespace, summaryLine] of this.deferredNamespaces) {
      runnerApi.registerDeferredNamespace?.(namespace, summaryLine)
    }
    for (const [providerName, provider] of this.providers) {
      runnerApi.registerProvider(providerName, provider)
    }
    for (const [commandName, command] of this.commands) {
      runnerApi.registerCommand(commandName, command)
    }
    for (const [id, entry] of this.handlers) {
      const unsub =
        entry.toolName !== undefined
          ? (
              runnerApi as {
                on: (
                  event: ExtensionEventName,
                  toolName: string,
                  fn: AnyHandler,
                ) => () => void
              }
            ).on(entry.event, entry.toolName, entry.fn)
          : runnerApi.on(entry.event, entry.fn as never)
      this.activeUnsubs.set(id, unsub)
    }
  }
}
