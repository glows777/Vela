import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { assertLimitKeys, type VelaLimits } from '../limits.ts'
import {
  type ProviderDefinition,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '../models/index.ts'
import { type ContextFile, loadContextFiles } from '../prompt/context-files.ts'
import { deepMerge, interpolateDeep, isPlainObject } from './interpolate.ts'
import { loadModels } from './models.ts'
import { defaultAgentDir, projectDataDir, resolveConfigPath } from './paths.ts'

type Env = Record<string, string | undefined>

/** Contents of settings.json (user: `~/.vela/settings.json`, project: `<cwd>/.vela/settings.json`). */
export interface VelaSettings {
  /** Default model `provider/id` (pi splits this into defaultProvider + defaultModel) */
  defaultModel?: string
  /** Default thinking level; medium when unset (like pi) */
  defaultThinkingLevel?: ThinkingLevel
  /** Project data directory, relative to cwd; default `<agentDir>/projects/<encoded cwd>` */
  dataDir?: string
  /** Shell the bash tool runs commands with (like pi); default bash on PATH */
  shellPath?: string
  /** Overrides any subset of VelaLimits */
  limits?: Partial<VelaLimits>
  /** Extension files or directories (relative to this settings file), plus `builtin:<name>` / `+builtin:<name>` / `-builtin:<name>` */
  extensions?: string[]
  /** Extra skill directories or files (relative to this settings file) */
  skills?: string[]
  /** Extra prompt template directories or files (relative to this settings file) */
  prompts?: string[]
  /** Per-extension config section `extensionConfig.<extension name>`; strings support `$VAR` / `${VAR}` */
  extensionConfig?: Record<string, Record<string, unknown>>
}

/** An extension to load: built-ins by name, others by file path. */
export type ExtensionEntry =
  | { name: string; builtin: true }
  | { name: string; path: string }

export interface LoadConfigOptions {
  /** Project directory, default process.cwd() */
  cwd?: string
  /** User-level directory, default `env.VELA_DIR` or `~/.vela` */
  agentDir?: string
  /** Environment for `$VAR` interpolation and `VELA_DIR`; empty by default (core never reads process.env) */
  env?: Record<string, string | undefined>
  /** Whether to load the project's `.vela/` settings, extensions, skills, prompts and `APPEND_SYSTEM.md`, `.skills/` and `.agents/skills/` (see projectTrustRequired) */
  trusted?: boolean
  /** Home directory for `~/.agents/skills`, default os.homedir() */
  homeDir?: string
  /** Built-in extension names; all load by default, `-builtin:<name>` in settings disables one */
  builtins?: readonly string[]
}

/** Result of loadConfig(), ready to wire into createVela(). */
export interface VelaConfig {
  cwd: string
  agentDir: string
  dataDir: string
  /** Merged settings (project overrides user) */
  settings: VelaSettings
  /** Settings files that were read */
  files: string[]
  /** Extensions to load, in order: built-in → ~/.vela/extensions → .vela/extensions → listed in settings */
  extensions: ExtensionEntry[]
  /** Skill directories, highest priority first (the first skill with a name wins, like pi): project, settings, user */
  skillDirs: string[]
  /** Prompt template directories, highest priority first: project, settings, user */
  promptDirs: string[]
  /** AGENTS.md / CLAUDE.md files: `<agentDir>/AGENTS.md`, then from the filesystem root down to cwd (not gated by trust, like pi) */
  contextFiles: ContextFile[]
  /** Contents of `.vela/APPEND_SYSTEM.md` (trusted) or `<agentDir>/APPEND_SYSTEM.md`, like pi */
  appendSystemPrompt?: string
  /** Built-in providers (openai / anthropic) plus those in `<agentDir>/models.json`, for createVela's `providers` */
  providers: Record<string, ProviderDefinition>
  /** Per-extension config sections (`$VAR` already interpolated) */
  extensionConfig: Record<string, Record<string, unknown>>
}

const RESOURCE_KEYS = ['extensions', 'skills', 'prompts'] as const

/**
 * Reads user and project settings.json and discovers extensions and skill directories
 * (like pi: project overrides user, objects deep-merge, extensions / skills concatenate).
 * Only reads files; never loads extension code. Untrusted projects use user config only.
 */
export function loadConfig(options: LoadConfigOptions = {}): VelaConfig {
  const env = options.env ?? {}
  const cwd = resolve(options.cwd ?? process.cwd())
  const agentDir = resolve(options.agentDir ?? defaultAgentDir(env))
  // Run from the home directory, the project dir is ~/.vela: read it once, as user config
  const projectDir = join(cwd, '.vela')
  const trusted = options.trusted === true && projectDir !== agentDir

  const files: string[] = []
  const layers: VelaSettings[] = []
  const userFile = join(agentDir, 'settings.json')
  const projectFile = join(projectDir, 'settings.json')
  for (const file of trusted ? [userFile, projectFile] : [userFile]) {
    const settings = readSettings(file)
    if (!settings) continue
    files.push(file)
    layers.push(settings)
  }
  const settings = layers.reduce<VelaSettings>(mergeSettings, {})

  // Built-ins: all by default; apply ±builtin: in user → project order
  const builtins = new Set(options.builtins ?? [])
  const disabled = new Set<string>()
  const paths: string[] = [
    ...discoverExtensions(join(agentDir, 'extensions')),
    ...(trusted ? discoverExtensions(join(projectDir, 'extensions')) : []),
  ]
  for (const entry of settings.extensions ?? []) {
    const builtin = /^([+-]?)builtin:(.+)$/.exec(entry)
    if (builtin) {
      const [, sign, name] = builtin as unknown as [string, string, string]
      if (!builtins.has(name))
        throw new Error(`Unknown built-in extension builtin:${name}`)
      if (sign === '-') disabled.add(name)
      else disabled.delete(name)
    } else paths.push(...discoverExtensions(entry, true))
  }
  const extensions: ExtensionEntry[] = [
    ...[...builtins]
      .filter((name) => !disabled.has(name))
      .map((name) => ({ name, builtin: true as const })),
    ...[...new Set(paths)].map((path) => ({ name: extensionName(path), path })),
  ]

  // Project skills and prompts need trust like project extensions (pi skips .pi/skills, .agents/skills and
  // .pi/prompts when untrusted). Run from the home directory, `.skills` next to ~/.vela counts as user-level.
  const homeDir = resolve(options.homeDir ?? homedir())
  const skillDirs = [
    ...new Set([
      ...(trusted
        ? [join(projectDir, 'skills'), ...ancestorAgentsSkillDirs(cwd)]
        : []),
      ...(trusted || projectDir === agentDir ? [join(cwd, '.skills')] : []),
      ...(settings.skills ?? []),
      join(agentDir, 'skills'),
      join(homeDir, '.agents', 'skills'),
    ]),
  ]
  const promptDirs = [
    ...new Set([
      ...(trusted ? [join(projectDir, 'prompts')] : []),
      ...(settings.prompts ?? []),
      join(agentDir, 'prompts'),
    ]),
  ]
  const appendFile = [
    ...(trusted ? [join(projectDir, 'APPEND_SYSTEM.md')] : []),
    join(agentDir, 'APPEND_SYSTEM.md'),
  ].find((file) => existsSync(file))

  return {
    cwd,
    agentDir,
    dataDir: settings.dataDir
      ? resolveConfigPath(cwd, settings.dataDir)
      : projectDataDir(agentDir, cwd),
    settings,
    files,
    extensions,
    skillDirs,
    promptDirs,
    contextFiles: loadContextFiles({ cwd, agentDir }),
    ...(appendFile
      ? { appendSystemPrompt: readFileSync(appendFile, 'utf-8') }
      : {}),
    providers: loadModels({ agentDir, env }),
    extensionConfig: interpolateDeep(settings.extensionConfig ?? {}, env),
  }
}

/** Project resources in `.vela/` that need trust (same list as pi's, minus what Vela doesn't have) */
const TRUSTED_PROJECT_RESOURCES = [
  'settings.json',
  'extensions',
  'skills',
  'prompts',
  'APPEND_SYSTEM.md',
]

/**
 * The project has executable or behavior-changing config (`.vela/settings.json`, `.vela/extensions/`,
 * skills in `.vela/skills/`, `.skills/` or `.agents/skills/`, `.vela/prompts/`, `.vela/APPEND_SYSTEM.md`) that
 * needs the user's trust before loading (like pi's trust-requiring project resources). Not counted when the
 * project dir is the user-level dir (running from the home directory). AGENTS.md / CLAUDE.md don't count (like pi).
 */
export function projectTrustRequired(
  cwd: string,
  agentDir?: string,
  homeDir: string = homedir(),
): boolean {
  const projectDir = join(resolve(cwd), '.vela')
  if (agentDir && resolve(agentDir) === projectDir) return false
  const userAgentsSkills = join(resolve(homeDir), '.agents', 'skills')
  return (
    TRUSTED_PROJECT_RESOURCES.some((name) =>
      existsSync(join(projectDir, name)),
    ) ||
    existsSync(join(resolve(cwd), '.skills')) ||
    ancestorAgentsSkillDirs(cwd).some(
      (dir) => dir !== userAgentsSkills && existsSync(dir),
    )
  )
}

/** `.agents/skills` in cwd and each parent up to the git repository root (or the filesystem root outside git), like pi. */
function ancestorAgentsSkillDirs(cwd: string): string[] {
  const dirs: string[] = []
  let dir = resolve(cwd)
  const gitRoot = findGitRoot(dir)
  while (true) {
    dirs.push(join(dir, '.agents', 'skills'))
    if (dir === gitRoot) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirs
}

function findGitRoot(start: string): string | undefined {
  let dir = start
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

/** Reads one settings file: undefined if missing, throws if malformed. Resource paths become absolute. */
function readSettings(file: string): VelaSettings | undefined {
  if (!existsSync(file)) return
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`)
  }
  if (!isPlainObject(raw)) throw new Error(`${file} must be a JSON object`)
  const base = dirname(file)
  const settings = { ...raw } as VelaSettings & Record<string, unknown>
  for (const key of RESOURCE_KEYS) {
    const list = settings[key]
    if (list === undefined) continue
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string'))
      throw new Error(`${file}: ${key} must be an array of strings`)
    settings[key] = list.map((item) =>
      /^[+-]?builtin:/.test(item) ? item : resolveConfigPath(base, item),
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
  if (
    settings.defaultModel !== undefined &&
    (typeof settings.defaultModel !== 'string' ||
      !settings.defaultModel.includes('/'))
  )
    throw new Error(`${file}: defaultModel must be "provider/id"`)
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
function mergeSettings(
  base: VelaSettings,
  override: VelaSettings,
): VelaSettings {
  const merged = deepMerge(base, override) as VelaSettings
  for (const key of RESOURCE_KEYS) {
    const list = [...(base[key] ?? []), ...(override[key] ?? [])]
    if (list.length) merged[key] = list
  }
  return merged
}

const EXTENSION_FILE = /\.(ts|js|mjs)$/

/**
 * Expands an extension path into entry files: a file is itself; a directory with
 * index.ts / index.js is one extension; in any other directory, each `*.ts` and each
 * subdirectory with an index is one extension. With `explicit`, a missing path throws.
 */
function discoverExtensions(path: string, explicit = false): string[] {
  if (!existsSync(path)) {
    if (explicit) throw new Error(`Extension path does not exist: ${path}`)
    return []
  }
  if (!statSync(path).isDirectory()) return [path]
  const index = indexFile(path)
  if (index) return [index]
  const found: string[] = []
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(path, entry.name)
    if (
      entry.isFile() &&
      EXTENSION_FILE.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    )
      found.push(full)
    else if (entry.isDirectory()) {
      const nested = indexFile(full)
      if (nested) found.push(nested)
    }
  }
  return found
}

function indexFile(dir: string): string | undefined {
  for (const name of ['index.ts', 'index.js', 'index.mjs']) {
    const file = join(dir, name)
    if (existsSync(file)) return file
  }
}

/** Extension name: the file name without extension, or the directory name for index files. Sets the tool prefix and config section. */
export function extensionName(path: string): string {
  const file = basename(path, extname(path))
  return file === 'index' ? basename(dirname(path)) : file
}
