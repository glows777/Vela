import { loadProjectSettings } from '../config/project-settings.ts'
import type { ConfigResourceSplit } from '../config/runtime-resources.ts'
import { mergeSettings, type VelaSettings } from '../config/settings-values.ts'
import type { ExecutionEnv } from '../execution/types.ts'
import type { VelaLogger } from '../logger.ts'

/** Pinned per-session settings; distinct sessions may observe newer project files. */
export class ProjectConfig {
  private readonly snapshots = new Map<string, Promise<VelaSettings>>()

  constructor(
    private readonly split: ConfigResourceSplit | undefined,
    private readonly hostDataDir: string,
    private readonly logger: VelaLogger,
  ) {}

  mode(cwd: string) {
    const split = this.split
    return !split
      ? undefined
      : cwd === split.cwd
        ? split.workspaceSkills
        : (split.workspaceModeAt?.(cwd) ?? 'none')
  }

  clear(id: string): void {
    this.snapshots.delete(id)
  }

  get(id: string, env: ExecutionEnv): Promise<VelaSettings> {
    let pending = this.snapshots.get(id)
    if (!pending) {
      const split = this.split
      pending = split
        ? loadProjectSettings(env, {
            cwd: env.cwd,
            trusted: this.mode(env.cwd) === 'all',
            agentDir: split.agentDir,
            env: split.env,
          }).then(async ({ settings }) => {
            if (settings.dataDir && env.cwd !== split.cwd) {
              const path = await env.absolutePath(settings.dataDir)
              if (!path.ok) throw path.error
              if (path.value !== this.hostDataDir)
                this.logger.warn(
                  `[settings] ${env.cwd}: dataDir is host bootstrap configuration; keeping ${this.hostDataDir}`,
                )
            }
            const merged = mergeSettings(split.userSettings ?? {}, settings)
            // Host resource paths do not name files in a non-local workspace.
            if (env.id !== 'node:local') {
              merged.skills = settings.skills
              merged.prompts = settings.prompts
            }
            return merged
          })
        : Promise.resolve({})
      this.snapshots.set(id, pending)
      void pending.catch(() => {
        if (this.snapshots.get(id) === pending) this.snapshots.delete(id)
      })
    }
    return pending
  }
}
