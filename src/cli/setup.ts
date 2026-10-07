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
import { deepMerge } from '../config/interpolate'
import { feishu } from '../extensions/feishu'
import { memory } from '../extensions/memory'
import { rag } from '../extensions/rag'
import { supabase } from '../extensions/supabase'
import type { VelaExtension } from '../extensions/types'
import { THINKING_LEVELS, type ThinkingLevel } from '../models'
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
  /** `-p, --print`：跑完给出的 prompt 就退出，stdout 只写最后的回答（同 pi） */
  print: boolean
  /** `--mode text | json | rpc`（同 pi）：json 每个事件一行，rpc 从 stdin 收命令 */
  mode?: 'text' | 'json' | 'rpc'
  /** 不以 `-` 开头的参数：依次发送的 prompt（同 pi） */
  messages: string[]
  /** `-c, --continue`：接着最近的会话 */
  continue: boolean
  /** `-r, --resume`：选一个保存过的会话 */
  resume: boolean
  /** `--session <id>`：打开指定会话（不存在时新建） */
  session?: string
  /** `-e, --extension <path>`（可重复），也可以是 `builtin:<名>` */
  extensions: string[]
  /** `--no-extensions`：不加载内置和发现的扩展（`-e` 仍加载），同 pi */
  noExtensions: boolean
  /** `--no-session`：会话只在内存里，不落盘（记忆、知识库照常） */
  noSession: boolean
  /** `--approve` / `--no-approve`：这次运行信任 / 不信任项目配置，不保存 */
  approve?: boolean
  /** `--model provider/id` */
  model?: string
  /** `--thinking <级别>` */
  thinking?: ThinkingLevel
}

export const USAGE =
  '用法: vela [prompt...] [-p | --mode text|json|rpc] [-c | -r | --session <id>] [-e <扩展>]... [--no-extensions] [--no-session] [--approve | --no-approve] [--model provider/id] [--thinking <级别>]'

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    print: false,
    messages: [],
    continue: false,
    resume: false,
    extensions: [],
    noExtensions: false,
    noSession: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} 需要一个参数`)
      return next
    }
    if (arg === '-p' || arg === '--print') args.print = true
    else if (arg === '--mode') {
      const mode = value()
      if (mode !== 'text' && mode !== 'json' && mode !== 'rpc')
        throw new Error('--mode 只能是 text / json / rpc')
      args.mode = mode
    } else if (arg === '-c' || arg === '--continue') args.continue = true
    else if (arg === '-r' || arg === '--resume') args.resume = true
    else if (arg === '--session') args.session = value()
    else if (arg === '-e' || arg === '--extension') args.extensions.push(value())
    else if (arg === '--no-extensions' || arg === '-ne') args.noExtensions = true
    else if (arg === '--no-session') args.noSession = true
    else if (arg === '--approve') args.approve = true
    else if (arg === '--no-approve') args.approve = false
    else if (arg === '--model') args.model = value()
    else if (arg === '--thinking') {
      const level = value()
      if (!THINKING_LEVELS.includes(level as ThinkingLevel))
        throw new Error(`--thinking 只能是 ${THINKING_LEVELS.join(' / ')}`)
      args.thinking = level as ThinkingLevel
    } else if (arg.startsWith('-') && arg !== '-') throw new Error(`未知参数 ${arg}`)
    else args.messages.push(arg)
  }
  if ([args.continue, args.resume, args.session !== undefined].filter(Boolean).length > 1)
    throw new Error('-c、-r、--session 只能选一个')
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
  return deepMerge(defaults, fromSettings) as Record<
    string,
    Record<string, unknown>
  >
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
    const report = (error: unknown) =>
      onError(
        `[扩展] ${key} 加载失败: ${error instanceof Error ? error.message : error}`,
      )
    try {
      let extension: VelaExtension
      if ('builtin' in entry) {
        const factory = BUILTIN_EXTENSIONS[entry.name]
        if (!factory) throw new Error(`未知的内置扩展 builtin:${entry.name}`)
        extension = factory()
      } else extension = await importExtension(entry.path, entry.name)
      loaded.push(reportFailures(extension, report))
    } catch (error) {
      report(error)
    }
  }
  return loaded
}

/**
 * 扩展函数本身在 createVela() 里才执行：同步抛错或 async 失败也只报告，不让 CLI 启动失败
 * （SDK 的 createVela 仍然直接报错）。失败前已经注册的工具、命令保留。
 */
function reportFailures(
  extension: VelaExtension,
  report: (error: unknown) => void,
): VelaExtension {
  const { name } = extension
  // 用计算属性名保留函数名：runner 用 extension.name 作扩展名
  return {
    [name]: (vela: Parameters<VelaExtension>[0]) => {
      try {
        const result = extension(vela)
        if (result instanceof Promise) return result.catch(report)
      } catch (error) {
        report(error)
      }
    },
  }[name] as VelaExtension
}

/**
 * 旧版本把数据写在 cwd 里（`.sessions` 等）；发现时提示怎么搬到新的数据目录（不自动搬）。
 * 命令可以重复执行：旧数据不在了 cp / mv 就失败，不会删任何东西；复制失败也不删旧数据。
 */
export function legacyDataHint(cwd: string, dataDir: string): string | undefined {
  const moves = (
    [
      ['.sessions', 'sessions'],
      ['.memory', 'memory'],
      ['.usage', 'usage'],
      ['knowledge.db', 'rag'],
    ] as const
  ).filter(([old]) => existsSync(join(cwd, old)))
  if (!moves.length) return
  const lines = moves.map(([old, next]) => {
    const from = shellQuote(join(resolve(cwd), old))
    const target = shellQuote(join(resolve(dataDir), next))
    // knowledge.db* 连同可能存在的 -journal / -wal / -shm 一起搬
    if (old === 'knowledge.db')
      return `  mkdir -p ${target} && mv ${from}* ${target}/`
    // 新目录里可能已有这次启动建的文件（例如空的 MEMORY.md）：合并进去，同名文件以旧数据为准
    return `  mkdir -p ${target} && cp -R ${from}/. ${target}/ && rm -r ${from}`
  })
  return [
    `[数据] 发现旧位置的数据（${moves.map(([old]) => old).join('、')}），现在的数据目录是 ${dataDir}。`,
    '要继续使用，退出后执行下面的命令（同名文件以旧数据为准，最好在新目录里产生新会话 / 记忆之前执行）：',
    ...lines,
  ].join('\n')
}

/** 单引号包起来给 sh 用（路径里可能有空格、$、引号）。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
