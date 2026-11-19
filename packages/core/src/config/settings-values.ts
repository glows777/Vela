import { assertLimitKeys, type VelaLimits } from '../limits.ts'
import { THINKING_LEVELS, type ThinkingLevel } from '../models/index.ts'
import { isToolModifier, mergeDefaultTools } from '../tools/tool-selection.ts'
import { deepMerge, isPlainObject } from './interpolate.ts'

/** Contents of settings.json (user: `~/.vela/settings.json`, project: `<cwd>/.vela/settings.json`). */
export interface VelaSettings {
  /** Default model `provider/id` (pi splits this into defaultProvider + defaultModel) */
  defaultModel?: string
  /** Default thinking level; medium when unset (like pi) */
  defaultThinkingLevel?: ThinkingLevel
  /**
   * Models Ctrl+P cycles through (pi's `enabledModels`): `provider/id` patterns where `*` matches anything,
   * or a bare id / pattern matched against every provider. Unset: all available models.
   */
  enabledModels?: string[]
  /** Project data directory, relative to cwd; default `<agentDir>/projects/<encoded cwd>` */
  dataDir?: string
  /** Shell the bash tool runs commands with (like pi); the CLI selects Git Bash on Windows */
  shellPath?: string
  /**
   * Seconds a foreground `bash` command may run before it moves to the background instead of being
   * killed; default 120. `0` means no foreground budget: a command without `timeout` waits forever.
   */
  bashForegroundTimeoutSeconds?: number
  /** Ceiling for the `timeout` a `bash` call asks for, in seconds; default 600. */
  bashForegroundTimeoutMaxSeconds?: number
  /**
   * Tools a new session starts with: plain names (or `*` patterns) replace the default set, while
   * `+name` / `-name` entries adjust it (like pi's `defaultTools`).
   */
  defaultTools?: string[]
  /** Overrides any subset of VelaLimits */
  limits?: Partial<VelaLimits>
  /** Automatic compaction (like pi's `compaction.enabled`); default true. Manual /compact works either way */
  autoCompaction?: boolean
  /** Extension files or directories (relative to this settings file), plus `builtin:<name>` / `+builtin:<name>` / `-builtin:<name>` */
  extensions?: string[]
  /** Extra skill directories or files (relative to this settings file) */
  skills?: string[]
  /** Extra prompt template directories or files (relative to this settings file) */
  prompts?: string[]
  /** Per-extension config section `extensionConfig.<extension name>`; strings support `$VAR` / `${VAR}` */
  extensionConfig?: Record<string, Record<string, unknown>>
}

// These select execution authority. Strip them at both project-layer entry points.
export function omitProjectLocation(settings: VelaSettings) {
  if ('environments' in settings) delete settings.environments
  if ('location' in settings) delete settings.location
}

export const RESOURCE_KEYS = ['extensions', 'skills', 'prompts'] as const

/** setTimeout's limit in seconds: a budget above it would fire at once instead of waiting. */
const MAX_SETTINGS_SECONDS = 2_147_483_647 / 1000

/** Parse settings without filesystem access; callers own path resolution. */
export function parseSettings(
  text: string,
  file: string,
  resolvePath: (path: string) => string = (path) => path,
): VelaSettings {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`)
  }
  if (!isPlainObject(raw)) throw new Error(`${file} must be a JSON object`)
  const settings = { ...raw } as VelaSettings & Record<string, unknown>
  for (const key of RESOURCE_KEYS) {
    const list = settings[key]
    if (list === undefined) continue
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string'))
      throw new Error(`${file}: ${key} must be an array of strings`)
    settings[key] = list.map((item) =>
      /^[+-]?builtin:/.test(item) ? item : resolvePath(item),
    )
  }
  for (const key of ['limits', 'extensionConfig'] as const)
    if (settings[key] !== undefined && !isPlainObject(settings[key]))
      throw new Error(`${file}: ${key} must be an object`)
  if (settings.limits !== undefined)
    assertLimitKeys(settings.limits, `${file}: limits`)
  for (const key of ['dataDir', 'shellPath'] as const)
    if (settings[key] !== undefined && typeof settings[key] !== 'string')
      throw new Error(`${file}: ${key} must be a string`)
  const budget = settings.bashForegroundTimeoutSeconds
  if (
    budget !== undefined &&
    (typeof budget !== 'number' ||
      !Number.isFinite(budget) ||
      budget < 0 ||
      budget > MAX_SETTINGS_SECONDS)
  )
    throw new Error(
      `${file}: bashForegroundTimeoutSeconds must be 0 or a positive number of seconds, at most ${MAX_SETTINGS_SECONDS}`,
    )
  const ceiling = settings.bashForegroundTimeoutMaxSeconds
  if (
    ceiling !== undefined &&
    (typeof ceiling !== 'number' ||
      !Number.isFinite(ceiling) ||
      ceiling <= 0 ||
      ceiling > MAX_SETTINGS_SECONDS)
  )
    throw new Error(
      `${file}: bashForegroundTimeoutMaxSeconds must be a positive number of seconds, at most ${MAX_SETTINGS_SECONDS}`,
    )
  if (
    settings.autoCompaction !== undefined &&
    typeof settings.autoCompaction !== 'boolean'
  )
    throw new Error(`${file}: autoCompaction must be true or false`)
  if (
    settings.defaultModel !== undefined &&
    (typeof settings.defaultModel !== 'string' ||
      !settings.defaultModel.includes('/'))
  )
    throw new Error(`${file}: defaultModel must be "provider/id"`)
  if (
    settings.enabledModels !== undefined &&
    (!Array.isArray(settings.enabledModels) ||
      settings.enabledModels.some((item) => typeof item !== 'string'))
  )
    throw new Error(`${file}: enabledModels must be an array of strings`)
  if (
    settings.defaultTools !== undefined &&
    (!Array.isArray(settings.defaultTools) ||
      settings.defaultTools.some((item) => typeof item !== 'string'))
  )
    throw new Error(`${file}: defaultTools must be an array of strings`)
  const toolPattern = settings.defaultTools?.find(
    (entry) => isToolModifier(entry) && entry.includes('*'),
  )
  if (toolPattern)
    throw new Error(
      `${file}: +name and -name entries take exact tool names, not patterns: ${toolPattern}`,
    )
  if (
    settings.defaultThinkingLevel !== undefined &&
    !THINKING_LEVELS.includes(settings.defaultThinkingLevel)
  )
    throw new Error(
      `${file}: defaultThinkingLevel must be one of ${THINKING_LEVELS.join(' / ')}`,
    )
  return settings
}

/** Project overrides user: objects deep-merge, extensions / skills concatenate, other values are replaced. */
export function mergeSettings(
  base: VelaSettings,
  override: VelaSettings,
): VelaSettings {
  const merged = deepMerge(base, override) as VelaSettings
  for (const key of RESOURCE_KEYS) {
    const list = [...(base[key] ?? []), ...(override[key] ?? [])]
    if (list.length) merged[key] = list
  }
  const defaultTools = mergeDefaultTools(
    base.defaultTools,
    override.defaultTools,
  )
  if (defaultTools !== undefined) merged.defaultTools = defaultTools
  return merged
}
