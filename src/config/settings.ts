import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { VelaLimits } from '../limits'
import { interpolateDeep, isPlainObject } from './interpolate'
import {
  defaultAgentDir,
  projectDataDir,
  resolveConfigPath,
} from './paths'

type Env = Record<string, string | undefined>

/** settings.json 的内容（用户级 `~/.vela/settings.json`，项目级 `<cwd>/.vela/settings.json`）。 */
export interface VelaSettings {
  /** 项目数据目录，相对路径按 cwd 解析；默认 `<agentDir>/projects/<编码后的 cwd>` */
  dataDir?: string
  /** 覆盖 VelaLimits 的任意子集 */
  limits?: Partial<VelaLimits>
  /** 扩展文件或目录（相对所在 settings 文件），以及 `builtin:<名>` / `+builtin:<名>` / `-builtin:<名>` */
  extensions?: string[]
  /** 额外的 skill 目录（相对所在 settings 文件） */
  skills?: string[]
  /** 每个扩展的配置段：`extensionConfig.<扩展名>`，字符串支持 `$VAR` / `${VAR}` */
  extensionConfig?: Record<string, Record<string, unknown>>
}

/** 一个要加载的扩展：内置的按名字，其余按文件路径。 */
export type ExtensionEntry =
  | { name: string; builtin: true }
  | { name: string; path: string }

export interface LoadConfigOptions {
  /** 项目目录，默认 process.cwd() */
  cwd?: string
  /** 用户级目录，默认 `env.VELA_DIR` 或 `~/.vela` */
  agentDir?: string
  /** `$VAR` 插值和 `VELA_DIR` 用的环境变量；默认空（core 不读 process.env） */
  env?: Record<string, string | undefined>
  /** 是否加载项目的 `.vela/settings.json` 和 `.vela/extensions/`（见 projectTrustRequired） */
  trusted?: boolean
  /** 内置扩展的名字；默认全部加载，settings 里 `-builtin:<名>` 关掉 */
  builtins?: readonly string[]
}

/** loadConfig() 的结果：可以直接用来装配 createVela() 的各项。 */
export interface VelaConfig {
  cwd: string
  agentDir: string
  dataDir: string
  /** 合并后的设置（项目覆盖用户） */
  settings: VelaSettings
  /** 读到的 settings 文件 */
  files: string[]
  /** 要加载的扩展，按顺序：内置 → ~/.vela/extensions → .vela/extensions → settings 里列的 */
  extensions: ExtensionEntry[]
  /** skill 目录，按优先级从低到高（同名 skill 后面的覆盖前面的） */
  skillDirs: string[]
  /** 每个扩展的配置段（已做 `$VAR` 插值） */
  extensionConfig: Record<string, Record<string, unknown>>
}

const RESOURCE_KEYS = ['extensions', 'skills'] as const

/**
 * 读用户级和项目级 settings.json、发现扩展和 skill 目录（同 pi：项目覆盖用户，对象深合并，
 * extensions / skills 合并）。只读文件，不加载扩展代码；不信任的项目只用用户级配置。
 */
export function loadConfig(options: LoadConfigOptions = {}): VelaConfig {
  const env = options.env ?? {}
  const cwd = resolve(options.cwd ?? process.cwd())
  const agentDir = resolve(options.agentDir ?? defaultAgentDir(env))
  // 在家目录里运行时项目目录就是 ~/.vela：只当用户级配置读一次
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

  // 内置扩展：默认全部；按 user → project 的顺序处理 ±builtin:
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
      if (!builtins.has(name)) throw new Error(`未知的内置扩展 builtin:${name}`)
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

  const skillDirs = [
    ...new Set([
      join(cwd, '.skills'),
      join(agentDir, 'skills'),
      ...(settings.skills ?? []),
      ...(projectDir === agentDir ? [] : [join(projectDir, 'skills')]),
    ]),
  ]

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
    extensionConfig: interpolateDeep(settings.extensionConfig ?? {}, env),
  }
}

/**
 * 项目里有可执行或会改变行为的配置（`.vela/settings.json`、`.vela/extensions/`），加载前要用户信任。
 * 项目目录就是用户级目录（在家目录里运行）时不算。
 */
export function projectTrustRequired(cwd: string, agentDir?: string): boolean {
  const projectDir = join(resolve(cwd), '.vela')
  if (agentDir && resolve(agentDir) === projectDir) return false
  return (
    existsSync(join(projectDir, 'settings.json')) ||
    existsSync(join(projectDir, 'extensions'))
  )
}

/** 读一个 settings 文件；不存在返回 undefined，格式错误抛错。资源路径解析成绝对路径。 */
function readSettings(file: string): VelaSettings | undefined {
  if (!existsSync(file)) return
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (error) {
    throw new Error(`${file} 不是合法的 JSON: ${(error as Error).message}`)
  }
  if (!isPlainObject(raw)) throw new Error(`${file} 应该是一个 JSON 对象`)
  const base = dirname(file)
  const settings = { ...raw } as VelaSettings & Record<string, unknown>
  for (const key of RESOURCE_KEYS) {
    const list = settings[key]
    if (list === undefined) continue
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string'))
      throw new Error(`${file}: ${key} 应该是字符串数组`)
    settings[key] = list.map((item) =>
      /^[+-]?builtin:/.test(item) ? item : resolveConfigPath(base, item),
    )
  }
  for (const key of ['limits', 'extensionConfig'] as const)
    if (settings[key] !== undefined && !isPlainObject(settings[key]))
      throw new Error(`${file}: ${key} 应该是对象`)
  if (settings.dataDir !== undefined && typeof settings.dataDir !== 'string')
    throw new Error(`${file}: dataDir 应该是字符串`)
  return settings
}

/** 项目覆盖用户：对象深合并，extensions / skills 拼接，其它值直接覆盖。 */
function mergeSettings(base: VelaSettings, override: VelaSettings): VelaSettings {
  const merged = deepMerge(base, override) as VelaSettings
  for (const key of RESOURCE_KEYS) {
    const list = [...(base[key] ?? []), ...(override[key] ?? [])]
    if (list.length) merged[key] = list
  }
  return merged
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override))
    result[key] = key in base ? deepMerge(base[key], value) : value
  return result
}

const EXTENSION_FILE = /\.(ts|js|mjs)$/

/**
 * 一个扩展路径展开成扩展入口文件：文件本身；有 index.ts / index.js 的目录是一个扩展；
 * 其它目录里的 `*.ts` 和带 index 的子目录各是一个扩展。`explicit` 为 true 时路径不存在要报错。
 */
function discoverExtensions(path: string, explicit = false): string[] {
  if (!existsSync(path)) {
    if (explicit) throw new Error(`扩展路径不存在: ${path}`)
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
    if (entry.isFile() && EXTENSION_FILE.test(entry.name) && !entry.name.endsWith('.d.ts'))
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

/** 扩展名：文件名（去掉扩展名），index 文件取目录名。决定工具前缀和配置段。 */
export function extensionName(path: string): string {
  const file = basename(path, extname(path))
  return file === 'index' ? basename(dirname(path)) : file
}
