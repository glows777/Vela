import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  assertNoLegacyConfigFiles,
  interpolateConfigLayer,
  LEGACY_CONFIG_FILES,
  mergeConfig,
  parseConfig,
  stripProjectPrivilegedKeys,
  toExtensionConfigView,
  type VelaSettings,
} from '../../config/index.ts'
import { fileCredentialStore } from '../../providers/auth/store.ts'
import type { CredentialStore } from '../../providers/auth/types.ts'
import type { ProviderDefinition } from '../../providers/models/index.ts'
import { loadModels } from '../../providers/models-config.ts'
import {
  type ContextFile,
  loadAgentContextFile,
  loadContextFiles,
} from '../prompt/context-files.ts'
import type { ExtensionConfigDefinition } from './extension-config.ts'
import {
  discoverExtensions,
  type ExtensionEntry,
  resolveExtensionEntries,
} from './extension-discovery.ts'
import { defaultAgentDir, projectDataDir, resolveConfigPath } from './paths.ts'
import {
  type ConfigResourceSplit,
  readLocalSystemFile,
} from './runtime-resources.ts'

export type { ExtensionEntry } from './extension-discovery.ts'

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
  /** Config files that were read */
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
  /** Built-in providers (anthropic / openai / openrouter / deepseek) plus those in `<agentDir>/config.json`, for createVela's `providers` */
  providers: Record<string, ProviderDefinition>
  /** Credentials stored by `/login` in `<agentDir>/auth.json` (mode 0600), for createVela's `credentials` */
  credentials: CredentialStore
  /** Per-extension config sections (`$VAR` already interpolated once per layer) */
  extensionConfig: Record<string, Record<string, unknown>>
}

const TRUSTED_PROJECT_RESOURCES = [
  'config.json',
  ...LEGACY_CONFIG_FILES,
  'extensions',
  'skills',
  'prompts',
  'APPEND_SYSTEM.md',
  'SYSTEM.md',
]

/**
 * The project has executable or behavior-changing config (`.vela/config.json`, `.vela/extensions/`,
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
 * Reads user and project `config.json` and discovers extensions and skill directories
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

  const userFile = join(agentDir, 'config.json')
  assertNoLegacyConfigFiles(agentDir)
  if (trusted) assertNoLegacyConfigFiles(projectDir)

  const files: string[] = []
  const layers: VelaSettings[] = []
  const layerSpecs: { role: 'user' | 'project'; file: string }[] = [
    { role: 'user', file: userFile },
    ...(trusted
      ? [{ role: 'project' as const, file: join(projectDir, 'config.json') }]
      : []),
  ]
  let userSettings: VelaSettings = {}
  let userExtensionConfig: Record<string, Record<string, unknown>> = {}
  for (const { role, file } of layerSpecs) {
    const raw = readLayer(file, role)
    if (!raw) continue
    if (role === 'project') stripProjectPrivilegedKeys(raw)
    const layer = interpolateConfigLayer(raw, env)
    if (role === 'user') {
      userSettings = layer
      userExtensionConfig = toExtensionConfigView(layer)
    }
    files.push(file)
    layers.push(layer)
  }
  const settings = layers.reduce<VelaSettings>(mergeConfig, {})

  const extensions = resolveExtensionEntries(
    settings.extensions ?? [],
    [
      ...discoverExtensions(join(agentDir, 'extensions')),
      ...(trusted ? discoverExtensions(join(projectDir, 'extensions')) : []),
    ],
    options.builtins ?? [],
    options.defaultOffBuiltins ?? [],
  )

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
  const extensionConfig = toExtensionConfigView(settings)
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
  const dataPath = (path?: string) =>
    path ? resolveConfigPath(cwd, path) : projectDataDir(agentDir, cwd)
  const previous = dataPath(settings.dataDir)
  const dataDir =
    'environments' in userSettings ? dataPath(userSettings.dataDir) : previous
  return {
    cwd,
    agentDir,
    dataDir,
    settings,
    userExtensionConfig,
    files,
    extensions,
    sessionResources: {
      agentDir,
      cwd,
      previousDataDir:
        resolve(previous) === resolve(dataDir) ? undefined : previous,
      userSettings,
      hostExtensions: resolveExtensionEntries(
        userSettings.extensions ?? [],
        discoverExtensions(join(agentDir, 'extensions')),
        options.builtins ?? [],
        options.defaultOffBuiltins ?? [],
      ),
      extensionBuiltins: {
        names: [...(options.builtins ?? [])],
        defaultOff: [...(options.defaultOffBuiltins ?? [])],
      },
      env: options.env ? { ...options.env } : undefined,
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
    providers: loadModels({
      agentDir,
      env,
      providers: userSettings.providers ?? {},
    }),
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

/** Reads one config file: undefined if missing, throws if malformed. Resource paths become absolute. */
function readLayer(
  file: string,
  layer: 'user' | 'project',
): VelaSettings | undefined {
  if (!existsSync(file)) return
  return parseConfig(
    readFileSync(file, 'utf-8'),
    file,
    (item) => resolveConfigPath(dirname(file), item),
    { layer },
  )
}
