#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { registerExtensionHostModules } from '../driver/config/extensions.ts'
import { newSessionId, resolveModel } from '../driver/diagnostics.ts'
import type { ImageContent, VelaSession } from '../driver/index.ts'
import { setDefaultToolModifiers } from '../driver/index.ts'
import { exportSavedSession } from '../driver/session/export.ts'
import { type LocalOptions, local } from '../legacy-channels/index.ts'
import { defaultAgentDir, loadConfig, type VelaConfig } from '../load-config.ts'
import { McpPool } from '../mcp/index.ts'
import { usableModel } from '../settings.ts'
import type { ModelInput } from '../shared/provider-types.ts'
import { createVela } from '../vela.ts'
import { formatContextFileList } from './context-display.ts'
import { ownerDocker } from './docker.ts'
import { errorMessage } from './error.ts'
import { readAttachments } from './files.ts'
import { redirectConsoleToStderr, writeStdout } from './json-event.ts'
import { localServeOptions } from './local-config.ts'
import { createConsoleLogger, createInteractiveLogger } from './logger.ts'
import { installationId } from './login.ts'
import { runPrintMode } from './print-mode.ts'
import {
  cliHostExtensionConfig,
  cliProjectExtensions,
} from './project-extensions.ts'
import { runRpcMode } from './rpc-mode.ts'
import {
  BUILTIN_EXTENSIONS,
  type CliArgs,
  cliWorkspaceModeAt,
  formatModelList,
  HELP,
  loadCliExtensions,
  packageVersion,
  parseArgs,
  resolveTrust,
  selectTools,
  USAGE,
} from './setup.ts'
import { resolveShellPath } from './shell.ts'

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
if (args.setupTarget === 'github') {
  const setupAgentDir = defaultAgentDir(process.env)
  const { githubSetup } = await import('./github-setup.ts')
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const input = interactive
    ? (await import('./tui/setup-input.ts')).setupInput
    : undefined
  process.exit(
    await githubSetup({
      agentDir: setupAgentDir,
      repositories: args.setupRepositories ?? [],
      url: args.setupUrl,
      interactive,
      input,
    }),
  )
}
const env = process.env
const cwd = process.cwd()
registerExtensionHostModules({
  '@glows777/vela/extension-api': () => import('../extension-api.ts'),
  '@glows777/vela': () =>
    Promise.all([
      import('../driver/index.ts'),
      import('../driver/diagnostics.ts'),
      import('../extension-api.ts'),
      import('../lark/index.ts'),
      import('../legacy-channels/index.ts'),
      import('../load-config.ts'),
      import('../mcp/index.ts'),
      import('../settings.ts'),
      import('../vela.ts'),
    ]).then((mods) => Object.assign({}, ...mods)),
})

/**
 * Run mode (like pi): `serve` runs channels only; `--mode rpc` / `--mode json` pick explicitly; `-p`, `--mode text`
 * or redirected stdin / stdout mean print mode; otherwise (in a terminal) interactive mode.
 */
const mode: 'serve' | 'interactive' | 'print' | 'json' | 'rpc' = args.serve
  ? 'serve'
  : args.mode === 'rpc'
    ? 'rpc'
    : args.mode === 'json'
      ? 'json'
      : args.print ||
          args.mode === 'text' ||
          !process.stdin.isTTY ||
          !process.stdout.isTTY
        ? 'print'
        : 'interactive'
if (args.setup && mode !== 'interactive')
  usageError('vela setup requires an interactive terminal')
// Non-interactive modes keep stdout for results / protocol: console output from extensions and the SDK goes to stderr
if (mode !== 'interactive') redirectConsoleToStderr()
if (mode === 'rpc' && args.messages.length)
  usageError(
    '--mode rpc reads commands from stdin and takes no prompt on the command line',
  )
if (args.export && (args.messages.length > 1 || args.mode || args.print))
  usageError('--export takes a session and an optional output path only')
if (mode !== 'interactive' && args.resume)
  usageError(
    '-r works only in interactive mode; in print / json / rpc mode use --session <id> or -c',
  )

// Print mode: piped stdin is prepended to the first prompt (like pi: `git diff | vela -p "review"`)
const messages = args.export
  ? [...args.messages]
  : args.messages.filter((arg) => !arg.startsWith('@'))
let attachments: { text: string; images: ImageContent[] } = {
  text: '',
  images: [],
}
if (mode !== 'rpc' && mode !== 'serve' && !args.listModels && !args.export) {
  try {
    attachments = await readAttachments(
      args.messages
        .filter((arg) => arg.startsWith('@'))
        .map((arg) => arg.slice(1)),
    )
  } catch (error) {
    console.error(errorMessage(error))
    process.exit(1)
  }
}
if (
  messages[0]?.trimStart().startsWith('/') &&
  (attachments.text || attachments.images.length)
) {
  console.error('[attachments] Attachments are ignored by slash commands')
  attachments = { text: '', images: [] }
}
if ((mode === 'print' || mode === 'json') && !args.listModels && !args.export) {
  const piped = process.stdin.isTTY ? '' : (await readStdin()).trim()
  if (piped) messages[0] = messages[0] ? `${piped}\n\n${messages[0]}` : piped
  if (!messages.length && !attachments.text && !attachments.images.length)
    usageError('No prompt: pass one on the command line or via stdin')
}
if (attachments.text || attachments.images.length)
  messages[0] = [attachments.text, messages[0]].filter(Boolean).join('\n\n')
// Config: ~/.vela/config.json + <cwd>/.vela/config.json once trusted (step 4, see 04-plan.md)
const agentDir = defaultAgentDir(env)
let config: VelaConfig
let localOptions: LocalOptions | undefined
try {
  const trust = await resolveTrust({
    cwd,
    agentDir,
    approve: args.approve,
    interactive: mode === 'interactive',
  })
  if (trust.warning) console.error(trust.warning)
  config = loadConfig({
    deferSystemFiles: true,
    cwd,
    agentDir,
    env,
    trusted: trust.trusted,
    builtins: Object.keys(BUILTIN_EXTENSIONS),
  })
  localOptions = localServeOptions(
    config.userExtensionConfig,
    mode === 'serve' && !args.listModels && !args.noExtensions,
  )
} catch (error) {
  console.error(`[config] ${error instanceof Error ? error.message : error}`)
  process.exit(2)
}
// Hint in -p mode too (if --continue can't find the old session, the user should know why); goes to stderr, stdout is for results
const previousDataDir = config.sessionResources?.previousDataDir
if (previousDataDir)
  console.error(
    config.sessionResources?.userSettings?.dataDir
      ? `[data] Using owner dataDir ${config.dataDir}. The project dataDir ${previousDataDir} is ignored.`
      : `[data] Owner environments select ${config.dataDir}. The previous settings select ${previousDataDir}. To keep using that history, pin dataDir to ${JSON.stringify(previousDataDir)} in the owner settings and restart.`,
  )

// --export <id> [output]: read directly from vela.db (readonly) without initializing models, extensions, or recorder
if (args.export) {
  if (args.noSession) {
    console.error('[export] --export cannot be used with --no-session')
    process.exit(1)
  }
  try {
    const written = await exportSavedSession({
      dataDir: config.dataDir,
      agentDir: config.agentDir,
      sessionId: args.export,
      outputPath: args.messages[0],
      baseCwd: cwd,
    })
    console.error(`Exported to ${written}`)
    process.exit(0)
  } catch (error) {
    console.error(`[export] ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}

/**
 * Default model: VELA_MODEL=mock / faux:<scenario> wins (offline demo, replay), then `--model` → config
 * model → `openai/$OPENAI_API_MODEL_NAME` (the legacy env var form).
 */
/** Error text for the user: the core's "No model selected" names SDK calls (createVela / setModel); the CLI says how to pick a model. */
function cliErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('No model selected')) {
    try {
      resolveModel(undefined, { providers: {} })
    } catch (resolutionError) {
      return resolutionError instanceof Error
        ? resolutionError.message.replace(
            'No model available.',
            'No model available. Run vela setup;',
          )
        : String(resolutionError)
    }
  }
  if (message.startsWith('No model available.'))
    return message.replace(
      'No model available.',
      'No model available. Run vela setup;',
    )
  return message
}

/** The default model; undefined when nothing is configured (a session resumed with --continue may have a saved model; otherwise startup reports model-selection guidance) */
async function chooseModel(): Promise<ModelInput | undefined> {
  // --model wins over VELA_MODEL (so VELA_RECORD wraps the model --model names)
  if (args.model) return args.model
  // VELA_MODEL=mock: offline demo with the built-in keyword demo model (simulates prompt cache behavior)
  if (env.VELA_MODEL === 'mock') {
    const { createMockModel } = await import('../testing/core/index.ts')
    return createMockModel()
  }
  // VELA_MODEL=faux:<scenario.json>: replay model responses from a JSON scenario script (bug repros, CLI e2e)
  if (env.VELA_MODEL?.startsWith('faux:')) {
    const { loadFauxScenario } = await import('../testing/core/index.ts')
    return loadFauxScenario(env.VELA_MODEL.slice('faux:'.length))
  }
  return (
    config.settings.model ??
    (env.OPENAI_API_MODEL_NAME
      ? `openai/${env.OPENAI_API_MODEL_NAME}`
      : undefined)
  )
}
// --list-models needs neither a runnable model nor a recorder
let chosenModel = args.listModels ? undefined : await chooseModel()

// VELA_RECORD=<file.json>: record this run's model responses and user input as a faux scenario; replay with VELA_MODEL=faux:<file>
// (records the default model only; a model chosen by name is resolved here via config.json / built-in providers, so extension providers can't be recorded)
let recorder:
  | Awaited<ReturnType<typeof import('../testing/core/index.ts').recordModel>>
  | undefined
if (env.VELA_RECORD && !args.listModels && !args.setup) {
  try {
    const { recordModel } = await import('../testing/core/index.ts')
    recorder = recordModel(
      resolveModel(chosenModel, {
        providers: config.providers,
        credentials: config.credentials,
      }),
      { path: env.VELA_RECORD },
    )
  } catch (error) {
    console.error(`[record] ${cliErrorMessage(error)}`)
    process.exit(1)
  }
}

// Interactive mode logs to the TUI chat log and debug to ~/.vela/debug.log; other modes log to stderr
const interactiveLogger =
  mode === 'interactive' && !args.listModels
    ? createInteractiveLogger({
        debugLog:
          env.VELA_DEBUG === '1'
            ? join(config.agentDir, 'debug.log')
            : undefined,
      })
    : undefined
const logger =
  interactiveLogger?.logger ??
  createConsoleLogger({ debug: env.VELA_DEBUG === '1', stderr: true })
// Extensions that failed to load (already reported on stderr); --list-models exits 1 when there are any
const extensionErrors: string[] = []
const docker = ownerDocker(config)
const mcpPool = new McpPool()
const vela = createVela({
  ...docker,
  beforeDispose: async () => {
    try {
      await docker?.beforeDispose()
    } finally {
      await mcpPool.dispose()
    }
  },
  model:
    recorder?.model ??
    (args.model ||
    env.VELA_MODEL === 'mock' ||
    env.VELA_MODEL?.startsWith('faux:')
      ? chosenModel
      : undefined),
  providers: config.providers,
  credentials: config.credentials,
  thinkingLevel: args.thinking,
  cwd,
  agentDir: config.agentDir,
  dataDir: config.dataDir,
  ephemeralSessions: args.noSession,
  sessionResources: config.sessionResources && {
    ...config.sessionResources,
    useBuiltinLocal: !!docker,
    projectExtensions: cliProjectExtensions(
      config,
      args,
      (message) => logger.warn(message),
      mcpPool,
    ),
    fallbackModel: env.OPENAI_API_MODEL_NAME
      ? `openai/${env.OPENAI_API_MODEL_NAME}`
      : undefined,
    fallbackShellPath: resolveShellPath(undefined, { env }),
    workspaceModeAt: (location, environment = 'local') =>
      cliWorkspaceModeAt({
        agentDir: config.agentDir,
        dataDir: config.dataDir,
        startupCwd: cwd,
        approve: args.approve,
        location,
        environment,
      }),
  },
  contextFiles: args.noContextFiles ? false : undefined,
  systemPrompt: args.systemPrompt.length
    ? args.systemPrompt.map(readPromptInput).join('\n\n')
    : undefined,
  appendSystemPrompt: args.appendSystemPrompt.length
    ? args.appendSystemPrompt.map(readPromptInput).join('\n\n')
    : undefined,
  eventDefaultTarget: config.settings.eventDefaultTarget,
  logger,
  // grep / find download ripgrep / fd here when they are not installed (same as pi); VELA_OFFLINE=1 turns that off
  binDir: join(config.agentDir, 'bin'),
  offline: ['1', 'true', 'yes'].includes(
    (env.VELA_OFFLINE ?? '').toLowerCase(),
  ),
  extensionConfig: cliHostExtensionConfig(config, args),
  // Built-in extensions (memory / rag / web / lark) + ~/.vela/extensions + .vela/extensions + settings + -e
  extensions: [
    ...(await loadCliExtensions(
      config,
      args,
      (message) => {
        extensionErrors.push(message)
        console.error(message)
      },
      true,
      mcpPool,
    )),
    ...(localOptions ? [local(localOptions)] : []),
  ],
})

const exitWith = async (code: number, message: string): Promise<never> => {
  ;(code ? process.stderr : process.stdout).write(message)
  await vela.dispose()
  process.exit(code)
}

// --list-models (like pi): extension providers are listed too, so wait for extensions to load.
// pi exits 0 even when an extension failed to load; Vela still lists the models that did load,
// but exits 1 so scripts notice (the errors are already on stderr)
if (args.listModels) {
  await vela.ready().catch(() => {})
  const list = formatModelList(
    vela.models(),
    args.listModels === true ? undefined : args.listModels,
  )
  if (!extensionErrors.length) await exitWith(0, list)
  process.stdout.write(list)
  await exitWith(
    1,
    `${extensionErrors.length} extension(s) failed to load; the list above may be incomplete\n`,
  )
}

// Tool selection is validated against each prepared session, not the host registry.
let configurationExitCode: number | undefined

/** Set once a signal stops the CLI: its code wins over the one of the run it interrupted */
let signalCode: number | undefined
const exit = async (code: number): Promise<never> => {
  await vela.dispose()
  await recorder?.flush()
  process.exit(signalCode ?? configurationExitCode ?? code)
}

// --fork <id>: copy a saved session into a new one and start there (like pi)
let forkedId: string | undefined
if (args.fork) {
  const source = vela.session(args.fork)
  try {
    if (!(await source.resume()))
      throw new Error(`Session ${args.fork} has no saved history`)
    forkedId = (await source.clone()).session?.id
  } catch (error) {
    console.error(`[fork] ${error instanceof Error ? error.message : error}`)
    await exit(1)
  }
  await source.close()
}

/**
 * Which session to use (like pi): `--session <id>`; `-c` continues the most recent saved one (or starts a new one);
 * `-r` picks one in interactive mode; otherwise each launch starts a new session.
 */
const sessionId =
  forkedId ??
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

/** Print and interactive CLI tool settings, never a serve channel's tool policy. */
function applyCliTools(target: VelaSession, defaultTools?: readonly string[]) {
  if (
    mode === 'serve' ||
    (!args.tools && !args.noTools && !args.excludeTools.length && !defaultTools)
  )
    return
  const toolLoadout = selectTools(
    target.registry.getAllTools().map((tool) => tool.name),
    args,
    defaultTools,
  )
  if (toolLoadout?.selection) target.setActiveTools(toolLoadout.selection)
  else if (toolLoadout?.modifiers)
    setDefaultToolModifiers(target, toolLoadout.modifiers)
}

/**
 * A resumed session carries its saved model and thinking level. Explicit command-line values win, and so do
 * VELA_MODEL=mock / faux and VELA_RECORD-wrapped models (otherwise --continue would bypass replay / recording
 * and use the saved real model). Returns whether the model is usable; `quiet` skips the diagnostic the
 * setup wizard is about to replace.
 */
function applyModelArgs(
  target: VelaSession,
  {
    quiet = false,
    startup = true,
    defaultTools,
  }: {
    quiet?: boolean
    startup?: boolean
    defaultTools?: readonly string[]
  } = {},
): boolean {
  try {
    applyCliTools(target, defaultTools)
  } catch (error) {
    if (!startup) throw error
    console.error(error instanceof Error ? error.message : String(error))
    configurationExitCode = 2
    void exit(2)
    return false
  }
  recordedSession = target.id
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
    if (!quiet)
      console.error(
        `[model] ${cliErrorMessage(chosenModel === undefined && !args.model ? new Error('No model selected') : error)}`,
      )
    return false
  }
}

async function reportContextFiles(session: VelaSession) {
  const resources = await session.resources()
  const line = formatContextFileList(resources.contextFiles, {
    cwd: session.cwd,
    homeDir: homedir(),
    agentDir: config.agentDir,
  })
  if (line) logger.info(`[context] ${line}`)
  return resources
}

/** `--system-prompt` and `--append-system-prompt` take text or a file path (like pi: an existing file is read). */
function readPromptInput(input: string): string {
  return existsSync(input) && statSync(input).isFile()
    ? readFileSync(input, 'utf-8')
    : input
}

// Print, JSON and RPC modes (interactive mode and `serve` handle their own): on a signal, abort the running
// turn so the commands the model started are killed (bash runs them in their own process group, which would
// outlive Vela), save the sessions and exit with the signal's code. A second signal exits right away.
if (mode !== 'interactive' && mode !== 'serve') {
  const signals: [NodeJS.Signals, number][] = [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ...(process.platform === 'win32'
      ? []
      : ([['SIGHUP', 129]] as [NodeJS.Signals, number][])),
  ]
  for (const [signal, code] of signals)
    process.on(signal, () => {
      if (signalCode !== undefined) process.exit(code)
      signalCode = code
      void exit(code)
    })
}

try {
  if (mode === 'print' || mode === 'json') {
    // Print mode has no UI: extension confirms always answer "no" (like pi's print mode)
    const session = vela.session(sessionId, { unattended: true })
    if (resume) await session.resume()
    const { defaultTools } = await reportContextFiles(session)
    // Extension providers resolve only after extensions load (if loading fails, prompt reports it)
    await vela.ready().catch(() => {})
    if (!applyModelArgs(session, { defaultTools })) await exit(1)
    await exit(
      await runPrintMode({
        vela,
        session,
        messages,
        images: attachments.images,
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
      configure: (session, { startup, defaultTools }) => {
        if (startup) applyModelArgs(session, { defaultTools })
        else applyCliTools(session, defaultTools)
      },
      onReady: async (session) => {
        await reportContextFiles(session)
      },
      input: process.stdin,
      write: writeStdout,
      describeError: cliErrorMessage,
    })
    await exit(0)
  } else if (mode === 'serve') {
    const { runServe } = await import('./serve.ts')
    await exit(
      await runServe({
        vela,
        write: (line) => process.stderr.write(`${line}\n`),
      }),
    )
  } else {
    const { runInteractive } = await import('./interactive.ts')
    await runInteractive({
      vela,
      messages,
      images: attachments.images,
      sessionId,
      resume,
      pick: args.resume,
      newSessionId,
      configure: applyModelArgs,
      describeError: cliErrorMessage,
      loginOptions: { getDeviceId: () => installationId(config.agentDir) },
      agentDir: config.agentDir,
      attachLogger: interactiveLogger?.attach,
      setupOnly: args.setup,
      setupTarget: args.setupTarget,
      projectSettingsPath: config.files.find(
        (file) =>
          file === join(config.cwd, '.vela', 'config.json') &&
          file !== join(config.agentDir, 'config.json'),
      ),
      onConfigured: () => {
        args.model = undefined
        args.thinking = undefined
        chosenModel = undefined
      },
      hasUsableModel: (session) =>
        usableModel({
          providers: config.providers,
          credentials: config.credentials,
          model: session.modelInfo.ref,
        }).usable,
      onExit: async () => {
        await vela.dispose()
        await recorder?.flush()
      },
    })
    process.exit(0)
  }
} catch (error) {
  const messages: string[] = []
  for (
    let cause: unknown = error;
    cause !== undefined;
    cause = cause instanceof Error ? cause.cause : undefined
  )
    messages.push(errorMessage(cause))
  console.error(messages.join(': '))
  await exit(1)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
