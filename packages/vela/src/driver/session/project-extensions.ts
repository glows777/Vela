import type { ModelRegistry } from '../../providers/models/index.ts'
import type { VelaLogger } from '../../shared/logger.ts'
import { importExtension } from '../config/extensions.ts'
import { loadProjectExtensionEntries } from '../config/project-extensions.ts'
import type { ConfigResourceSplit } from '../config/runtime-resources.ts'
import type { ExecutionEnv } from '../execution/types.ts'
import { ExtensionRunner } from '../extensions/runner.ts'
import type { ExtensionAPI, VelaExtension } from '../extensions/types.ts'
import {
  type ForegroundBudget,
  resolveForegroundBudget,
  setForegroundBudget,
} from '../tools/foreground-budget.ts'
import { ToolRegistry } from '../tools/registry.ts'
import type { VelaSession } from '../vela-session.ts'
import type { ProjectConfig } from './project-config.ts'

interface Scope {
  budget: ForegroundBudget
  runner: ExtensionRunner
  registry: ToolRegistry
}
interface SharedScope {
  ready: Promise<Scope>
  sessions: Set<string>
}

/** Prepared project instances; no per-turn loading and no host registration mutation. */
export class ProjectExtensions {
  private readonly sessions = new Map<string, Promise<SharedScope>>()
  private readonly scopes = new Map<string, SharedScope>()

  constructor(
    private readonly deps: {
      split?: ConfigResourceSplit
      config: ProjectConfig
      host: ExtensionRunner
      registry: ToolRegistry
      models: ModelRegistry
      dataDir: string
      logger: VelaLogger
    },
  ) {}

  select(
    id: string | undefined,
    open: ReadonlyMap<string, VelaSession>,
    key: string,
  ): ExtensionRunner {
    if (id !== undefined && !open.has(id))
      throw new Error(`Session ${id} is not open`)
    return this.runner(key)
  }

  runner(id: string): ExtensionRunner {
    return this.bound.get(id)?.runner ?? this.deps.host
  }

  private readonly bound = new Map<string, Scope>()

  bind(key: string, registry: ToolRegistry) {
    const scope = this.bound.get(key)
    if (scope) {
      setForegroundBudget(registry, scope.budget)
      registry.bindScope(scope.registry)
    } else registry.bindScope(this.deps.registry)
  }

  async prepare(id: string, env: ExecutionEnv): Promise<void> {
    if (!this.deps.split) return
    let pending = this.sessions.get(id)
    if (!pending) {
      pending = this.acquire(id, env)
      this.sessions.set(id, pending)
    }
    const shared = await pending
    const scope = await shared.ready
    if (this.sessions.get(id) !== pending)
      throw new Error('Session is closed or relocated')
    this.bound.set(id, scope)
  }

  private async acquire(id: string, env: ExecutionEnv): Promise<SharedScope> {
    const { split, config, host, registry, models, dataDir, logger } = this.deps
    const trusted = env.id === 'node:local' && config.mode(env.cwd) === 'all'
    const settings = await config.get(id, env)
    // The session's own settings decide its shell and its foreground `bash` budget, so both travel
    // with the registry a call runs in.
    const budget = resolveForegroundBudget(settings)
    const projectSettings = await config.project(id, env)
    const discovered = await loadProjectExtensionEntries(env, {
      trusted,
      agentDir: split!.agentDir,
      settings: projectSettings,
    })
    for (const message of discovered.diagnostics) logger.warn(message)
    const selected = await split!.projectExtensions?.({
      cwd: env.cwd,
      environmentId: env.id,
      trusted,
      settings,
      projectSettings,
      entries: discovered.entries,
    })
    const extensionConfig =
      selected?.extensionConfig ?? settings.extensionConfig ?? {}
    const key = JSON.stringify([
      env.id,
      env.cwd,
      trusted,
      settings,
      discovered.entries,
      selected?.key,
    ])
    let shared = this.scopes.get(key)
    if (!shared) {
      const ready = (async (): Promise<Scope> => {
        const extensions = selected
          ? ((await selected.load()) as VelaExtension[])
          : await Promise.all(
              discovered.entries.map((entry) => {
                if ('builtin' in entry)
                  throw new Error(
                    `Project builtin ${entry.name} needs a frontend loader`,
                  )
                return importExtension(entry.path, entry.name)
              }),
            )
        const scopedRegistry = new ToolRegistry(undefined, undefined, registry)
        scopedRegistry.setLogger(logger)
        const runner = new ExtensionRunner(
          {
            cwd: env.cwd,
            dataDir,
            extensionConfig,
            logger,
            registry: scopedRegistry,
            models,
            parent: host,
          },
          extensions.map(
            (extension) =>
              ({
                [extension.name]: (api: ExtensionAPI) =>
                  extension(
                    Object.assign(api, {
                      registerChannel(channel: { name: string }) {
                        logger.warn(
                          `[extensions] Project extension "${extension.name}" cannot register channel "${channel.name}"; channels are host-only`,
                        )
                      },
                    }),
                  ),
              })[extension.name]!,
          ),
        )
        try {
          await runner.ready
        } catch (error) {
          await runner.settled
          await runner.shutdown()
          throw new Error(
            `Project extensions at ${env.cwd} failed to prepare`,
            { cause: error },
          )
        }
        return { runner, registry: scopedRegistry, budget }
      })()
      shared = { ready, sessions: new Set() }
      this.scopes.set(key, shared)
      const current = shared
      void ready.catch(() => {
        if (this.scopes.get(key) === current) this.scopes.delete(key)
      })
    }
    shared.sessions.add(id)
    return shared
  }

  async release(id: string): Promise<void> {
    const pending = this.sessions.get(id)
    this.sessions.delete(id)
    this.bound.delete(id)
    if (!pending) return
    const shared = await pending.catch(() => undefined)
    if (!shared) return
    shared.sessions.delete(id)
    if (shared.sessions.size) return
    for (const [key, value] of this.scopes) {
      if (value === shared) this.scopes.delete(key)
    }
    const scope = await shared.ready.catch(() => undefined)
    await scope?.runner.shutdown()
  }
}
