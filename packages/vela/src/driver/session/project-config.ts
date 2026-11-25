import { posix } from 'node:path'
import { mergeConfig, type VelaSettings } from '../../config/index.ts'
import type { VelaLogger } from '../../shared/logger.ts'
import { loadProjectSettings } from '../config/project-settings.ts'
import type { ConfigResourceSplit } from '../config/runtime-resources.ts'
import type { ExecutionEnv } from '../execution/types.ts'

/** Resolve a POSIX environment path through its adapter, canonicalizing deepest existing ancestor. */
export async function canonicalEnvironmentPath(
  env: ExecutionEnv,
  targetPath: string,
  signal?: AbortSignal,
): Promise<string> {
  let cur = posix.resolve('/', targetPath)
  const missing: string[] = []
  for (;;) {
    const res = await env.canonicalPath(cur, signal)
    if (res.ok) {
      return missing.length
        ? posix.join(res.value, ...missing.reverse())
        : res.value
    }
    if (res.error.code !== 'not_found') throw res.error
    const parent = posix.dirname(cur)
    if (parent === cur) return posix.resolve('/', targetPath)
    missing.push(posix.basename(cur))
    cur = parent
  }
}

/** Pinned per-session settings; distinct sessions may observe newer project files. */
export class ProjectConfig {
  private readonly snapshots = new Map<
    string,
    Promise<{ settings: VelaSettings; project: VelaSettings }>
  >()

  constructor(
    private readonly split: ConfigResourceSplit | undefined,
    private readonly hostDataDir: string,
    private readonly logger: VelaLogger,
  ) {}

  mode(cwd: string, environment = 'local') {
    const split = this.split
    return !split
      ? undefined
      : environment === 'local' && cwd === split.cwd
        ? split.workspaceSkills
        : (split.workspaceModeAt?.(cwd, environment) ?? 'none')
  }

  clear(id: string): void {
    this.snapshots.delete(id)
  }

  async get(
    id: string,
    env: ExecutionEnv,
    environment = 'local',
  ): Promise<VelaSettings> {
    return (await this.snapshot(id, env, environment)).settings
  }

  async project(
    id: string,
    env: ExecutionEnv,
    environment = 'local',
  ): Promise<VelaSettings> {
    return (await this.snapshot(id, env, environment)).project
  }

  private snapshot(id: string, env: ExecutionEnv, environment = 'local') {
    let pending = this.snapshots.get(id)
    if (!pending) {
      const split = this.split
      pending = split
        ? (async () => {
            const canonicalCwd =
              env.id === 'node:local'
                ? env.cwd
                : await canonicalEnvironmentPath(env, env.cwd)
            const trusted = this.mode(canonicalCwd, environment) === 'all'
            const { settings } = await loadProjectSettings(env, {
              cwd: canonicalCwd,
              trusted,
              agentDir: split.agentDir,
              env: env.id === 'node:local' ? split.env : {},
            })
            if (
              settings.dataDir &&
              env.id === 'node:local' &&
              env.cwd !== split.cwd
            ) {
              const path = await env.absolutePath(settings.dataDir)
              if (!path.ok) throw path.error
              if (path.value !== this.hostDataDir)
                this.logger.warn(
                  `[settings] ${env.cwd}: dataDir is host bootstrap configuration; keeping ${this.hostDataDir}`,
                )
            }
            const merged = mergeConfig(split.userSettings ?? {}, settings)
            // Host resource paths do not name files in a non-local workspace.
            if (env.id !== 'node:local') {
              merged.skills = settings.skills
              merged.prompts = settings.prompts
            }
            return { settings: merged, project: settings }
          })()
        : Promise.resolve({ settings: {}, project: {} })
      this.snapshots.set(id, pending)
      void pending.catch(() => {
        if (this.snapshots.get(id) === pending) this.snapshots.delete(id)
      })
    }
    return pending
  }
}
