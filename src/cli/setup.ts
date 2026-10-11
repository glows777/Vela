import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fuzzyFilter } from '@earendil-works/pi-tui'
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
import type { VelaExtension } from '../extensions/types.ts'
import { web } from '../extensions/web/index.ts'
import {
  type ModelInfo,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '../models/index.ts'
import { assertSessionId } from '../vela-session.ts'

type Env = Record<string, string | undefined>

/** Built-in extensions shipped with the CLI (`builtin:<name>`), all loaded by default; config comes from `extensionConfig.<name>`. */
export const BUILTIN_EXTENSIONS: Record<string, () => VelaExtension> = {
  memory: () => memory(),
  rag: () => rag(),
  web: () => web(),
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
  /** `--append-system-prompt <text or file>` (repeatable, like pi); replaces APPEND_SYSTEM.md */
  appendSystemPrompt: string[]
  /** `--no-context-files` (`-nc`): don't load AGENTS.md / CLAUDE.md */
  noContextFiles: boolean
  /** `-t, --tools <a,b,c*>`: enable only these tools (names or `*` patterns, like pi) */
  tools?: string[]
  /** `-nt, --no-tools`: start with no tools (`--tools` still adds) */
  noTools: boolean
  /** `-xt, --exclude-tools <a,b,c*>`: disable these tools (names or `*` patterns) */
  excludeTools: string[]
  /** `--list-models [search]`: print the configured models (fuzzy-filtered) and exit; `true` without a search */
  listModels?: string | true
  /** `-h, --help`: print HELP and exit */
  help?: boolean
  /** `-v, --version`: print the package version and exit */
  version?: boolean
}

export const USAGE =
  'Usage: vela [prompt...] [-p | --mode text|json|rpc] [-c | -r | --session <id>] [-e <extension>]... [--no-extensions] [--no-session] [--approve | --no-approve] [--model provider/id] [--thinking <level>] [--append-system-prompt <text|file>]... [--no-context-files] [-t <tools>] [-nt] [-xt <tools>] [--list-models [search]] [-h | --help] [-v | --version]'

/** `vela --help` (like pi's: usage, every flag, modes, examples, environment). */
export const HELP = `vela - terminal agent with pi-style extensions

Usage:
  vela [options] [prompt...]

Modes:
  (default)                     Interactive TUI when stdin and stdout are a terminal
  -p, --print                   Run the prompts and exit; stdout gets only the last answer
                                (also used when stdin or stdout is redirected)
  --mode <text|json|rpc>        text: like -p; json: one JSON line per event; rpc: JSON commands on stdin

Options:
  -c, --continue                Continue the most recent session
  -r, --resume                  Pick a saved session (interactive mode only)
  --session <id>                Open this session (created if missing)
  --no-session                  Keep the session in memory only, not on disk
  --model <provider/id>         Model to use (providers: built-in openai / anthropic, ~/.vela/models.json, extensions)
  --thinking <level>            Thinking level: ${THINKING_LEVELS.join(', ')}
  --append-system-prompt <text> Append text or a file's contents to the system prompt (repeatable;
                                replaces ~/.vela/APPEND_SYSTEM.md and .vela/APPEND_SYSTEM.md)
  -nc, --no-context-files       Don't load AGENTS.md / CLAUDE.md
  -t, --tools <tools>           Comma-separated tools to enable (names or * patterns); all others are off
  -nt, --no-tools               Start with no tools (--tools still enables the ones it names)
  -xt, --exclude-tools <tools>  Comma-separated tools to disable (names or * patterns)
  --list-models [search]        List the configured models (optional fuzzy search) and exit
  -e, --extension <path>        Load an extension file or directory, or builtin:<name> (repeatable)
  -ne, --no-extensions          Skip built-in and discovered extensions (-e still loads)
  --approve                     Trust project config, extensions, skills and prompts for this run (not saved)
  --no-approve                  Ignore project config, extensions, skills and prompts for this run (not saved)
  -h, --help                    Show this help
  -v, --version                 Show the version number

Prompts are sent in order. In interactive mode, text starting with / is a command (/hotkeys, /context,
/usage, /skill, /model, ...), /skill:<name> sends a skill and /<template> expands a prompt template;
anything else goes to the model.

Examples:
  # Interactive mode
  vela

  # Interactive mode with an initial prompt
  vela "List all .ts files in src/"

  # Print mode: answer and exit
  vela -p "Summarize README.md"

  # Piped stdin is prepended to the first prompt
  git diff | vela -p "Review this change"

  # Continue the most recent session
  vela -c "What did we discuss?"

  # Pick a model and thinking level
  vela --model anthropic/<model-id> --thinking high "Plan the refactor"

  # Read-only tools only
  vela --tools read_file,grep,find,list_directory -p "Review the code in src/"

  # Everything except bash
  vela --exclude-tools bash

  # One JSON event per line, for scripts
  vela --mode json "Run the tests"

  # Offline demo model, no API key needed
  VELA_MODEL=mock vela

Environment variables:
  OPENAI_API_KEY                API key for the built-in openai provider
  OPENAI_API_BASE_URL           Base URL for the built-in openai provider
  OPENAI_API_MODEL_NAME         Default model id for openai when no --model / defaultModel is set
  ANTHROPIC_API_KEY             API key for the built-in anthropic provider
  VELA_DIR                      User directory (default: ~/.vela)
  VELA_MODEL                    mock: offline demo model; faux:<scenario.json>: replay a recorded scenario
  VELA_RECORD                   Record this run as a faux scenario at the given path
  VELA_OFFLINE                  1: never download ripgrep / fd
  VELA_DEBUG                    1: debug logging (interactive mode: ~/.vela/debug.log)
`

/** The package version, read from package.json two levels up (src/cli/ and dist/cli/ both sit there). */
export function packageVersion(): string {
  const file = new URL('../../package.json', import.meta.url)
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    print: false,
    messages: [],
    continue: false,
    resume: false,
    extensions: [],
    noExtensions: false,
    noSession: false,
    appendSystemPrompt: [],
    noContextFiles: false,
    noTools: false,
    excludeTools: [],
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} requires a value`)
      return next
    }
    if (arg === '-h' || arg === '--help') args.help = true
    else if (arg === '-v' || arg === '--version') args.version = true
    else if (arg === '-p' || arg === '--print') args.print = true
    else if (arg === '--mode') {
      const mode = value()
      if (mode !== 'text' && mode !== 'json' && mode !== 'rpc')
        throw new Error('--mode must be text, json or rpc')
      args.mode = mode
    } else if (arg === '-c' || arg === '--continue') args.continue = true
    else if (arg === '-r' || arg === '--resume') args.resume = true
    else if (arg === '--session') {
      args.session = value()
      assertSessionId(args.session)
    } else if (arg === '-e' || arg === '--extension')
      args.extensions.push(value())
    else if (arg === '--no-extensions' || arg === '-ne')
      args.noExtensions = true
    else if (arg === '--no-session') args.noSession = true
    else if (arg === '--approve') args.approve = true
    else if (arg === '--no-approve') args.approve = false
    else if (arg === '--model') args.model = value()
    else if (arg === '--append-system-prompt')
      args.appendSystemPrompt.push(value())
    else if (arg === '--no-context-files' || arg === '-nc')
      args.noContextFiles = true
    else if (arg === '--tools' || arg === '-t')
      args.tools = [...(args.tools ?? []), ...toolList(value())]
    else if (arg === '--no-tools' || arg === '-nt') args.noTools = true
    else if (arg === '--exclude-tools' || arg === '-xt')
      args.excludeTools.push(...toolList(value()))
    else if (arg === '--list-models') {
      // Like pi: the next argument is the search unless it is an option
      const next = argv[i + 1]
      args.listModels =
        next !== undefined && !next.startsWith('-') ? (i++, next) : true
    } else if (arg === '--thinking') {
      const level = value()
      if (!THINKING_LEVELS.includes(level as ThinkingLevel))
        throw new Error(
          `--thinking must be one of ${THINKING_LEVELS.join(' / ')}`,
        )
      args.thinking = level as ThinkingLevel
    } else if (arg.startsWith('-') && arg !== '-')
      throw new Error(`Unknown option ${arg}`)
    else args.messages.push(arg)
  }
  if (
    [args.continue, args.resume, args.session !== undefined].filter(Boolean)
      .length > 1
  )
    throw new Error('Use only one of -c, -r and --session')
  return args
}

function toolList(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}

/**
 * The tools a session enables for `--tools / --no-tools / --exclude-tools` (like pi), or undefined
 * for all. Entries are names or `*` patterns; one that matches no registered tool is an error
 * (pi ignores it; a typo would silently leave a tool on or off).
 */
export function selectTools(
  available: readonly string[],
  args: Pick<CliArgs, 'tools' | 'noTools' | 'excludeTools'>,
): string[] | undefined {
  if (!args.tools && !args.noTools && !args.excludeTools.length) return
  const unknown = [...(args.tools ?? []), ...args.excludeTools].filter(
    (entry) => !available.some(toolMatcher(entry)),
  )
  if (unknown.length)
    throw new Error(
      `Unknown tool${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Available: ${available.join(', ')}`,
    )
  const matches = (entries: readonly string[]) => (name: string) =>
    entries.some((entry) => toolMatcher(entry)(name))
  const enabled = args.tools
    ? available.filter(matches(args.tools))
    : args.noTools
      ? []
      : [...available]
  return enabled.filter((name) => !matches(args.excludeTools)(name))
}

function toolMatcher(entry: string): (name: string) => boolean {
  if (!entry.includes('*')) return (name) => name === entry
  const pattern = new RegExp(
    `^${entry
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  )
  return (name) => pattern.test(name)
}

/**
 * `--list-models` output (like pi's): provider, model, context window and thinking support, sorted by
 * provider and id. Vela has no built-in model catalog, so only models listed in models.json, settings
 * or by extensions appear.
 */
export function formatModelList(
  models: readonly ModelInfo[],
  search?: string,
): string {
  if (!models.length)
    return 'No models configured. List them in ~/.vela/models.json (or in an extension provider); any provider/id still works with --model.\n'
  const found = (
    search
      ? fuzzyFilter([...models], search, (m) => `${m.provider} ${m.id}`)
      : [...models]
  ).sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
  )
  if (!found.length) return `No models matching "${search}"\n`
  const rows = [
    ['provider', 'model', 'context', 'thinking'],
    ...found.map((m) => [
      m.provider,
      m.id,
      m.contextWindow ? tokenCount(m.contextWindow) : '-',
      m.reasoning === undefined ? '-' : m.reasoning ? 'yes' : 'no',
    ]),
  ]
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => row[column]!.length)),
  )
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
    .concat('\n')
}

/** 200000 → 200K, 1000000 → 1M (like pi) */
function tokenCount(count: number): string {
  const [value, unit] =
    count >= 1_000_000
      ? [count / 1_000_000, 'M']
      : count >= 1_000
        ? [count / 1_000, 'K']
        : [count, '']
  return `${value % 1 === 0 ? value : value.toFixed(1)}${unit}`
}

/**
 * Decide whether to load a project's `.vela/settings.json`, `.vela/extensions/` and project skills (like pi's project trust):
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
      : {
          trusted: false,
          warning: notTrusted(
            cwd,
            agentDir,
            'you chose not to trust it before',
          ),
        }
  if (!options.interactive)
    return {
      trusted: false,
      warning: notTrusted(
        cwd,
        agentDir,
        'non-interactive mode does not ask; pass --approve to trust it',
      ),
    }
  const answer = await question(
    `${resolve(cwd)} has project config (.vela/settings.json, .vela/extensions/, .vela/prompts/, .vela/APPEND_SYSTEM.md, or skills in .vela/skills/, .skills/ or .agents/skills/).\nExtensions are code that runs on this machine; skills, prompts and APPEND_SYSTEM.md are instructions for the model. Trust this project and load it? (y/N) `,
  )
  const trusted = answer === 'y' || answer === 'yes'
  saveTrust(agentDir, cwd, trusted)
  return trusted
    ? { trusted }
    : { trusted, warning: notTrusted(cwd, agentDir, 'this choice was saved') }
}

function notTrusted(cwd: string, agentDir: string, reason: string): string {
  return `[trust] Did not load config, extensions, skills and prompts from ${resolve(cwd)} (${reason}; edit ${join(agentDir, 'trust.json')} to change this)`
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
        if (!factory)
          throw new Error(`Unknown built-in extension builtin:${entry.name}`)
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
export function legacyDataHint(
  cwd: string,
  dataDir: string,
): string | undefined {
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
