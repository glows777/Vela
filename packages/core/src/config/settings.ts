import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileCredentialStore } from '../auth/store.ts'
import type { CredentialStore } from '../auth/types.ts'
import type { ProviderDefinition } from '../models/index.ts'
import {
  type ContextFile,
  loadAgentContextFile,
  loadContextFiles,
} from '../prompt/context-files.ts'
import type { ExtensionConfigDefinition } from './extension-config.ts'
import { interpolateDeep } from './interpolate.ts'
import { loadModels } from './models.ts'
import { defaultAgentDir, projectDataDir, resolveConfigPath } from './paths.ts'
import {
  type ConfigResourceSplit,
  readLocalSystemFile,
} from './runtime-resources.ts'

import {
  mergeSettings,
  parseSettings,
  type VelaSettings,
} from './settings-values.ts'

export type { VelaSettings } from './settings-values.ts'

/** An extension to load: built-ins by name, others by file path. */
export type ExtensionEntry =
  | { name: string; builtin: true }
  | { name: string; path: string }

export interface LoadConfigOptions {
  /** @internal Vela frontends select these files when preparing each session. */
  deferSystemFiles?: boolean
  /** Installed extensions own any additional settings sources and trust resources. */
  extensionConfigs?: readonly ExtensionConfigDefinition[]
  /** Project directory, default process.cwd() */
  cwd?: string
  /** User-level directory, default `env.VELA_DIR` or `~/.vela` */
  agentDir?: string
  /** Environment for `$VAR` interpolation and `VELA_DIR`; empty by default (core never reads process.env) */
  env?: Record<string, string | undefined>
  /** Whether to load the project's `.vela/` settings, extensions, skills, prompts, `APPEND_SYSTEM.md` and `SYSTEM.md`, `.skills/` and `.agents/skills/` (see projectTrustRequired) */
  trusted?: boolean
  /** Home directory for `~/.agents/skills`, default os.homedir() */
  homeDir?: string
  /** Built-in extension names; all load by default, `-builtin:<name>` in settings disables one */
  builtins?: readonly string[]
  /** Built-ins in `builtins` that stay off until settings enable them with `+builtin:<name>` */
  defaultOffBuiltins?: readonly string[]
}

/** Result of loadConfig(), ready to wire into createVela(). */
export interface VelaConfig {
  /** @internal Resource provenance for Vela-owned frontends. */
  sessionResources?: ConfigResourceSplit
  cwd: string
  agentDir: string
  dataDir: string
  /** Merged settings (project overrides user) */
  settings: VelaSettings
  /** User-only extension sections, interpolated before any project overrides. */
  userExtensionConfig: Record<string, Record<string, unknown>>
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
  /** Contents of `.vela/SYSTEM.md` (trusted) or `<agentDir>/SYSTEM.md`: replaces the default system prompt, like pi */
  systemPrompt?: string
  /** Built-in providers (anthropic / openai / openrouter / deepseek) plus those in `<agentDir>/models.json`, for createVela's `providers` */
  providers: Record<string, ProviderDefinition>
  /** Credentials stored by `/login` in `<agentDir>/auth.json` (mode 0600), for createVela's `credentials` */
  credentials: CredentialStore
  /** Per-extension config sections (`$VAR` already interpolated) */
  extensionConfig: Record<string, Record<string, unknown>>
}

const TRUSTED_PROJECT_RESOURCES = [
  'settings.json',
  'extensions',
  'skills',
  'prompts',
  'APPEND_SYSTEM.md',
  'SYSTEM.md',
]

/**
 * The project has executable or behavior-changing config (`.vela/settings.json`, `.vela/extensions/`,
 * skills in `.vela/skills/`, `.skills/` or `.agents/skills/`, `.vela/prompts/`, `.vela/APPEND_SYSTEM.md`,
 * `.vela/SYSTEM.md`) that
 * needs the user's trust before loading (like pi's trust-requiring project resources). Not counted when the
 * project dir is the user-level dir (running from the home directory). AGENTS.md / CLAUDE.md don't count (like pi).
 */
/** @experimental Shared frontend contract. */
export function projectTrustRequired(
  cwd: string,
  agentDir?: string,
  homeDir: string = homedir(),
  extensionConfigs: readonly ExtensionConfigDefinition[] = [],
): boolean {
  const projectDir = join(resolve(cwd), '.vela')
  if (agentDir && resolve(agentDir) === projectDir) return false
  const userAgentsSkills = join(resolve(homeDir), '.agents', 'skills')
  return (
    [
      ...TRUSTED_PROJECT_RESOURCES,
      ...extensionConfigs.flatMap(
        (definition) => definition.projectResources ?? [],
      ),
    ].some((name) => existsSync(join(projectDir, name))) ||
    existsSync(join(resolve(cwd), '.skills')) ||
    ancestorAgentsSkillDirs(cwd).some(
      (dir) => dir !== userAgentsSkills && existsSync(dir),
    )
  )
}

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
  let userSettings: VelaSettings = {}
  let userExtensionConfig: Record<string, Record<string, unknown>> = {}
  for (const file of trusted ? [userFile, projectFile] : [userFile]) {
    const settings = readSettings(file)
    if (!settings) continue
    if (file === userFile) {
      userSettings = settings
      userExtensionConfig = interpolateDeep(settings.extensionConfig ?? {}, env)
    }
    files.push(file)
    layers.push(settings)
  }
  const settings = layers.reduce<VelaSettings>(mergeSettings, {})

  // Built-ins: all by default except defaultOffBuiltins; apply ±builtin: in user → project order
  const builtins = new Set(options.builtins ?? [])
  const disabled = new Set(options.defaultOffBuiltins ?? [])
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
  const hostSkillDirs = [
    ...new Set([
      ...(userSettings.skills ?? []),
      join(agentDir, 'skills'),
      join(homeDir, '.agents', 'skills'),
    ]),
  ]
  const hostPromptDirs = [
    ...new Set([...(userSettings.prompts ?? []), join(agentDir, 'prompts')]),
  ]
  const userContext = loadAgentContextFile(agentDir)
  let skillDirs: string[] | undefined
  let contextFiles: ContextFile[] | undefined
  const extensionConfig = interpolateDeep(settings.extensionConfig ?? {}, env)
  for (const definition of options.extensionConfigs ?? [])
    extensionConfig[definition.name] = definition.resolve(
      extensionConfig[definition.name] ?? {},
      { cwd, agentDir, projectDir, trusted, env },
    )

  const promptDirs = options.deferSystemFiles
    ? []
    : trusted
      ? [projectDir, agentDir]
      : [agentDir]
  const systemPrompt = readLocalSystemFile(promptDirs, 'SYSTEM.md')
  const appendSystemPrompt = readLocalSystemFile(promptDirs, 'APPEND_SYSTEM.md')
  return {
    cwd,
    agentDir,
    dataDir: settings.dataDir
      ? resolveConfigPath(cwd, settings.dataDir)
      : projectDataDir(agentDir, cwd),
    settings,
    userExtensionConfig,
    files,
    extensions,
    sessionResources: {
      agentDir,
      cwd,
      userSettings,
      env: { ...env },
      userContextFiles: userContext ? [userContext] : [],
      hostSkillDirs,
      hostPromptDirs,
      workspaceSkills: trusted
        ? 'all'
        : projectDir === agentDir
          ? 'home'
          : 'none',
    },
    // SDK consumers can still request the host's original local configuration view.
    // Vela's frontends pass sessionResources, so they never force these workspace reads.
    get skillDirs() {
      skillDirs ??= [
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
      return skillDirs
    },
    set skillDirs(value) {
      skillDirs = value
    },
    promptDirs: [
      ...new Set([
        ...(trusted ? [join(projectDir, 'prompts')] : []),
        ...(settings.prompts ?? []),
        join(agentDir, 'prompts'),
      ]),
    ],
    get contextFiles() {
      contextFiles ??= loadContextFiles({ cwd, agentDir })
      return contextFiles
    },
    set contextFiles(value) {
      contextFiles = value
    },
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
    providers: loadModels({ agentDir, env }),
    credentials: fileCredentialStore(join(agentDir, 'auth.json')),
    extensionConfig,
  }
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
  return parseSettings(readFileSync(file, 'utf-8'), file, (item) =>
    resolveConfigPath(dirname(file), item),
  )
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
/** @experimental Shared frontend contract. */
export function extensionName(path: string): string {
  const file = basename(path, extname(path))
  return file === 'index' ? basename(dirname(path)) : file
}
