import { basename, join, resolve } from 'node:path'
import type { VelaDatabase } from '../db/index.ts'
import type { ModelRegistry } from '../providers/models/index.ts'
import type { RuntimeEventBus } from '../runtime/event-bus.ts'
import type { MemoryStore } from '../runtime/memory/index.ts'
import { errorMessage, type VelaLogger } from '../shared/logger.ts'
import type { ModelPricing } from '../shared/pricing.ts'
import type { ModelInput } from '../shared/provider-types.ts'
import {
  discoverExtensions,
  type ExtensionEntry,
  extensionName,
  resolveExtensionEntries,
} from './config/extension-discovery.ts'
import { importExtension } from './config/extensions.ts'
import type { ExecutionEnv } from './execution/types.ts'
import { auditLog } from './extensions/audit.ts'
import { tasks as formatTasksCommand } from './extensions/background/tasks.ts'
import { ExtensionRunner, type LoadedExtension } from './extensions/runner.ts'
import type { VelaExtension } from './extensions/types.ts'
import type { MemoryDream } from './memory/dream.ts'
import type { ModelMessage } from './messages.ts'
import type { RuntimeBackgroundController } from './runtime-background.ts'
import { resolveRuntimeDream } from './runtime-dream.ts'
import type { SessionStore } from './session/index.ts'
import { ToolRegistry } from './tools/registry.ts'
import type { TokenTracker } from './usage/tracker.ts'
import type { VelaSession } from './vela-session.ts'

export const BUILTIN_NATIVE_EXTENSIONS = new Set([
  'background',
  'memory',
  'web',
  'todo',
  'mcp',
  'lark',
])

export const NATIVE_COMMANDS: ReadonlyArray<{
  name: string
  description: string
  source: 'builtin'
}> = [
  {
    name: 'memory',
    description:
      'List memories; /memory search <keywords> to search, /memory lint to check',
    source: 'builtin',
  },
  {
    name: 'dream',
    description:
      'Consolidate memory against recent conversations in an isolated model call',
    source: 'builtin',
  },
  {
    name: 'tasks',
    description:
      'List this session’s background tasks; /tasks stop <id> ends one',
    source: 'builtin',
  },
  {
    name: 'bashes',
    description:
      'List this session’s background tasks; /tasks stop <id> ends one',
    source: 'builtin',
  },
]

function lintReport(store: MemoryStore): string {
  const reports = store.lint()
  if (reports.length === 0)
    return '[lint] Memory store is healthy; no issues found.'
  const lines = [`[lint] ${reports.length} memories with warnings:`]
  for (const r of reports) {
    lines.push(
      `  📁 ${r.entry.filePath.split('/').pop()}  [${r.entry.type}] ${r.entry.name}`,
    )
    for (const issue of r.issues)
      lines.push(`     • ${issue.kind}: ${issue.message}`)
  }
  return lines.join('\n')
}

function searchReport(store: MemoryStore, query: string): string {
  const results = store.search(query, 5)
  if (results.length === 0)
    return `[memory search] No memories found for "${query}".`
  return [
    `[BM25 search] "${query}" → ${results.length} results:`,
    ...results.map(
      (h) =>
        `  [score=${h.score.toFixed(2)}] [${h.entry.type}] ${h.entry.name} (${basename(h.entry.filePath)}) — ${h.entry.description}`,
    ),
  ].join('\n')
}

export async function runNativeRuntimeCommand(options: {
  name: string
  args: string
  db: VelaDatabase
  memoryActive: boolean
  memoryStore: MemoryStore
  activeDreams: Map<string, MemoryDream>
  projectId: string | null
  sessionId: string
  resolvedModel?: { model: ModelInput; cost?: ModelPricing }
  tracker?: TokenTracker
  resolveEnv: () => Promise<ExecutionEnv>
  background?: RuntimeBackgroundController
  setCacheEnabled?: (enabled: boolean) => void
  signal: AbortSignal
  notify: (message: string, level?: 'info' | 'warning' | 'error') => void
}): Promise<boolean> {
  const { name, args, notify } = options
  if (name === 'memory') {
    if (!options.memoryActive) {
      notify('Memory is not enabled for this session.')
      return true
    }
    const local = options.memoryStore
    if (args === 'lint') {
      notify(lintReport(local))
      return true
    }
    if (args.startsWith('search ')) {
      notify(searchReport(local, args.slice('search '.length).trim()))
      return true
    }
    const entries = local.list()
    const reports = local.lint()
    const dream = resolveRuntimeDream({
      db: options.db,
      activeDreams: options.activeDreams,
      localStore: local,
      projectId: options.projectId,
    })
    const lines = [
      `[memory] ${entries.length} memories, ${reports.length} with warnings`,
      dream.status(),
      ...local.indexWarnings(),
    ]
    for (const e of entries) {
      const flag = reports.some((r) => r.entry.filePath === e.filePath)
        ? '⚠️ '
        : '   '
      lines.push(
        `${flag} [${e.type}] ${e.name} (${basename(e.filePath)}) — ${e.description}`,
      )
    }
    notify(lines.join('\n'))
    return true
  }

  if (name === 'dream') {
    if (!options.memoryActive) {
      notify('Memory is not enabled for this session.')
      return true
    }
    if (!options.resolvedModel) {
      notify('[dream] Failed: No model configured for this session.', 'error')
      return true
    }
    notify('[dream] Starting memory consolidation...')
    try {
      const dream = resolveRuntimeDream({
        db: options.db,
        activeDreams: options.activeDreams,
        localStore: options.memoryStore,
        projectId: options.projectId,
      })
      const report = await dream.run(
        {
          sessionId: options.sessionId,
          model: options.resolvedModel.model,
          pricing: options.resolvedModel.cost,
          checkPath: async (candidate) => {
            if (options.signal.aborted) return false
            const env = await options.resolveEnv()
            const abs = await env.absolutePath(candidate, options.signal)
            if (!abs.ok) return false
            const exists = await env.exists(abs.value, options.signal)
            return exists.ok && exists.value
          },
          recordUsage: (modelId, usage, meta, pricing) =>
            options.tracker?.record(modelId, usage, meta, pricing),
        },
        options.signal,
      )
      notify(report)
    } catch (error) {
      if (options.signal.aborted) throw error
      notify(
        `[dream] Failed: ${error instanceof Error ? error.message : String(error)}. Inbox retained.`,
      )
    }
    return true
  }

  if (name === 'tasks' || name === 'bashes') {
    if (!options.background) {
      notify('Background commands require an open session', 'error')
      return true
    }
    try {
      notify(await formatTasksCommand(args, options.background))
    } catch (error) {
      notify(errorMessage(error), 'error')
    }
    return true
  }

  if (name === 'cache' && (args === 'on' || args === 'off')) {
    const on = args === 'on'
    if (!options.setCacheEnabled) {
      notify(
        'Cache simulation only works with the demo model (VELA_MODEL=mock)',
      )
      return true
    }
    options.setCacheEnabled(on)
    notify(on ? 'Cache simulation on' : 'Cache simulation off')
    return true
  }

  return false
}

function wrapReportedExtension(
  extension: VelaExtension,
  onError: (msg: string) => void,
  key: string,
): VelaExtension {
  const { name } = extension
  return {
    [name]: (vela: Parameters<VelaExtension>[0]) => {
      try {
        const res = extension(vela)
        if (res instanceof Promise) {
          return res.catch((error) => {
            onError(
              `[extensions] Failed to load ${key}: ${errorMessage(error)}`,
            )
          })
        }
      } catch (error) {
        onError(`[extensions] Failed to load ${key}: ${errorMessage(error)}`)
      }
    },
  }[name] as VelaExtension
}

async function loadExtensionEntries(options: {
  entries: ExtensionEntry[]
  onError: (msg: string) => void
  onBeforeImport?: () => Promise<void> | void
}): Promise<VelaExtension[]> {
  if (options.entries.length === 0) return []
  await options.onBeforeImport?.()
  const loaded: VelaExtension[] = []
  const seen = new Set<string>()
  for (const entry of options.entries) {
    if ('builtin' in entry) continue
    const key = resolve(entry.path)
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const ext = await importExtension(key, entry.name)
      loaded.push(wrapReportedExtension(ext, options.onError, key))
    } catch (error) {
      options.onError(
        `[extensions] Failed to load ${key}: ${errorMessage(error)}`,
      )
    }
  }
  return loaded
}

function resolveNonBuiltinExtensionEntries(
  configured: readonly string[],
  discoveredDir: string,
): {
  entries: ExtensionEntry[]
  disabledBuiltins: Set<string>
  errors: string[]
} {
  const disabledBuiltins = new Set<string>()
  const fileEntries: string[] = []
  const errors: string[] = []
  for (const raw of configured) {
    const m = /^([+-]?)builtin:(.+)$/.exec(raw)
    if (m) {
      const name = m[2]!
      if (m[1] === '-') {
        disabledBuiltins.add(name)
      } else {
        disabledBuiltins.delete(name)
      }
      if (
        !BUILTIN_NATIVE_EXTENSIONS.has(name) &&
        !(m[1] === '-' && name === 'rag')
      ) {
        errors.push(`Unknown built-in extension builtin:${name}`)
      }
      continue
    }
    fileEntries.push(raw)
  }
  let entries: ExtensionEntry[] = []
  try {
    entries = resolveExtensionEntries(
      fileEntries,
      discoverExtensions(discoveredDir),
      [],
      [],
    )
  } catch (error) {
    errors.push(`[extensions] ${errorMessage(error)}`)
  }
  return { entries, disabledBuiltins, errors }
}

export class RuntimeExtensionHost {
  readonly hostRegistry = new ToolRegistry(undefined)
  private hostRunner?: ExtensionRunner
  private hostErrors: string[] = []
  private disabledBuiltins = new Set<string>()
  private loadPromise: Promise<void> = Promise.resolve()

  constructor(
    private readonly deps: {
      agentDir: string
      models: ModelRegistry
      logger: VelaLogger
      onBeforeImport?: () => Promise<void> | void
    },
  ) {}

  reload(options: {
    configured?: readonly string[]
    extensionConfig: Record<string, Record<string, unknown>>
  }): Promise<void> {
    const previous = this.hostRunner
    this.hostErrors = []
    this.disabledBuiltins = new Set()
    const resolved = resolveNonBuiltinExtensionEntries(
      options.configured ?? [],
      join(this.deps.agentDir, 'extensions'),
    )
    this.disabledBuiltins = resolved.disabledBuiltins
    for (const err of resolved.errors) {
      this.hostErrors.push(err)
      this.deps.logger.error(err)
    }

    const runLoad = (async () => {
      if (previous) {
        await previous.shutdown().catch(() => {})
      }
      // Clear previous host-registered tools before reloading
      for (const tool of this.hostRegistry.getAllTools()) {
        this.hostRegistry.unregister(tool.name)
      }
      const factories = await loadExtensionEntries({
        entries: resolved.entries,
        onBeforeImport: this.deps.onBeforeImport,
        onError: (msg) => {
          this.hostErrors.push(msg)
          this.deps.logger.error(msg)
        },
      })
      const runner = new ExtensionRunner(
        {
          cwd: this.deps.agentDir,
          dataDir: this.deps.agentDir,
          extensionConfig: options.extensionConfig,
          logger: this.deps.logger,
          registry: this.hostRegistry,
          models: this.deps.models,
        },
        factories,
      )
      this.hostRunner = runner
      await runner.ready.catch(() => {})
    })()

    this.loadPromise = runLoad
    return runLoad
  }

  async ready(): Promise<void> {
    await this.loadPromise
  }

  get errors(): string[] {
    return [...this.hostErrors]
  }

  getDisabledBuiltins(): ReadonlySet<string> {
    return this.disabledBuiltins
  }

  async createSessionRunner(options: {
    cwd: string
    trusted: boolean
    projectExtensions: readonly string[]
    extraExtensions: readonly string[]
    noExtensions: boolean
    extensionConfig: Record<string, Record<string, unknown>>
    registry: ToolRegistry
  }): Promise<{
    runner: ExtensionRunner
    errors: string[]
  }> {
    await this.ready()
    const sessionErrors: string[] = []
    const entries: ExtensionEntry[] = []
    const recordError = (msg: string) => {
      sessionErrors.push(msg)
      this.deps.logger.error(msg)
    }
    if (!options.noExtensions) {
      const projectDir = join(options.cwd, '.vela')
      if (
        options.trusted &&
        resolve(projectDir) !== resolve(this.deps.agentDir)
      ) {
        const res = resolveNonBuiltinExtensionEntries(
          options.projectExtensions,
          join(projectDir, 'extensions'),
        )
        for (const err of res.errors) recordError(err)
        entries.push(...res.entries)
      }
    }
    for (const source of options.extraExtensions) {
      const builtin = /^builtin:(.+)$/.exec(source)?.[1]
      if (builtin) {
        if (!BUILTIN_NATIVE_EXTENSIONS.has(builtin)) {
          recordError(
            `[extensions] Failed to load builtin:${builtin}: Unknown built-in extension builtin:${builtin}`,
          )
        }
        continue
      }
      try {
        for (const path of discoverExtensions(resolve(source), true)) {
          entries.push({ name: extensionName(path), path })
        }
      } catch (error) {
        recordError(
          `[extensions] Failed to load ${resolve(source)}: ${errorMessage(error)}`,
        )
      }
    }
    const factories = await loadExtensionEntries({
      entries,
      onBeforeImport: this.deps.onBeforeImport,
      onError: recordError,
    })
    const runner = new ExtensionRunner(
      {
        cwd: options.cwd,
        dataDir: this.deps.agentDir,
        extensionConfig: options.extensionConfig,
        logger: this.deps.logger,
        registry: options.registry,
        models: this.deps.models,
        parent: options.noExtensions ? undefined : this.hostRunner,
      },
      factories.concat(auditLog),
    )
    await runner.ready.catch(() => {})
    return {
      runner,
      errors: options.noExtensions
        ? sessionErrors
        : [...this.hostErrors, ...sessionErrors],
    }
  }

  loadedHost(): LoadedExtension[] {
    return this.hostRunner?.loaded() ?? []
  }

  async shutdown(): Promise<void> {
    await this.loadPromise.catch(() => {})
    await this.hostRunner?.shutdown().catch(() => {})
    this.hostRunner = undefined
  }
}

/** Lightweight `VelaSession`-compatible view passed to extension hooks & slash commands inside `VelaAgentDriver`. */
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
}): VelaSession {
  const view = {
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
  return view as unknown as VelaSession
}
