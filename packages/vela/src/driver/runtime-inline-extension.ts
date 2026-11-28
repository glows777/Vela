import type { ProviderDefinition } from '../providers/models/index.ts'
import type { RuntimeEventBus } from '../runtime/event-bus.ts'
import { errorMessage } from '../shared/logger.ts'
import type { ExtensionEventName } from './extensions/events.ts'
import type {
  ExtensionAPI,
  ExtensionCommand,
  ExtensionContext,
  ExtensionSession,
  VelaExtension,
} from './extensions/types.ts'
import type { ModelMessage } from './messages.ts'
import type { SessionStore } from './session/index.ts'
import type { ToolDefinition, ToolRegistry } from './tools/registry.ts'

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
  private initError?: string
  private readonly tools: Array<{ tool: ToolDefinition; toolName: string }> = []
  private readonly deferredNamespaces = new Map<string, string>()
  private readonly providers = new Map<string, ProviderDefinition>()
  private readonly commands = new Map<string, ExtensionCommand>()
  private nextHandlerId = 1
  private readonly handlers = new Map<
    number,
    { event: ExtensionEventName; toolName?: string; fn: AnyHandler }
  >()
  private readonly unsubsByAttachment = new Map<
    ExtensionAPI,
    Map<number, () => void>
  >()
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
          this.subscribeOn(this.activeApi, id, entry)
        }
        return () => {
          this.handlers.delete(id)
          for (const unsubs of this.unsubsByAttachment.values()) {
            unsubs.get(id)?.()
            unsubs.delete(id)
          }
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
    this.unsubsByAttachment.clear()
    return errors
  }

  private subscribeOn(
    targetApi: ExtensionAPI,
    id: number,
    entry: { event: ExtensionEventName; toolName?: string; fn: AnyHandler },
  ): void {
    const unsub =
      entry.toolName !== undefined
        ? (
            targetApi as {
              on: (
                event: ExtensionEventName,
                toolName: string,
                fn: AnyHandler,
              ) => () => void
            }
          ).on(entry.event, entry.toolName, entry.fn)
        : targetApi.on(entry.event, entry.fn as never)
    let map = this.unsubsByAttachment.get(targetApi)
    if (!map) {
      map = new Map()
      this.unsubsByAttachment.set(targetApi, map)
    }
    map.set(id, unsub)
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
    if (!this.unsubsByAttachment.has(runnerApi)) {
      this.unsubsByAttachment.set(runnerApi, new Map())
    }
    // Drop unsubscribe callbacks once this host runner shuts down so retired snapshots are GC'd.
    runnerApi.onShutdown(() => {
      this.unsubsByAttachment.delete(runnerApi)
    })

    if (!this.initialized) {
      this.initialized = true
      try {
        const result = this.ext(this.proxyApi)
        if (result instanceof Promise) {
          this.initPromise = result
            .catch((error) => {
              this.initError = errorMessage(error)
              throw error
            })
            .finally(() => {
              this.initPromise = undefined
            })
          return this.initPromise
        }
        return
      } catch (error) {
        this.initError = errorMessage(error)
        throw error
      }
    }
    if (this.initPromise) {
      return this.initPromise
        .catch(() => {})
        .then(() => {
          this.activeApi = runnerApi
          this.replayTo(runnerApi)
          if (this.initError) throw new Error(this.initError)
        })
    }
    this.replayTo(runnerApi)
    if (this.initError) throw new Error(this.initError)
  }

  private replayTo(runnerApi: ExtensionAPI): void {
    for (const { tool } of this.tools) {
      runnerApi.registerTool(tool)
    }
    for (const [namespace, summaryLine] of this.deferredNamespaces) {
      runnerApi.registerDeferredNamespace?.(namespace, summaryLine)
    }
    for (const [commandName, command] of this.commands) {
      runnerApi.registerCommand(commandName, command)
    }
    for (const [id, entry] of this.handlers) {
      this.subscribeOn(runnerApi, id, entry)
    }
    for (const [providerName, provider] of this.providers) {
      runnerApi.registerProvider(providerName, provider)
    }
  }
}

/** Lightweight `ExtensionSession` view (with internal `registry`, `store`, and `buildSystem` for `ExtensionRunner`) used inside `VelaAgentDriver`. */
export function createExtensionSessionView(params: {
  sessionId: string
  cwd: string
  name?: string
  channel?: string
  messages: ModelMessage[]
  registry: ToolRegistry
  store: SessionStore
  eventBus?: RuntimeEventBus
  runId?: string
  projectId: string | null
  signal?: AbortSignal
  buildSystem?: (sections?: Record<string, string>) => string
  onNotify?: (message: string, level: 'info' | 'warning' | 'error') => void
  onSetActiveTools?: (names: string[] | undefined) => void
}): ExtensionSession & {
  registry: ToolRegistry
  store: SessionStore
  buildSystem(
    sections?: Record<string, string>,
    override?: string | null,
  ): string
  emit(event: unknown): void
} {
  return {
    id: params.sessionId,
    cwd: params.cwd,
    get name() {
      return params.name
    },
    get channel() {
      return params.channel
    },
    messages: params.messages,
    registry: params.registry,
    store: params.store,
    signal: params.signal,
    getActiveTools: () => params.registry.getActiveTools().map((t) => t.name),
    setActiveTools: (names: string[] | undefined) => {
      params.registry.setSelection(names)
      params.onSetActiveTools?.(names)
    },
    customMessageOf: (message: ModelMessage) => {
      const id = params.store.idOf(message)
      const entry = id ? params.store.getEntry(id) : undefined
      if (entry?.type !== 'custom_message') return undefined
      return {
        customType: entry.customType,
        display: entry.display,
        ...(entry.details === undefined ? {} : { details: entry.details }),
      }
    },
    buildSystem: (sections?: Record<string, string>) =>
      params.buildSystem?.(sections) ?? '',
    notify: (message: string, level: 'info' | 'warning' | 'error' = 'info') => {
      if (params.onNotify) {
        params.onNotify(message, level)
        return
      }
      params.eventBus?.append({
        sessionId: params.sessionId,
        projectId: params.projectId,
        runId: params.runId ?? null,
        payload: {
          type: 'notify',
          ...(params.runId ? { runId: params.runId } : {}),
          level,
          message,
        },
      })
    },
    emit: (event: unknown) => {
      if (
        typeof event === 'object' &&
        event !== null &&
        (event as { type?: unknown }).type === 'audit'
      ) {
        const audit = event as { toolName?: unknown; path?: unknown }
        if (
          typeof audit.toolName === 'string' &&
          typeof audit.path === 'string'
        ) {
          params.eventBus?.append({
            sessionId: params.sessionId,
            projectId: params.projectId,
            runId: params.runId ?? null,
            payload: {
              type: 'audit',
              ...(params.runId ? { runId: params.runId } : {}),
              toolName: audit.toolName,
              path: audit.path,
            },
          })
        }
      }
    },
  }
}
