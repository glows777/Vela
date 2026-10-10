#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LanguageModel } from 'ai'
import {
  defaultAgentDir,
  loadConfig,
  type VelaConfig,
} from '../config/index.ts'
import { ModelRegistry } from '../models/index.ts'
import { memorySessionStorage } from '../session/storage.ts'
import { createMockModel } from '../testing/demo-model.ts'
import { loadFauxScenario } from '../testing/faux.ts'
import { recordModel } from '../testing/record.ts'
import { createVela, velaInternals } from '../vela.ts'
import type { VelaSession } from '../vela-session.ts'
import { runInteractive } from './interactive.ts'
import { redirectConsoleToStderr, writeStdout } from './json-event.ts'
import { createConsoleLogger, createInteractiveLogger } from './logger.ts'
import { runPrintMode } from './print-mode.ts'
import { runRpcMode } from './rpc-mode.ts'
import { newSessionId } from './sessions.ts'
import {
  BUILTIN_EXTENSIONS,
  type CliArgs,
  extensionConfigFromEnv,
  formatModelList,
  HELP,
  legacyDataHint,
  loadCliExtensions,
  packageVersion,
  parseArgs,
  resolveTrust,
  selectTools,
  USAGE,
} from './setup.ts'

const usageError = (message: string): never => {
  console.error(message)
  console.error(USAGE)
  process.exit(2)
}

let args: CliArgs
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  usageError(error instanceof Error ? error.message : String(error))
  throw error
}
// Like pi: --help / --version print to stdout and exit before any config, trust or model is read
if (args.help || args.version) {
  process.stdout.write(args.help ? HELP : `${packageVersion()}\n`)
  process.exit(0)
}
const env = process.env
const cwd = process.cwd()

/**
 * Run mode (like pi): `--mode rpc` / `--mode json` pick explicitly; `-p`, `--mode text` or redirected stdin / stdout
 * mean print mode; otherwise (in a terminal) interactive mode.
 */
const mode: 'interactive' | 'print' | 'json' | 'rpc' =
  args.mode === 'rpc'
    ? 'rpc'
    : args.mode === 'json'
      ? 'json'
      : args.print ||
          args.mode === 'text' ||
          !process.stdin.isTTY ||
          !process.stdout.isTTY
        ? 'print'
        : 'interactive'
// Non-interactive modes keep stdout for results / protocol: console output from extensions and the SDK goes to stderr
if (mode !== 'interactive') redirectConsoleToStderr()
if (mode === 'rpc' && args.messages.length)
  usageError(
    '--mode rpc reads commands from stdin and takes no prompt on the command line',
  )
if (mode !== 'interactive' && args.resume)
  usageError(
    '-r works only in interactive mode; in print / json / rpc mode use --session <id> or -c',
  )

// Print mode: piped stdin is prepended to the first prompt (like pi: `git diff | vela -p "review"`)
const messages = [...args.messages]
if ((mode === 'print' || mode === 'json') && !args.listModels) {
  const piped = process.stdin.isTTY ? '' : (await readStdin()).trim()
  if (piped) messages[0] = messages[0] ? `${piped}\n\n${messages[0]}` : piped
  if (!messages.length)
    usageError('No prompt: pass one on the command line or via stdin')
}
// Config: ~/.vela/settings.json + <cwd>/.vela/settings.json once trusted (step 4, see 04-plan.md)
const agentDir = defaultAgentDir(env)
let config: VelaConfig
try {
  const trust = await resolveTrust({
    cwd,
    agentDir,
    approve: args.approve,
    interactive: mode === 'interactive',
  })
  if (trust.warning) console.error(trust.warning)
  config = loadConfig({
    cwd,
    agentDir,
    env,
    trusted: trust.trusted,
    builtins: Object.keys(BUILTIN_EXTENSIONS),
  })
} catch (error) {
  console.error(`[config] ${error instanceof Error ? error.message : error}`)
  process.exit(2)
}
// Hint in -p mode too (if --continue can't find the old session, the user should know why); goes to stderr, stdout is for results
const legacyHint = legacyDataHint(cwd, config.dataDir)
if (legacyHint) console.error(legacyHint)

/**
 * Default model: VELA_MODEL=mock / faux:<scenario> wins (offline demo, replay), then `--model` → settings
 * defaultModel → `openai/$OPENAI_API_MODEL_NAME` (the legacy env var form).
 */
const NO_MODEL =
  'No model selected. Use --model provider/id, set defaultModel in ~/.vela/settings.json (providers are in ~/.vela/models.json; built-in openai / anthropic read OPENAI_API_KEY / ANTHROPIC_API_KEY), or set OPENAI_API_KEY + OPENAI_API_MODEL_NAME. For an offline demo use VELA_MODEL=mock.'

/** Error text for the user: the core's "No model selected" names SDK calls (createVela / setModel); the CLI says how to pick a model. */
function cliErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith('No model selected') ? NO_MODEL : message
}

/** The default model; undefined when nothing is configured (a session resumed with --continue may have a saved model; otherwise startup reports NO_MODEL) */
async function chooseModel(): Promise<LanguageModel | string | undefined> {
  // --model wins over VELA_MODEL (so VELA_RECORD wraps the model --model names)
  if (args.model) return args.model
  // VELA_MODEL=mock: offline demo with the built-in keyword demo model (simulates prompt cache behavior)
  if (env.VELA_MODEL === 'mock') return createMockModel()
  // VELA_MODEL=faux:<scenario.json>: replay model responses from a JSON scenario script (bug repros, CLI e2e)
  if (env.VELA_MODEL?.startsWith('faux:'))
    return loadFauxScenario(env.VELA_MODEL.slice('faux:'.length))
  return (
    config.settings.defaultModel ??
    (env.OPENAI_API_MODEL_NAME
      ? `openai/${env.OPENAI_API_MODEL_NAME}`
      : undefined)
  )
}
const chosenModel = await chooseModel()

// VELA_RECORD=<file.json>: record this run's model responses and user input as a faux scenario; replay with VELA_MODEL=faux:<file>
// (records the default model only; a model chosen by name is resolved here via models.json / built-in providers, so extension providers can't be recorded)
let recorder: ReturnType<typeof recordModel> | undefined
if (env.VELA_RECORD) {
  try {
    if (!chosenModel) throw new Error(NO_MODEL)
    const model =
      typeof chosenModel === 'string'
        ? new ModelRegistry(config.providers).resolve(chosenModel).model
        : chosenModel
    recorder = recordModel(model, { path: env.VELA_RECORD })
  } catch (error) {
    console.error(`[record] ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}

// Interactive mode logs to the TUI chat log and debug to ~/.vela/debug.log; other modes log to stderr
const interactiveLogger =
  mode === 'interactive'
    ? createInteractiveLogger({
        debugLog:
          env.VELA_DEBUG === '1' ? join(agentDir, 'debug.log') : undefined,
      })
    : undefined
const logger =
  interactiveLogger?.logger ??
  createConsoleLogger({ debug: env.VELA_DEBUG === '1', stderr: true })
const vela = createVela({
  model: recorder?.model ?? chosenModel,
  providers: config.providers,
  thinkingLevel: args.thinking ?? config.settings.defaultThinkingLevel,
  cwd,
  dataDir: config.dataDir,
  sessionStorage: args.noSession ? memorySessionStorage() : undefined,
  skillDirs: config.skillDirs,
  promptTemplateDirs: config.promptDirs,
  contextFiles: args.noContextFiles ? false : config.contextFiles,
  appendSystemPrompt: args.appendSystemPrompt.length
    ? args.appendSystemPrompt.map(readPromptInput).join('\n\n')
    : config.appendSystemPrompt,
  limits: config.settings.limits,
  shellPath: config.settings.shellPath,
  logger,
  // grep / find download ripgrep / fd here when they are not installed (same as pi); VELA_OFFLINE=1 turns that off
  binDir: join(agentDir, 'bin'),
  offline: ['1', 'true', 'yes'].includes(
    (env.VELA_OFFLINE ?? '').toLowerCase(),
  ),
  extensionConfig: extensionConfigFromEnv(env, config.extensionConfig),
  // Built-in extensions (memory / rag / web / feishu) + ~/.vela/extensions + .vela/extensions + settings + -e
  extensions: await loadCliExtensions(config, args, (message) =>
    console.error(message),
  ),
})

const exitWith = async (code: number, message: string): Promise<never> => {
  ;(code ? process.stderr : process.stdout).write(message)
  await vela.dispose()
  process.exit(code)
}

// --list-models (like pi): extension providers are listed too, so wait for extensions to load
if (args.listModels) {
  await vela
    .ready()
    .catch((error) =>
      console.error(error instanceof Error ? error.message : error),
    )
  await exitWith(
    0,
    formatModelList(
      vela.models(),
      args.listModels === true ? undefined : args.listModels,
    ),
  )
}

// --tools / --no-tools / --exclude-tools: checked once extensions have registered their tools
let toolSelection: string[] | undefined
try {
  if (args.tools || args.noTools || args.excludeTools.length) {
    await vela.ready().catch(() => {})
    toolSelection = selectTools(
      velaInternals(vela)
        .registry.getAllTools()
        .map((tool) => tool.name),
      args,
    )
  }
} catch (error) {
  await exitWith(
    2,
    `${error instanceof Error ? error.message : String(error)}\n`,
  )
}

/**
 * Which session to use (like pi): `--session <id>`; `-c` continues the most recent saved one (or starts a new one);
 * `-r` picks one in interactive mode; otherwise each launch starts a new session.
 */
const sessionId =
  args.session ??
  (args.continue ? (await vela.listSessions())[0]?.id : undefined) ??
  newSessionId()
const resume = args.session !== undefined || args.continue
// Record input of the main session only, not channel sessions (the id picked with -r is known only at configure time)
let recordedSession = sessionId
if (recorder)
  vela.subscribe((event, id) => {
    if (event.type === 'agent_start' && id === recordedSession)
      recorder.addInput(event.input)
  })

/**
 * Applies --tools / --no-tools / --exclude-tools to each session the CLI opens.
 * A resumed session carries its saved model and thinking level. Explicit command-line values win, and so do
 * VELA_MODEL=mock / faux and VELA_RECORD-wrapped models (otherwise --continue would bypass replay / recording
 * and use the saved real model). Returns whether the model is usable.
 */
function applyModelArgs(target: VelaSession): boolean {
  recordedSession = target.id
  if (toolSelection) target.setActiveTools(toolSelection)
  if (args.thinking) target.setThinkingLevel(args.thinking)
  // The recorder wraps the --model / default model, so it goes first or --model would bypass recording
  const override =
    recorder?.model ??
    args.model ??
    (typeof chosenModel === 'string' ? undefined : chosenModel)
  try {
    if (override) target.setModel(override)
    else void target.modelInfo
    return true
  } catch (error) {
    console.error(
      `[model] ${chosenModel === undefined && !args.model ? NO_MODEL : cliErrorMessage(error)}`,
    )
    return false
  }
}

/** `--append-system-prompt` takes text or a file path (like pi: an existing file is read). */
function readPromptInput(input: string): string {
  return existsSync(input) && statSync(input).isFile()
    ? readFileSync(input, 'utf-8')
    : input
}

const exit = async (code: number): Promise<never> => {
  await vela.dispose()
  await recorder?.flush()
  process.exit(code)
}

if (mode === 'print' || mode === 'json') {
  // Print mode has no UI: extension confirms always answer "no" (like pi's print mode)
  const session = vela.session(sessionId)
  if (resume) await session.resume()
  // Extension providers resolve only after extensions load (if loading fails, prompt reports it)
  await vela.ready().catch(() => {})
  if (!applyModelArgs(session)) await exit(1)
  await exit(
    await runPrintMode({
      vela,
      session,
      messages,
      mode: mode === 'json' ? 'json' : 'text',
    }),
  )
} else if (mode === 'rpc') {
  await vela
    .ready()
    .catch((error) =>
      console.error(error instanceof Error ? error.message : error),
    )
  await runRpcMode({
    vela,
    sessionId,
    resume,
    newSessionId,
    // Start even without a model; the client can set_model (the error goes to stderr)
    configure: (session) => void applyModelArgs(session),
    input: process.stdin,
    write: writeStdout,
    describeError: cliErrorMessage,
  })
  await exit(0)
} else {
  await runInteractive({
    vela,
    sessionId,
    resume,
    pick: args.resume,
    newSessionId,
    configure: applyModelArgs,
    describeError: cliErrorMessage,
    attachLogger: interactiveLogger?.attach,
    onExit: async () => {
      await vela.dispose()
      await recorder?.flush()
    },
  })
  process.exit(0)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
