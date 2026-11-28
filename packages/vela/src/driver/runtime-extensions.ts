import { basename, join, resolve } from 'node:path'
import type { VelaDatabase } from '../db/index.ts'
import type { ModelRegistry } from '../providers/models/index.ts'
import type { MemoryStore } from '../runtime/memory/index.ts'
import { errorMessage, type VelaLogger } from '../shared/logger.ts'
import type { ModelPricing } from '../shared/pricing.ts'
import type { ModelInput } from '../shared/provider-types.ts'
import {
  discoverExtensions,
  type ExtensionEntry,
  extensionName,
} from './config/extension-discovery.ts'
import { importExtension } from './config/extensions.ts'
import type { ExecutionEnv } from './execution/types.ts'
import { auditLog } from './extensions/audit.ts'
import { tasks as formatTasksCommand } from './extensions/background/tasks.ts'
import { ExtensionRunner, type LoadedExtension } from './extensions/runner.ts'
import type { VelaExtension } from './extensions/types.ts'
import type { MemoryDream } from './memory/dream.ts'
import type { RuntimeBackgroundController } from './runtime-background.ts'
import { resolveRuntimeDream } from './runtime-dream.ts'
import {
  createExtensionSessionView,
  PersistentInlineExtension,
} from './runtime-inline-extension.ts'
import { ToolRegistry } from './tools/registry.ts'
import type { TokenTracker } from './usage/tracker.ts'

export { createExtensionSessionView }

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
  const paths: string[] = []
  try {
    paths.push(...discoverExtensions(discoveredDir))
  } catch (error) {
    errors.push(
      `[extensions] Failed to scan ${discoveredDir}: ${errorMessage(error)}`,
    )
  }
  for (const raw of fileEntries) {
    try {
      paths.push(...discoverExtensions(raw, true))
    } catch (error) {
      errors.push(`[extensions] ${errorMessage(error)}`)
    }
  }
  const entries: ExtensionEntry[] = [...new Set(paths)].map((path) => ({
    name: extensionName(path),
    path,
  }))
  return { entries, disabledBuiltins, errors }
}

export function resolveEffectiveDisabledBuiltins(options: {
  hostDisabled: ReadonlySet<string>
  projectExtensions?: readonly string[]
  extraExtensions?: readonly string[]
  noExtensions?: boolean
}): ReadonlySet<string> {
  const disabled = options.noExtensions
    ? new Set(BUILTIN_NATIVE_EXTENSIONS)
    : new Set(options.hostDisabled)

  const applyList = (list: readonly string[] | undefined) => {
    if (!list) return
    for (const raw of list) {
      const m = /^([+-]?)builtin:(.+)$/.exec(raw)
      if (!m) continue
      const name = m[2]!
      if (m[1] === '-') {
        disabled.add(name)
      } else {
        disabled.delete(name)
      }
    }
  }

  if (!options.noExtensions) {
    applyList(options.projectExtensions)
  }
  applyList(options.extraExtensions)
  return disabled
}

export interface HostExtensionSnapshot {
  readonly generation: number
  readonly registry: ToolRegistry
  readonly errors: readonly string[]
  readonly disabledBuiltins: ReadonlySet<string>
  readonly runner?: ExtensionRunner
  refs: number
  superseded: boolean
}

export class RuntimeExtensionHost {
  private generation = 0
  private current: HostExtensionSnapshot = {
    generation: 0,
    registry: new ToolRegistry(undefined),
    errors: [],
    disabledBuiltins: new Set(),
    refs: 0,
    superseded: false,
  }
  private readonly retiredSnapshots = new Set<HostExtensionSnapshot>()
  private readonly pendingShutdowns = new Set<Promise<void>>()
  private readonly inlineSlots = new Map<number, PersistentInlineExtension>()
  private loadPromise: Promise<void> = Promise.resolve()

  constructor(
    private readonly deps: {
      agentDir: string
      models: ModelRegistry
      logger: VelaLogger
      onBeforeImport?: () => Promise<void> | void
    },
  ) {}

  private startRunnerShutdown(
    runner: ExtensionRunner | undefined,
  ): Promise<void> {
    if (!runner) return Promise.resolve()
    let tracked!: Promise<void>
    tracked = runner
      .shutdown()
      .catch(() => {})
      .finally(() => {
        this.pendingShutdowns.delete(tracked)
      })
    this.pendingShutdowns.add(tracked)
    return tracked
  }

  unregisterExtensionProviders(): void {
    const loaded = this.current.runner?.loaded() ?? []
    for (const ext of loaded) {
      for (const providerName of ext.providers) {
        this.deps.models?.unregister(providerName)
      }
    }
  }

  reload(options: {
    configured?: readonly string[]
    explicit?: readonly (string | VelaExtension)[]
    extensionConfig: Record<string, Record<string, unknown>>
    unregisterProviders?: boolean
  }): Promise<void> {
    const errors: string[] = []
    const resolvedOwner = resolveNonBuiltinExtensionEntries(
      options.configured ?? [],
      join(this.deps.agentDir, 'extensions'),
    )
    const disabledBuiltins = new Set(resolvedOwner.disabledBuiltins)
    for (const err of resolvedOwner.errors) {
      errors.push(err)
      this.deps.logger.error(err)
    }

    const explicit = options.explicit ?? []
    const hasExplicitStrings = explicit.some(
      (item) => typeof item === 'string' && !/^[+-]?builtin:/.test(item),
    )

    const prevLoad = this.loadPromise
    const runLoad = prevLoad
      .catch(() => {})
      .then(async () => {
        if (options.unregisterProviders !== false) {
          this.unregisterExtensionProviders()
        }
        const nextRegistry = new ToolRegistry(undefined)
        const recordLoadError = (msg: string) => {
          errors.push(msg)
          this.deps.logger.error(msg)
        }
        if (resolvedOwner.entries.length > 0 || hasExplicitStrings) {
          await this.deps.onBeforeImport?.()
        }
        const seenPaths = new Set<string>()
        const factories: VelaExtension[] = []
        for (const entry of resolvedOwner.entries) {
          if ('builtin' in entry) continue
          const key = resolve(entry.path)
          if (seenPaths.has(key)) continue
          seenPaths.add(key)
          try {
            const ext = await importExtension(key, entry.name)
            factories.push(wrapReportedExtension(ext, recordLoadError, key))
          } catch (error) {
            recordLoadError(
              `[extensions] Failed to load ${key}: ${errorMessage(error)}`,
            )
          }
        }
        for (const [idx, item] of explicit.entries()) {
          if (typeof item === 'function') {
            let slot = this.inlineSlots.get(idx)
            if (!slot) {
              slot = new PersistentInlineExtension(item, `inline#${idx + 1}`)
              this.inlineSlots.set(idx, slot)
            }
            factories.push(
              wrapReportedExtension(
                slot.asFactory(),
                recordLoadError,
                slot.name,
              ),
            )
            continue
          }
          const builtin = /^([+-]?)builtin:(.+)$/.exec(item)
          if (builtin) {
            const name = builtin[2]!
            if (builtin[1] === '-') {
              disabledBuiltins.add(name)
            } else {
              disabledBuiltins.delete(name)
            }
            if (
              !BUILTIN_NATIVE_EXTENSIONS.has(name) &&
              !(builtin[1] === '-' && name === 'rag')
            ) {
              recordLoadError(
                `[extensions] Unknown built-in extension builtin:${name}`,
              )
            }
            continue
          }
          try {
            const discovered = discoverExtensions(item, true)
            for (const path of discovered) {
              const key = resolve(path)
              if (seenPaths.has(key)) continue
              seenPaths.add(key)
              try {
                const ext = await importExtension(key, extensionName(key))
                factories.push(wrapReportedExtension(ext, recordLoadError, key))
              } catch (error) {
                recordLoadError(
                  `[extensions] Failed to load ${key}: ${errorMessage(error)}`,
                )
              }
            }
          } catch (error) {
            recordLoadError(`[extensions] ${errorMessage(error)}`)
          }
        }
        const runner = new ExtensionRunner(
          {
            cwd: this.deps.agentDir,
            dataDir: this.deps.agentDir,
            extensionConfig: options.extensionConfig,
            logger: this.deps.logger,
            registry: nextRegistry,
            models: this.deps.models,
          },
          factories,
        )
        await runner.ready.catch(() => {})
        const previous = this.current
        previous.superseded = true
        this.current = {
          generation: ++this.generation,
          registry: nextRegistry,
          runner,
          errors,
          disabledBuiltins,
          refs: 0,
          superseded: false,
        }
        if (previous.runner) {
          if (previous.refs === 0) {
            await this.startRunnerShutdown(previous.runner)
          } else {
            this.retiredSnapshots.add(previous)
          }
        }
      })

    this.loadPromise = runLoad
    return runLoad
  }

  async ready(): Promise<void> {
    await this.loadPromise
  }

  get errors(): string[] {
    return [...this.current.errors]
  }

  getDisabledBuiltins(): ReadonlySet<string> {
    return this.current.disabledBuiltins
  }

  async acquireHostSnapshot(): Promise<{
    snapshot: HostExtensionSnapshot
    release: () => void
  }> {
    await this.ready()
    const snapshot = this.current
    snapshot.refs += 1
    let released = false
    return {
      snapshot,
      release: () => {
        if (released) return
        released = true
        snapshot.refs = Math.max(0, snapshot.refs - 1)
        if (snapshot.superseded && snapshot.refs === 0) {
          this.retiredSnapshots.delete(snapshot)
          void this.startRunnerShutdown(snapshot.runner)
        }
      },
    }
  }

  async createSessionRunner(options: {
    cwd: string
    trusted: boolean
    isLocalLocation: boolean
    projectExtensions: readonly string[]
    extraExtensions: readonly string[]
    noExtensions: boolean
    extensionConfig: Record<string, Record<string, unknown>>
    registry: ToolRegistry
    hostSnapshot: HostExtensionSnapshot
  }): Promise<{
    runner: ExtensionRunner
    errors: string[]
  }> {
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
        options.isLocalLocation &&
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
      const builtin = /^([+-]?)builtin:(.+)$/.exec(source)
      if (builtin) {
        const name = builtin[2]!
        if (
          !BUILTIN_NATIVE_EXTENSIONS.has(name) &&
          !(builtin[1] === '-' && name === 'rag')
        ) {
          recordError(
            `[extensions] Failed to load ${source}: Unknown built-in extension builtin:${name}`,
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
        parent: options.noExtensions ? undefined : options.hostSnapshot.runner,
      },
      factories,
      [auditLog],
    )
    await runner.ready.catch(() => {})
    return {
      runner,
      errors: options.noExtensions
        ? sessionErrors
        : [...options.hostSnapshot.errors, ...sessionErrors],
    }
  }

  loadedHost(): LoadedExtension[] {
    return this.current.runner?.loaded() ?? []
  }

  async shutdown(): Promise<void> {
    await this.loadPromise.catch(() => {})
    const currentRunner = this.current.runner
    this.current = {
      generation: this.generation,
      registry: new ToolRegistry(undefined),
      errors: [],
      disabledBuiltins: new Set(),
      refs: 0,
      superseded: true,
    }
    void this.startRunnerShutdown(currentRunner)
    for (const retired of this.retiredSnapshots) {
      void this.startRunnerShutdown(retired.runner)
    }
    this.retiredSnapshots.clear()
    while (this.pendingShutdowns.size > 0) {
      await Promise.allSettled([...this.pendingShutdowns])
    }
    for (const slot of this.inlineSlots.values()) {
      for (const msg of await slot.shutdown()) {
        this.deps.logger.error(msg)
      }
    }
    this.inlineSlots.clear()
  }
}
