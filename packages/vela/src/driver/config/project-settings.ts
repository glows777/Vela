import {
  interpolateConfigLayer,
  LEGACY_CONFIG_FILES,
  parseConfig,
  RESOURCE_KEYS,
  stripProjectPrivilegedKeys,
  type VelaSettings,
} from '../../config/index.ts'
import type { ExecutionEnv, FileError, Result } from '../execution/types.ts'

interface ProjectSettingsOptions {
  cwd: string
  trusted: boolean
  /** Host user config directory; only comparable in the local environment. */
  agentDir?: string
  /** Explicit interpolation inputs; never read the host process environment. */
  env?: Record<string, string | undefined>
  signal?: AbortSignal
}

export interface ProjectSettings {
  settings: VelaSettings
  files: string[]
  skillDirs: string[]
  promptDirs: string[]
}

const value = <T>(result: Result<T, FileError>): T => {
  if (!result.ok) throw result.error
  return result.value
}

/** Read only the selected project's layer. This never imports workspace code. */
export async function loadProjectSettings(
  environment: ExecutionEnv,
  options: ProjectSettingsOptions,
): Promise<ProjectSettings> {
  const empty = { settings: {}, files: [], skillDirs: [], promptDirs: [] }
  const { signal } = options
  signal?.throwIfAborted()
  if (!options.trusted) return empty
  const join = async (...parts: string[]) =>
    value(await environment.joinPath(parts, signal))
  const projectDir = await join(options.cwd, '.vela')
  if (environment.id === 'node:local' && projectDir === options.agentDir)
    return empty
  const file = await join(projectDir, 'config.json')
  const content = await environment.readTextFile(file, signal)
  if (!content.ok) {
    if (content.error.code === 'not_found') {
      if (typeof environment.exists === 'function') {
        const legacy: string[] = []
        for (const name of LEGACY_CONFIG_FILES) {
          const present = value(
            await environment.exists(await join(projectDir, name), signal),
          )
          if (present) legacy.push(name)
        }
        if (legacy.length > 0) {
          throw new Error(
            `${projectDir}: found legacy config file(s) (${legacy.join(', ')}) without config.json; v0.9 uses unified config.json`,
          )
        }
      }
      return empty
    }
    throw content.error
  }
  const settings = parseConfig(content.value, file, undefined, {
    layer: 'project',
  })
  stripProjectPrivilegedKeys(settings)
  for (const key of RESOURCE_KEYS) {
    const entries = settings[key]
    if (!entries) continue
    settings[key] = await Promise.all(
      entries.map(async (entry) => {
        if (/^[+-]?builtin:/.test(entry)) return entry
        // Absolute and home-relative paths belong to the selected adapter, never host fs.
        const standalone = /^(?:[\\/]|[A-Za-z]:[\\/]|~(?:[\\/]|$))/.test(entry)
        return value(
          await environment.absolutePath(
            standalone ? entry : await join(projectDir, entry),
            signal,
          ),
        )
      }),
    )
  }
  const interpolated = interpolateConfigLayer(settings, options.env ?? {})
  return {
    settings: interpolated,
    files: [file],
    skillDirs: interpolated.skills ?? [],
    promptDirs: interpolated.prompts ?? [],
  }
}
