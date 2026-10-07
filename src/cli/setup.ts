import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import {
  type ExtensionEntry,
  extensionName,
  importExtension,
  projectTrustRequired,
  savedTrust,
  saveTrust,
  type VelaConfig,
} from '../config'
import { isPlainObject } from '../config/interpolate'
import { feishu } from '../extensions/feishu'
import { memory } from '../extensions/memory'
import { rag } from '../extensions/rag'
import { supabase } from '../extensions/supabase'
import type { VelaExtension } from '../extensions/types'
import { web } from '../extensions/web'

type Env = Record<string, string | undefined>

/** CLI 自带的内置扩展（`builtin:<名>`），默认全部加载；配置从 `extensionConfig.<名>` 取。 */
export const BUILTIN_EXTENSIONS: Record<string, () => VelaExtension> = {
  memory: () => memory(),
  rag: () => rag(),
  web: () => web(),
  supabase: () => supabase(),
  feishu: () => feishu(),
}

export interface CliArgs {
  /** `-p "<prompt>"`：跑一轮就退出 */
  print?: string
  continue: boolean
  /** `-e, --extension <path>`（可重复），也可以是 `builtin:<名>` */
  extensions: string[]
  /** `--no-extensions`：不加载内置和发现的扩展（`-e` 仍加载），同 pi */
  noExtensions: boolean
  /** `--no-session`：会话只在内存里，不落盘（记忆、知识库照常） */
  noSession: boolean
  /** `--approve` / `--no-approve`：这次运行信任 / 不信任项目配置，不保存 */
  approve?: boolean
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    continue: false,
    extensions: [],
    noExtensions: false,
    noSession: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} 需要一个参数`)
      return next
    }
    if (arg === '-p' || arg === '--print') args.print = value()
    else if (arg === '--continue') args.continue = true
    else if (arg === '-e' || arg === '--extension') args.extensions.push(value())
    else if (arg === '--no-extensions' || arg === '-ne') args.noExtensions = true
    else if (arg === '--no-session') args.noSession = true
    else if (arg === '--approve') args.approve = true
    else if (arg === '--no-approve') args.approve = false
    else throw new Error(`未知参数 ${arg}`)
  }
  return args
}

/**
 * 项目里有 `.vela/settings.json` 或 `.vela/extensions/` 时决定是否加载（同 pi 的项目信任）：
 * `--approve / --no-approve` → 已保存的决定 → 交互模式问一次并保存；不能问时不信任。
 * 返回值的 `warning` 是不信任时给用户看的提示。
 */
export async function resolveTrust(options: {
  cwd: string
  agentDir: string
  approve?: boolean
  interactive: boolean
}): Promise<{ trusted: boolean; warning?: string }> {
  const { cwd, agentDir } = options
  if (!projectTrustRequired(cwd, agentDir)) return { trusted: false }
  if (options.approve !== undefined) return { trusted: options.approve }
  const saved = savedTrust(agentDir, cwd)
  if (saved !== undefined)
    return saved
      ? { trusted: true }
      : { trusted: false, warning: notTrusted(cwd, '你之前选择了不信任') }
  if (!options.interactive)
    return {
      trusted: false,
      warning: notTrusted(cwd, '非交互模式下不会询问，加 --approve 信任'),
    }
  const answer = await question(
    `${resolve(cwd)} 有项目配置（.vela/settings.json 或 .vela/extensions/）。\n扩展是会在本机执行的代码，信任这个项目并加载吗？(y/N) `,
  )
  const trusted = answer === 'y' || answer === 'yes'
  saveTrust(agentDir, cwd, trusted)
  return trusted
    ? { trusted }
    : { trusted, warning: notTrusted(cwd, '已记住这个选择') }
}

function notTrusted(cwd: string, reason: string): string {
  return `[信任] 没有加载 ${join(resolve(cwd), '.vela')} 的配置和扩展（${reason}；改主意可以编辑 ~/.vela/trust.json）`
}

async function question(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await new Promise<string>((resolve) =>
      rl.question(prompt, (answer) => resolve(answer.trim().toLowerCase())),
    )
  } finally {
    rl.close()
  }
}

/**
 * 内置扩展的配置默认值来自环境变量（`.env.example` 里那些），settings.json 的
 * `extensionConfig` 覆盖它们。
 */
export function extensionConfigFromEnv(
  env: Env,
  fromSettings: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const defaults: Record<string, Record<string, unknown>> = {
    web: { tavilyKey: env.TAVILY_API_KEY, serperKey: env.SERPER_API_KEY },
    supabase: { url: env.SUPABASE_URL, key: env.SUPABASE_KEY },
    feishu: {
      appId: env.FEISHU_APP_ID,
      appSecret: env.FEISHU_APP_SECRET,
      owners: env.FEISHU_OWNERS,
    },
    rag: {
      embedding: {
        baseUrl: env.EMBEDDING_MODEL_BASE_URL,
        model: env.EMBEDDING_MODEL,
        apiKey: env.EMBEDDING_MODEL_KEY,
      },
    },
  }
  const merged: Record<string, Record<string, unknown>> = { ...defaults }
  for (const [name, section] of Object.entries(fromSettings))
    merged[name] = deepMerge(merged[name] ?? {}, section)
  return merged
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = result[key]
    result[key] =
      isPlainObject(current) && isPlainObject(value)
        ? deepMerge(current, value)
        : value
  }
  return result
}

/**
 * 按 loadConfig 的结果和命令行参数加载扩展：内置 → 发现的 → `-e`。
 * 加载失败的扩展跳过，错误交给 onError（同 pi：报错但不退出）。
 */
export async function loadCliExtensions(
  config: VelaConfig,
  args: CliArgs,
  onError: (message: string) => void,
): Promise<VelaExtension[]> {
  const entries: ExtensionEntry[] = [
    ...(args.noExtensions ? [] : config.extensions),
    ...args.extensions.map((source): ExtensionEntry => {
      const builtin = /^builtin:(.+)$/.exec(source)?.[1]
      if (builtin) return { name: builtin, builtin: true }
      const path = resolve(source)
      return { name: extensionName(path), path }
    }),
  ]
  const loaded: VelaExtension[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const key = 'builtin' in entry ? `builtin:${entry.name}` : entry.path
    if (seen.has(key)) continue
    seen.add(key)
    try {
      if ('builtin' in entry) {
        const factory = BUILTIN_EXTENSIONS[entry.name]
        if (!factory) throw new Error(`未知的内置扩展 builtin:${entry.name}`)
        loaded.push(factory())
      } else loaded.push(await importExtension(entry.path, entry.name))
    } catch (error) {
      onError(
        `[扩展] ${key} 加载失败: ${error instanceof Error ? error.message : error}`,
      )
    }
  }
  return loaded
}

/** 旧版本把数据写在 cwd 里；发现时提示怎么搬到新的数据目录。 */
export function legacyDataHint(cwd: string, dataDir: string): string | undefined {
  if (resolve(cwd) === resolve(dataDir)) return
  const moves = (
    [
      ['.sessions', 'sessions'],
      ['.memory', 'memory'],
      ['.usage', 'usage'],
      ['knowledge.db', 'rag/knowledge.db'],
    ] as const
  ).filter(([old]) => existsSync(join(cwd, old)))
  if (!moves.length) return
  // 新目录可能已经有这次启动建的文件，用 cp -R 合并再删旧的
  const lines = moves.map(([old, next]) => {
    const target = join(dataDir, next)
    return old === 'knowledge.db'
      ? `  mkdir -p "${dirname(target)}" && mv ${old} "${target}"`
      : `  mkdir -p "${target}" && cp -R ${old}/. "${target}/" && rm -r ${old}`
  })
  return [
    `[数据] 发现旧位置的数据（${moves.map(([old]) => old).join('、')}），现在的数据目录是 ${dataDir}。要继续使用，退出后在 ${resolve(cwd)} 里执行：`,
    ...lines,
  ].join('\n')
}
