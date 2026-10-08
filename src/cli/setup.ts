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
} from '../config/index.ts'
import { deepMerge } from '../config/interpolate.ts'
import { feishu } from '../extensions/feishu/index.ts'
import { memory } from '../extensions/memory/index.ts'
import { rag } from '../extensions/rag/index.ts'
import { supabase } from '../extensions/supabase.ts'
import type { VelaExtension } from '../extensions/types.ts'
import { THINKING_LEVELS, type ThinkingLevel } from '../models/index.ts'
import { web } from '../extensions/web/index.ts'

type Env = Record<string, string | undefined>

/** Built-in extensions shipped with the CLI (`builtin:<name>`), all loaded by default; config comes from `extensionConfig.<name>`. */
export const BUILTIN_EXTENSIONS: Record<string, () => VelaExtension> = {
  memory: () => memory(),
  rag: () => rag(),
  web: () => web(),
  supabase: () => supabase(),
  feishu: () => feishu(),
}

export interface CliArgs {
  /** `-p, --print`: run the given prompts and exit; stdout gets only the last answer (like pi) */
  print: boolean
  /** `--mode text | json | rpc` (like pi): json writes one line per event, rpc reads commands from stdin */
  mode?: 'text' | 'json' | 'rpc'
  /** Arguments not starting with `-`: prompts sent in order (like pi) */
  messages: string[]
  /** `-c, --continue`: continue the most recent session */
  continue: boolean
  /** `-r, --resume`: pick a saved session */
  resume: boolean
  /** `--session <id>`: open this session (created if missing) */
  session?: string
  /** `-e, --extension <path>` (repeatable), or `builtin:<name>` */
  extensions: string[]
  /** `--no-extensions`: skip built-in and discovered extensions (`-e` still loads), like pi */
  noExtensions: boolean
  /** `--no-session`: keep the session in memory only, not on disk (memory and knowledge base work as usual) */
  noSession: boolean
  /** `--approve` / `--no-approve`: trust / don't trust project config for this run, without saving */
  approve?: boolean
  /** `--model provider/id` */
  model?: string
  /** `--thinking <level>` */
  thinking?: ThinkingLevel
}

export const USAGE =
  'Usage: vela [prompt...] [-p | --mode text|json|rpc] [-c | -r | --session <id>] [-e <extension>]... [--no-extensions] [--no-session] [--approve | --no-approve] [--model provider/id] [--thinking <level>]'

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
      if (next === undefined) throw new Error(`${arg} requires a value`)
      return next
    }
    if (arg === '-p' || arg === '--print') args.print = true
    else if (arg === '--mode') {
      const mode = value()
      if (mode !== 'text' && mode !== 'json' && mode !== 'rpc')
        throw new Error('--mode must be text, json or rpc')
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
        throw new Error(`--thinking must be one of ${THINKING_LEVELS.join(' / ')}`)
      args.thinking = level as ThinkingLevel
    } else if (arg.startsWith('-') && arg !== '-') throw new Error(`Unknown option ${arg}`)
    else args.messages.push(arg)
  }
  if ([args.continue, args.resume, args.session !== undefined].filter(Boolean).length > 1)
    throw new Error('Use only one of -c, -r and --session')
  return args
}

/**
 * Decide whether to load a project's `.vela/settings.json` or `.vela/extensions/` (like pi's project trust):
 * `--approve / --no-approve` → saved decision → ask once in interactive mode and save; untrusted when we can't ask.
 * `warning` in the result is the notice shown to the user when untrusted.
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
      : { trusted: false, warning: notTrusted(cwd, 'you chose not to trust it before') }
  if (!options.interactive)
    return {
      trusted: false,
      warning: notTrusted(cwd, 'non-interactive mode does not ask; pass --approve to trust it'),
    }
  const answer = await question(
    `${resolve(cwd)} has project config (.vela/settings.json or .vela/extensions/).\nExtensions are code that runs on this machine. Trust this project and load it? (y/N) `,
  )
  const trusted = answer === 'y' || answer === 'yes'
  saveTrust(agentDir, cwd, trusted)
  return trusted
    ? { trusted }
    : { trusted, warning: notTrusted(cwd, 'this choice was saved') }
}

function notTrusted(cwd: string, reason: string): string {
  return `[trust] Did not load config and extensions from ${join(resolve(cwd), '.vela')} (${reason}; edit ~/.vela/trust.json to change this)`
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
 * Built-in extension config defaults come from environment variables (those in `.env.example`);
 * `extensionConfig` in settings.json overrides them.
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
 * Load extensions from the loadConfig result and command-line args: built-in → discovered → `-e`.
 * Extensions that fail to load are skipped and the error goes to onError (like pi: report, don't exit).
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
        `[extensions] Failed to load ${key}: ${error instanceof Error ? error.message : error}`,
      )
    try {
      let extension: VelaExtension
      if ('builtin' in entry) {
        const factory = BUILTIN_EXTENSIONS[entry.name]
        if (!factory) throw new Error(`Unknown built-in extension builtin:${entry.name}`)
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
 * The extension function itself runs inside createVela(): a sync throw or async failure is only reported, so the CLI
 * still starts (the SDK's createVela still throws). Tools and commands registered before the failure are kept.
 */
function reportFailures(
  extension: VelaExtension,
  report: (error: unknown) => void,
): VelaExtension {
  const { name } = extension
  // A computed property name keeps the function name: the runner uses extension.name as the extension name
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
 * Older versions wrote data into cwd (`.sessions` etc.); if found, explain how to move it to the new data dir (no automatic move).
 * The commands are safe to rerun: once the old data is gone cp / mv fail without deleting anything, and a failed copy keeps the old data.
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
    // knowledge.db* moves together with any -journal / -wal / -shm files
    if (old === 'knowledge.db')
      return `  mkdir -p ${target} && mv ${from}* ${target}/`
    // The new dir may already hold files created by this launch (e.g. an empty MEMORY.md): merge, old data wins on name clashes
    return `  mkdir -p ${target} && cp -R ${from}/. ${target}/ && rm -r ${from}`
  })
  return [
    `[data] Found data in the old location (${moves.map(([old]) => old).join(', ')}); the data dir is now ${dataDir}.`,
    'To keep using it, exit and run the commands below (old data wins on name clashes; best run before new sessions / memories are created in the new dir):',
    ...lines,
  ].join('\n')
}

/** Single-quote for sh (paths may contain spaces, $ or quotes). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
