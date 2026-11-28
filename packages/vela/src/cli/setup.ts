import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { getToolListError, THINKING_LEVELS } from '../driver/diagnostics.ts'
import type { ModelInfo, ThinkingLevel } from '../driver/index.ts'
import { projectTrustRequired } from '../load-config.ts'
import type { VelaRuntime } from '../runtime-sdk-types.ts'
import { selectTools } from '../shared/tool-selection.ts'

export { cliVersion as packageVersion } from './version.ts'
export { selectTools }

type DaemonSubcommand = 'start' | 'stop' | 'status' | 'run'

export class RetiredCommandError extends Error {
  readonly exitCode = 2
  constructor(message: string) {
    super(message)
    this.name = 'RetiredCommandError'
  }
}

export interface CliArgs {
  agentDir?: string
  daemon?: DaemonSubcommand
  daemonHelp?: boolean
  setup?: boolean
  setupTarget?: 'lark' | 'github'
  setupRepositories?: string[]
  setupUrl?: string
  /** `-p, --print`: run the given prompts and exit; stdout gets only the last answer (like pi) */
  print: boolean
  /** `--mode text | json` (like pi): json writes one line per runtime event */
  mode?: 'text' | 'json'
  /** Arguments not starting with `-`: prompts sent in order (like pi) */
  messages: string[]
  /** `-c, --continue`: continue the most recent session for this directory */
  continue: boolean
  /** `-r, --resume`: pick a saved session */
  resume: boolean
  /** `--session <id>`: open this session (created if missing) */
  session?: string
  /** `-e, --extension <path>` (repeatable), or `builtin:<name>` */
  extensions: string[]
  /** `--no-extensions`: skip built-in and discovered extensions (`-e` still loads), like pi */
  noExtensions: boolean
  /** `--no-session`: keep the session in an isolated ephemeral runtime in memory */
  noSession: boolean
  /** `--fork <id>`: start in a new session copied from this saved one (like pi) */
  fork?: string
  /** `--export <sessionId> [output]`: write the saved session as HTML or JSONL and exit */
  export?: string
  /** `--approve` / `--no-approve`: trust / don't trust project config for this run, without saving */
  approve?: boolean
  /** `--model provider/id` */
  model?: string
  /** `--thinking <level>` */
  thinking?: ThinkingLevel
  /** `--append-system-prompt <text or file>` (repeatable, like pi); replaces APPEND_SYSTEM.md */
  appendSystemPrompt: string[]
  /** `--system-prompt <text or file>` (repeatable, like pi); replaces SYSTEM.md and the default prompt */
  systemPrompt: string[]
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
  'Usage: vela [prompt...] [-p | --mode text|json] [-c | -r | --session <id> | --fork <id>] [--export <id> [output]] [--agent-dir <dir>] [-e <extension>]... [--no-extensions] [--no-session] [--approve | --no-approve] [--model provider/id] [--thinking <level>] [--system-prompt <text|file>]... [--append-system-prompt <text|file>]... [--no-context-files] [-t <tools>] [-nt] [-xt <tools>] [--list-models [search]] [-h | --help] [-v | --version]\n       vela daemon [start | stop | status | run]\n       vela setup [lark]\n       vela setup github owner/repo [owner/repo...] --url https://origin'

export const DAEMON_HELP = `vela daemon - manage the local single-writer Vela background daemon

Usage:
  vela daemon start    Start the resident daemon (or report existing PID/socket)
  vela daemon stop     Gracefully stop the resident daemon and its child jobs
  vela daemon status   Show whether the daemon is running, PID, and socket path
  vela daemon run      Run the daemon server in the foreground (internal / systemd)
`

/** `vela --help` (like pi's: usage, every flag, modes, examples, environment). */
export const HELP = `vela - terminal agent with pi-style extensions

Usage:
  vela [options] [prompt...]
  vela daemon [start | stop | status | run]
  vela setup [lark]
  vela setup github owner/repo [owner/repo...] --url https://origin

Daemon:
  Local CLI invocations connect to a resident single-writer daemon on
  <VELA_DIR>/vela.sock (auto-started on demand). Use \`vela daemon status|stop\`
  or the \`connectRuntime()\` SDK to interact with it.

GitHub setup:
  Configure repository webhooks using logged-in gh (github.com). Missing inputs are prompted
  in a terminal. --url is an HTTPS origin, with no credentials, path, query or fragment.
  Exit codes: 0 success or cancelled; 1 invalid configuration or local/gh/repository failure;
  2 missing non-interactive inputs or invalid command options.

Modes:
  (default)                     Interactive TUI when stdin and stdout are a terminal
  daemon [start|stop|status]    Manage the local single-writer background daemon
  setup                         Configure a model provider interactively
  -p, --print                   Run the prompts and exit; stdout gets only the last answer
                                (also used when stdin or stdout is redirected)
  --mode <text|json>            text: like -p; json: one RuntimeEvent / StreamDelta JSON line per event

Options:
  -c, --continue                Continue the most recent session for the current directory
  -r, --resume                  Pick a saved session (interactive mode only)
  --session <id>                Open this session (created if missing)
  --no-session                  Keep the session in memory only, not on disk
  --fork <id>                   Start in a new session copied from a saved session
  --export <id> [output]        Write a saved session from vela.db as HTML (or JSONL for .jsonl) and exit
  --agent-dir <dir>             Override VELA_DIR (owner data directory)
  --model <provider/id>         Model to use (providers: built-in anthropic / openai / openrouter / deepseek,
                                ~/.vela/config.json, extensions)
  --thinking <level>            Thinking level: ${THINKING_LEVELS.join(', ')}
  --system-prompt <text>        Replace the default system prompt with text or a file's contents
                                (repeatable; replaces ~/.vela/SYSTEM.md and .vela/SYSTEM.md)
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
on the first prompt. Missing files exit 1. In the TUI, Ctrl+V (Windows: Alt+V) pastes clipboard files
as their paths, an image as a temporary file path for read, or clipboard text.

Examples:
  # Interactive mode
  vela

  # Manage the resident daemon
  vela daemon start
  vela daemon status
  vela daemon stop

  # Interactive mode with an initial prompt
  vela "List all .ts files in src/"

  # Print mode: answer and exit
  vela -p "Summarize README.md"

  # Attach an image to the first prompt
  vela @shot.png "What is this?"

  # Piped stdin is prepended to the first prompt
  git diff | vela -p "Review this change"

  # Continue the most recent session in this directory
  vela -c "What did we discuss?"

  # Pick a model and thinking level
  vela --model anthropic/<model-id> --thinking high "Plan the refactor"

  # Read-only tools only
  vela --tools read,grep,find,ls -p "Review the code in src/"

  # Everything except bash
  vela --exclude-tools bash

  # One JSON event per line, for scripts
  vela --mode json "Run the tests"

  # Offline demo model, no API key needed
  VELA_MODEL=mock vela

Environment variables:
  OPENAI_API_KEY                API key for the built-in openai provider
  OPENAI_API_BASE_URL           Base URL for the built-in openai provider
  ANTHROPIC_API_KEY             API key for the built-in anthropic provider
  OPENROUTER_API_KEY            API key for the built-in openrouter provider
  DEEPSEEK_API_KEY              API key for the built-in deepseek provider
  VELA_DIR                      User directory (default: ~/.vela)
  VELA_MODEL                    mock: offline demo model; faux:<scenario.json>: replay a recorded scenario
  VELA_RECORD                   Record this run as a faux scenario at the given path
  VELA_OFFLINE                  1: never download ripgrep / fd
  VELA_DEBUG                    1: debug logging (interactive mode: ~/.vela/debug.log)
`

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function assertCliSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) {
    throw new Error(
      `Invalid session id "${id}": must match ${SESSION_ID_RE.source}`,
    )
  }
}

function toolList(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
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
    systemPrompt: [],
    noContextFiles: false,
    noTools: false,
    excludeTools: [],
  }
  if (argv[0] === 'serve') {
    throw new RetiredCommandError(
      '`vela serve` was retired in v0.9: use `vela daemon start` (or `vela daemon status|stop`) and `connectRuntime()` instead.',
    )
  }
  if (argv[0] === 'setup' && argv[1] === 'github') {
    args.setup = true
    args.setupTarget = 'github'
    args.setupRepositories = []
    for (let i = 2; i < argv.length; i++) {
      const arg = argv[i]!
      if (arg === '--help' || arg === '-h') args.help = true
      else if (arg === '--url') {
        if (args.setupUrl !== undefined)
          throw new Error('--url may only be provided once')
        const next = argv[++i]
        if (!next || next.startsWith('-'))
          throw new Error('--url requires a value')
        args.setupUrl = next
      } else if (arg.startsWith('-'))
        throw new Error(`Unknown GitHub setup option ${arg}`)
      else args.setupRepositories.push(arg)
    }
    return args
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} requires a value`)
      return next
    }
    if (i === 0 && arg === 'setup') {
      args.setup = true
      if (argv[i + 1] === 'lark') {
        args.setupTarget = 'lark'
        i++
      }
    } else if (arg === 'daemon' && !args.daemon && args.messages.length === 0) {
      const next = argv[i + 1]
      if (next === '--help' || next === '-h') {
        args.daemonHelp = true
        i++
      } else if (
        next === 'start' ||
        next === 'stop' ||
        next === 'status' ||
        next === 'run'
      ) {
        args.daemon = next
        i++
      } else if (next && !next.startsWith('-')) {
        throw new Error(
          `Unknown daemon subcommand "${next}": expected start, stop, status, or run`,
        )
      } else {
        args.daemon = 'status'
      }
    } else if (arg === 'serve' && !args.daemon && args.messages.length === 0) {
      throw new RetiredCommandError(
        '`vela serve` was retired in v0.9: use `vela daemon start` (or `vela daemon status|stop`) and `connectRuntime()` instead.',
      )
    } else if (arg === '-h' || arg === '--help') {
      if (args.daemon) args.daemonHelp = true
      else args.help = true
    } else if (arg === '-v' || arg === '--version') args.version = true
    else if (arg === '-p' || arg === '--print') args.print = true
    else if (arg === '--agent-dir') args.agentDir = value()
    else if (arg === '--mode') {
      const mode = value()
      if (mode === 'rpc') {
        throw new RetiredCommandError(
          '`--mode rpc` was retired in v0.9: use `connectRuntime()` from `@glows777/vela` or `--mode json` instead.',
        )
      }
      if (mode !== 'text' && mode !== 'json')
        throw new Error('--mode must be text or json')
      args.mode = mode
    } else if (arg === '-c' || arg === '--continue') args.continue = true
    else if (arg === '-r' || arg === '--resume') args.resume = true
    else if (arg === '--session') {
      args.session = value()
      assertCliSessionId(args.session)
    } else if (arg === '--fork') {
      args.fork = value()
      assertCliSessionId(args.fork)
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
    else if (arg === '--system-prompt') args.systemPrompt.push(value())
    else if (arg === '--no-context-files' || arg === '-nc')
      args.noContextFiles = true
    else if (arg === '--tools' || arg === '-t') {
      const next = toolList(value())
      const err = getToolListError(next)
      if (err) throw new Error(`Invalid --tools list: ${err}`)
      args.tools = [...(args.tools ?? []), ...next]
    } else if (arg === '--no-tools' || arg === '-nt') args.noTools = true
    else if (arg === '--exclude-tools' || arg === '-xt')
      args.excludeTools.push(...toolList(value()))
    else if (arg === '--list-models') {
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
  if (
    args.setup &&
    (args.messages.length ||
      args.mode ||
      args.print ||
      args.daemon ||
      args.resume ||
      args.continue ||
      args.session ||
      args.fork ||
      args.export ||
      args.listModels)
  )
    throw new Error(
      'vela setup does not take a prompt, run mode or session option',
    )
  if (args.daemon && args.messages.length > 0) {
    throw new Error('vela daemon does not accept positional prompts')
  }
  return args
}

function isSubsequence(haystack: string, needle: string): boolean {
  let pos = 0
  for (const ch of needle) {
    const idx = haystack.indexOf(ch, pos)
    if (idx === -1) return false
    pos = idx + 1
  }
  return true
}

function matchesTokens(text: string, query: string): boolean {
  const haystack = text.toLowerCase()
  for (const token of query
    .trim()
    .toLowerCase()
    .split(/[\s/]+/)) {
    if (!token) continue
    if (isSubsequence(haystack, token)) continue
    const swapped =
      token.match(/^([a-z]+)([0-9]+.*)$/) ?? token.match(/^([0-9]+)([a-z]+.*)$/)
    if (!swapped || !isSubsequence(haystack, `${swapped[2]}${swapped[1]}`))
      return false
  }
  return true
}

/**
 * `--list-models` output (like pi's): provider, model, context window and thinking support.
 */
export function formatModelList(
  models: readonly ModelInfo[],
  search?: string,
): string {
  if (!models.length)
    return 'No models available: sign in with /login, or set a provider API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, DEEPSEEK_API_KEY) or a provider in ~/.vela/config.json.\n'
  const found = (
    search
      ? [...models].filter((m) =>
          matchesTokens(`${m.provider} ${m.id}`, search),
        )
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
 * Resolves workspace trust over `VelaRuntime['trust']` (`--approve / --no-approve` -> saved decision in `vela.db` -> interactive prompt).
 */
export async function resolveTrust(options: {
  cwd: string
  agentDir: string
  approve?: boolean
  interactive: boolean
  noSession?: boolean
  trust?: VelaRuntime['trust']
}): Promise<{ trusted: boolean; warning?: string }> {
  const { cwd, agentDir } = options
  if (!projectTrustRequired(cwd, agentDir)) return { trusted: false }
  if (options.approve !== undefined) return { trusted: options.approve }
  const saved = options.trust ? await options.trust.check(cwd) : undefined
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
    `${resolve(cwd)} has project config (.vela/config.json, .vela/extensions/, .vela/prompts/, .vela/SYSTEM.md, .vela/APPEND_SYSTEM.md, or skills in .vela/skills/, .skills/ or .agents/skills/).\nExtensions are code that runs on this machine; skills, prompts, SYSTEM.md and APPEND_SYSTEM.md are instructions for the model. Trust this project and load it? (y/N) `,
  )
  const trusted = answer === 'y' || answer === 'yes'
  if (options.trust) await options.trust.approve(cwd, trusted)
  return trusted
    ? { trusted }
    : {
        trusted,
        warning: notTrusted(
          cwd,
          agentDir,
          options.noSession
            ? 'not saved under --no-session'
            : 'this choice was saved',
        ),
      }
}

function notTrusted(cwd: string, agentDir: string, reason: string): string {
  return `[trust] Did not load config, extensions, skills and prompts from ${resolve(cwd)} (${reason}; pass --approve or update trusted_paths in ${join(agentDir, 'vela.db')} to change this)`
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
