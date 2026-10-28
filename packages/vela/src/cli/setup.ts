import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fuzzyFilter } from '@earendil-works/pi-tui'
import type { ChannelExtension as VelaExtension } from '@glows777/vela-channels'
import type { ModelInfo, ThinkingLevel } from '@glows777/vela-core'
import { memory, permissionGate, web, webConfig } from '@glows777/vela-core'
import {
  assertSessionId,
  getToolListError,
  isToolModifier,
  THINKING_LEVELS,
} from '@glows777/vela-core/diagnostics'
import { feishu, larkConfig } from '@glows777/vela-lark'
import { mcp } from '@glows777/vela-mcp'
import { rag, ragConfig } from '@glows777/vela-rag'
import {
  type ExtensionEntry,
  extensionName,
  importExtension,
  projectTrustRequired,
  savedTrust,
  saveTrust,
  type VelaConfig,
} from '../config/index.ts'
import { applyToolModifiers, type ToolLoadout } from './tool-selection.ts'

type Env = Record<string, string | undefined>

/** Built-in extensions shipped with the CLI (`builtin:<name>`); DEFAULT_OFF_BUILTINS stay off unless enabled. Config comes from `extensionConfig.<name>`. */
export const BUILTIN_EXTENSIONS: Record<string, () => VelaExtension> = {
  memory: () => memory(),
  rag: () => rag(),
  web: () => web(),
  feishu: () => feishu(),
  mcp: () => mcp(),
  'permission-gate': () => permissionGate(),
}

/** Built-ins that stay off until `+builtin:<name>` in settings or `-e builtin:<name>` enables one */
export const DEFAULT_OFF_BUILTINS: readonly string[] = ['permission-gate']

export interface CliArgs {
  /** `serve`: run the configured channels without the TUI, until a signal stops the process */
  serve: boolean
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
  /** `--no-session`: keep the session in memory only, not on disk (tool history and usage stay out of the data directory; memory and the knowledge base work as usual) */
  noSession: boolean
  /** `--fork <id>`: start in a new session copied from this saved one (like pi) */
  fork?: string
  /** `--export <id or .jsonl file> [output]`: write the session as HTML and exit (like pi) */
  export?: string
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
  'Usage: vela [prompt...] [-p | --mode text|json|rpc] [-c | -r | --session <id> | --fork <id>] [--export <id|file> [output]] [-e <extension>]... [--no-extensions] [--no-session] [--approve | --no-approve] [--model provider/id] [--thinking <level>] [--append-system-prompt <text|file>]... [--no-context-files] [-t <tools>] [-nt] [-xt <tools>] [--list-models [search]] [-h | --help] [-v | --version]\n       vela serve [options]'

/** `vela --help` (like pi's: usage, every flag, modes, examples, environment). */
export const HELP = `vela - terminal agent with pi-style extensions

Usage:
  vela [options] [prompt...]
  vela serve [options]

Modes:
  (default)                     Interactive TUI when stdin and stdout are a terminal
  serve                         Run the configured channels without the TUI: one line per channel
                                event on stderr, stops on Ctrl-C / SIGTERM
  -p, --print                   Run the prompts and exit; stdout gets only the last answer
                                (also used when stdin or stdout is redirected)
  --mode <text|json|rpc>        text: like -p; json: one JSON line per event; rpc: JSON commands on stdin

Options:
  -c, --continue                Continue the most recent session
  -r, --resume                  Pick a saved session (interactive mode only)
  --session <id>                Open this session (created if missing)
  --no-session                  Keep the session in memory only, not on disk
  --fork <id>                   Start in a new session copied from a saved session
  --export <id|file> [output]   Write a saved session (id or .jsonl file) as HTML and exit
  --model <provider/id>         Model to use (providers: built-in openai / anthropic, ~/.vela/models.json, extensions)
  --thinking <level>            Thinking level: ${THINKING_LEVELS.join(', ')}
  --append-system-prompt <text> Append text or a file's contents to the system prompt (repeatable;
                                replaces ~/.vela/APPEND_SYSTEM.md and .vela/APPEND_SYSTEM.md)
  -nc, --no-context-files       Don't load AGENTS.md / CLAUDE.md
  -t, --tools <tools>           Comma-separated tools: names or * patterns enable only those, +name / -name
                                entries change the default set (repeatable)
  -nt, --no-tools               Start with no tools (--tools still enables the ones it names)
  -xt, --exclude-tools <tools>  Comma-separated tools to disable (names or * patterns)
  --list-models [search]        List the configured models (optional fuzzy search) and exit
  -e, --extension <path>        Load an extension file or directory, or builtin:<name> (repeatable)
  -ne, --no-extensions          Skip built-in and discovered extensions (-e still loads)
  --approve                     Trust project config, extensions, skills and prompts for this run (not saved)
  --no-approve                  Ignore project config, extensions, skills and prompts for this run (not saved)
  -h, --help                    Show this help
  -v, --version                 Show the version number

Prompts are sent in order. In interactive mode, text starting with / is a command (/hotkeys, /status,
/context, /usage, /skill, /model, ...), /skill:<name> sends a skill and /<template> expands a prompt template;
anything else goes to the model.

Command-line @file arguments attach images (detected by header) or inline text in <file name="…">…</file>
on the first prompt. Missing files exit 1. In the TUI, Ctrl+V (Windows: Alt+V) pastes a clipboard image
as a temporary file path for read_file. Images in history show a short placeholder.

Examples:
  # Interactive mode
  vela

  # Run the configured channels in the background
  vela serve

  # Interactive mode with an initial prompt
  vela "List all .ts files in src/"

  # Print mode: answer and exit
  vela -p "Summarize README.md"

  # Attach an image to the first prompt
  vela @shot.png "What is this?"

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
    serve: false,
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
    if (i === 0 && arg === 'serve') args.serve = true
    else if (arg === '-h' || arg === '--help') args.help = true
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
    } else if (arg === '--fork') {
      args.fork = value()
      assertSessionId(args.fork)
    } else if (arg === '--export') args.export = value()
    else if (arg === '-e' || arg === '--extension')
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
      if (next !== undefined && !next.startsWith('-')) {
        args.listModels = next
        i++
      } else args.listModels = true
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
    [
      args.continue,
      args.resume,
      args.session !== undefined,
      args.fork !== undefined,
    ].filter(Boolean).length > 1
  )
    throw new Error('Use only one of -c, -r, --session and --fork')
  // `serve` has no single session and no prompt: a flag that only configures one would be ignored
  if (args.serve) {
    const unsupported = [
      args.messages.length > 0 && 'a prompt',
      args.print && '-p/--print',
      args.mode && '--mode',
      args.export && '--export',
      args.listModels && '--list-models',
      args.continue && '-c/--continue',
      args.resume && '-r/--resume',
      args.session && '--session',
      args.fork && '--fork',
      args.tools?.length && '-t/--tools',
      args.noTools && '-nt/--no-tools',
      args.excludeTools.length > 0 && '-xt/--exclude-tools',
    ].filter((entry): entry is string => typeof entry === 'string')
    if (unsupported.length > 0)
      throw new Error(
        `vela serve runs channels only; it does not take ${unsupported.join(', ')}`,
      )
  }
  return args
}

function toolList(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}

/**
 * The tools a session starts with, from `--tools / --no-tools / --exclude-tools` and the
 * `defaultTools` setting (like pi), or undefined for the default set. Plain entries are names or
 * `*` patterns and replace the setting; `+name` / `-name` entries adjust the default set instead.
 * One entry that matches no registered tool is an error (pi ignores it; a typo would silently
 * leave a tool on or off).
 */
export function selectTools(
  available: readonly string[],
  args: Pick<CliArgs, 'tools' | 'noTools' | 'excludeTools'>,
  defaultTools?: readonly string[],
): ToolLoadout | undefined {
  const entries = args.tools ?? []
  const listError = getToolListError(entries)
  if (listError) throw new Error(`Invalid --tools list: ${listError}`)
  const plain = entries.filter((entry) => !isToolModifier(entry))
  const modifiers = entries.filter(isToolModifier)
  // A plain --tools list replaces the setting, so the setting's entries are not in play then
  const requested =
    plain.length > 0
      ? [...plain, ...args.excludeTools]
      : [...[...(defaultTools ?? []), ...entries], ...args.excludeTools].map(
          (entry) => (isToolModifier(entry) ? entry.slice(1) : entry),
        )
  const unknown = requested.filter(
    (entry) => !available.some(toolMatcher(entry)),
  )
  if (unknown.length)
    throw new Error(
      `Unknown tool${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Available: ${available.join(', ')}`,
    )
  const matches = (names: readonly string[]) => (name: string) =>
    names.some((entry) => toolMatcher(entry)(name))
  // The setting's plain names and * patterns select exactly those tools; only modifiers adjust the
  // default set. Its modifiers apply after the patterns are expanded, so a project's `-name` removes
  // a tool the user selected with a pattern. An empty list selects nothing (pi keeps the user's list).
  const settingsPlain = defaultTools?.filter((entry) => !isToolModifier(entry))
  const settingsSelection =
    settingsPlain && (settingsPlain.length > 0 || defaultTools?.length === 0)
      ? applyToolModifiers(
          available.filter(matches(settingsPlain)),
          (defaultTools ?? []).filter(isToolModifier),
        )
      : undefined
  let selection: string[] | undefined
  let adjusted = modifiers
  if (modifiers.length > 0) {
    if (args.noTools) selection = applyToolModifiers([], modifiers)
    else if (settingsSelection)
      selection = applyToolModifiers(settingsSelection, modifiers)
    else adjusted = [...(defaultTools ?? []), ...modifiers]
  } else if (plain.length > 0) {
    selection = available.filter(matches(plain))
  } else if (args.noTools) {
    selection = []
  } else if (settingsSelection) {
    selection = settingsSelection
  } else if (defaultTools?.length) {
    adjusted = defaultTools.filter(isToolModifier)
  }
  const excluded = available.filter(matches(args.excludeTools))
  if (selection)
    selection = selection.filter((name) => !excluded.includes(name))
  else adjusted = [...adjusted, ...excluded.map((name) => `-${name}`)]
  if (selection) return { selection }
  return adjusted.length > 0 ? { modifiers: adjusted } : undefined
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
 * provider and id. Only providers with a credential (auth.json, models.json or an environment variable) appear.
 */
export function formatModelList(
  models: readonly ModelInfo[],
  search?: string,
): string {
  if (!models.length)
    return 'No models available: sign in with /login, or set a provider API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY) or a provider in ~/.vela/models.json.\n'
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
  const result = { ...fromSettings }
  const context = { cwd: '', agentDir: '', projectDir: '', trusted: false, env }
  for (const definition of [webConfig, larkConfig, ragConfig])
    result[definition.name] = definition.resolve(
      result[definition.name] ?? {},
      context,
    )
  return result
}

/**
 * The mcp extension's config: the servers from mcp.json (with where each came from and the errors
 * found reading them) override `extensionConfig.mcp.mcpServers` from settings.json.
 */
export function withMcpServers(
  extensionConfig: Record<string, Record<string, unknown>>,
  config: Pick<VelaConfig, 'mcp'>,
): Record<string, Record<string, unknown>> {
  const { servers, sources, errors } = config.mcp
  const section = extensionConfig.mcp ?? {}
  const fromSettings =
    typeof section.mcpServers === 'object' && section.mcpServers !== null
      ? (section.mcpServers as Record<string, unknown>)
      : {}
  return {
    ...extensionConfig,
    mcp: {
      ...section,
      mcpServers: { ...fromSettings, ...servers },
      sources,
      errors,
    },
  }
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
