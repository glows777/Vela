#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getDaemonStatus, startDaemon, stopDaemon } from '../daemon/index.ts'
import { registerExtensionHostModules } from '../driver/config/extensions.ts'
import { defaultAgentDir } from '../driver/config/paths.ts'
import { newSessionId, resolveModel } from '../driver/diagnostics.ts'
import type { ImageContent } from '../driver/index.ts'
import { formatContextFileList } from './context-display.ts'
import { errorMessage } from './error.ts'
import { readAttachments } from './files.ts'
import { redirectConsoleToStderr, writeStdout } from './json-event.ts'
import { createConsoleLogger, createInteractiveLogger } from './logger.ts'
import { installationId } from './login.ts'
import { runPrintMode } from './print-mode.ts'
import {
  buildCliSessionOverride,
  CliSessionClient,
  ensureCliProject,
  openCliRuntime,
  pickTransientEnv,
} from './runtime-client.ts'
import {
  type CliArgs,
  DAEMON_HELP,
  formatModelList,
  HELP,
  packageVersion,
  parseArgs,
  RetiredCommandError,
  resolveTrust,
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
  if (error instanceof RetiredCommandError) {
    console.error(error.message)
    process.exit(error.exitCode)
  }
  usageError(error instanceof Error ? error.message : String(error))
  throw error
}

if (args.help || args.version) {
  process.stdout.write(args.help ? HELP : `${packageVersion()}\n`)
  process.exit(0)
}
if (args.daemonHelp) {
  process.stdout.write(DAEMON_HELP)
  process.exit(0)
}

const env = process.env
const cwd = process.cwd()
const agentDir = resolve(args.agentDir ?? defaultAgentDir(env))
registerExtensionHostModules({
  '@glows777/vela/extension-api': () => import('../extension-api.ts'),
  '@glows777/vela': () =>
    Promise.all([
      import('../daemon/index.ts'),
      import('../driver/index.ts'),
      import('../driver/diagnostics.ts'),
      import('../extension-api.ts'),
      import('../lark/index.ts'),
      import('../legacy-channels/index.ts'),
      import('../load-config.ts'),
      import('../mcp/index.ts'),
      import('../runtime/index.ts'),
      import('../runtime-sdk.ts'),
      import('../settings.ts'),
      import('../vela.ts'),
    ]).then((mods) => Object.assign({}, ...mods)),
  zod: () => import('zod'),
})

if (args.daemon) {
  const logger = createConsoleLogger({
    debug: env.VELA_DEBUG === '1',
    stderr: true,
  })
  if (args.daemon === 'run') {
    const { DaemonAlreadyRunningError, startDaemonServer } = await import(
      '../daemon/server.ts'
    )
    let resolveClosed!: () => void
    const closed = new Promise<void>((resolvePromise) => {
      resolveClosed = resolvePromise
    })
    try {
      await startDaemonServer({
        agentDir,
        hostEnv: env,
        logger,
        onClosed: () => resolveClosed(),
      })
      await closed
      process.exit(0)
    } catch (error) {
      if (error instanceof DaemonAlreadyRunningError) {
        console.error(error.message)
        process.exit(1)
      }
      console.error(`[daemon] ${errorMessage(error)}`)
      process.exit(1)
    }
  }
  if (args.daemon === 'start') {
    const hello = await startDaemon({ agentDir, hostEnv: env })
    await writeStdout(
      `Vela daemon running (pid ${hello.pid}, socket ${hello.socketPath})\n`,
    )
    process.exit(0)
  }
  if (args.daemon === 'stop') {
    const stopped = await stopDaemon({ agentDir, hostEnv: env })
    await writeStdout(
      stopped ? 'Vela daemon stopped\n' : 'Vela daemon is not running\n',
    )
    process.exit(0)
  }
  const status = await getDaemonStatus({ agentDir, hostEnv: env })
  if (status.running) {
    await writeStdout(
      `Vela daemon running (pid ${status.pid}, version ${status.appVersion}, socket ${status.socketPath})\n`,
    )
  } else {
    await writeStdout(`Vela daemon stopped (socket ${status.socketPath})\n`)
  }
  process.exit(0)
}

if (args.setupTarget === 'github') {
  const { githubSetup } = await import('./github-setup.ts')
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const input = interactive
    ? (await import('./tui/setup-input.ts')).setupInput
    : undefined
  process.exit(
    await githubSetup({
      agentDir,
      repositories: args.setupRepositories ?? [],
      url: args.setupUrl,
      interactive,
      input,
    }),
  )
}

const mode: 'interactive' | 'print' | 'json' =
  args.mode === 'json'
    ? 'json'
    : args.print ||
        args.mode === 'text' ||
        !process.stdin.isTTY ||
        !process.stdout.isTTY
      ? 'print'
      : 'interactive'

if (args.setup && mode !== 'interactive')
  usageError('vela setup requires an interactive terminal')
if (mode !== 'interactive') redirectConsoleToStderr()
if (args.export && (args.messages.length > 1 || args.mode || args.print))
  usageError('--export takes a session and an optional output path only')
if (mode !== 'interactive' && args.resume)
  usageError(
    '-r works only in interactive mode; in print / json mode use --session <id> or -c',
  )

const messages = args.export
  ? [...args.messages]
  : args.messages.filter((arg) => !arg.startsWith('@'))
let attachments: { text: string; images: ImageContent[] } = {
  text: '',
  images: [],
}
if (!args.listModels && !args.export) {
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

function cliErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (
    message.startsWith('No model selected') ||
    message.startsWith('No model configured')
  ) {
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

const interactiveLogger =
  mode === 'interactive' && !args.listModels
    ? createInteractiveLogger({
        debugLog:
          env.VELA_DEBUG === '1' ? join(agentDir, 'debug.log') : undefined,
      })
    : undefined
const logger =
  interactiveLogger?.logger ??
  createConsoleLogger({ debug: env.VELA_DEBUG === '1', stderr: true })

let runtime: Awaited<ReturnType<typeof openCliRuntime>> | undefined
let activeSessionId: string | undefined
let clearTransientApproval: (() => Promise<void>) | undefined
let signalCode: number | undefined
const exit = async (code: number): Promise<never> => {
  await clearTransientApproval?.().catch(() => {})
  await runtime?.dispose().catch(() => {})
  process.exit(signalCode ?? code)
}

try {
  runtime = await openCliRuntime({
    agentDir,
    hostEnv: env,
    noSession: args.noSession,
    logger,
  })

  if (mode !== 'interactive') {
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
        if (activeSessionId && runtime) {
          void runtime
            .stop(activeSessionId, signal)
            .catch(() => {})
            .finally(() => exit(code))
        } else {
          void exit(code)
        }
      })
  }
  const transientEnv = pickTransientEnv(env)
  if (args.listModels) {
    await runtime.ready().catch(() => {})
    let extensionErrors = await runtime.extensionErrors()
    if (args.extensions.length > 0 || args.noExtensions) {
      const probeId = `list-models-${newSessionId()}`
      await runtime.sessions.create({
        id: probeId,
        location: { environment: 'local', cwd },
      })
      try {
        await runtime.sessions.configure(probeId, {
          cwd,
          ...(Object.keys(transientEnv).length > 0
            ? { env: transientEnv }
            : {}),
          extensions: args.extensions,
          noExtensions: args.noExtensions,
        })
        const snap = await runtime.sessions.inspect(probeId, {
          includeEntries: false,
        })
        extensionErrors = snap.extensionErrors
      } finally {
        await runtime.sessions.delete(probeId).catch(() => {})
      }
    }
    const models = await runtime.models({
      ...(Object.keys(transientEnv).length > 0 ? { env: transientEnv } : {}),
    })
    const list = formatModelList(
      models,
      args.listModels === true ? undefined : args.listModels,
    )
    if (!extensionErrors.length) {
      await writeStdout(list)
      await exit(0)
    }
    for (const err of extensionErrors) {
      console.error(err)
    }
    await writeStdout(list)
    console.error(
      `${extensionErrors.length} extension(s) failed to load; the list above may be incomplete`,
    )
    await exit(1)
  }

  if (args.export) {
    if (args.noSession) {
      console.error('[export] --export cannot be used with --no-session')
      await exit(1)
    }
    try {
      const output = args.messages[0]
      const written = await runtime.sessions.export(
        args.export,
        output?.endsWith('.jsonl') ? 'jsonl' : 'html',
        output,
        cwd,
      )
      console.error(`Exported to ${written}`)
      await exit(0)
    } catch (error) {
      console.error(
        `[export] ${error instanceof Error ? error.message : error}`,
      )
      await exit(1)
    }
  }

  const trust = await resolveTrust({
    cwd,
    agentDir,
    approve: args.approve,
    interactive: mode === 'interactive',
    trust: runtime.trust,
  })
  if (trust.warning) console.error(trust.warning)

  const offline = ['1', 'true', 'yes'].includes(
    (env.VELA_OFFLINE ?? '').toLowerCase(),
  )
  const approvedSessionIds = new Set<string>()
  let cliOverride = buildCliSessionOverride(args, env, cwd, args.approve)
  clearTransientApproval = async () => {
    if (!runtime || args.noSession || args.approve === undefined) {
      return
    }
    const {
      approve: _approve,
      approveLocation: _loc,
      ...withoutApproval
    } = cliOverride
    const targets = new Set(approvedSessionIds)
    if (activeSessionId) targets.add(activeSessionId)
    for (const sid of targets) {
      await runtime.sessions.configure(sid, withoutApproval).catch(() => {})
    }
  }

  let forkedId: string | undefined
  if (args.fork) {
    try {
      const source = await runtime.sessions.get(args.fork)
      if (!source) throw new Error(`Session ${args.fork} has no saved history`)
      const cloned = await runtime.sessions.clone(args.fork, {
        sessionId: newSessionId(),
      })
      forkedId = cloned.sessionId
    } catch (error) {
      console.error(`[fork] ${error instanceof Error ? error.message : error}`)
      await exit(1)
    }
  }

  let sessionId = forkedId ?? args.session
  let resume = args.session !== undefined
  if (!sessionId && args.continue) {
    const summaries = await runtime.sessions.listSummaries({
      cwd,
      excludeChannels: true,
    })
    if (summaries[0]) {
      sessionId = summaries[0].id
      resume = true
    }
  }
  if (!sessionId) {
    sessionId = newSessionId()
  }
  activeSessionId = sessionId

  if (mode === 'print' || mode === 'json') {
    const projectId = args.noSession
      ? undefined
      : await ensureCliProject(runtime, cwd)
    const existing = await runtime.sessions.get(sessionId)
    if (!existing) {
      await runtime.sessions.create({
        id: sessionId,
        ...(projectId ? { projectId } : {}),
        location: { environment: 'local', cwd },
      })
    }
    const client = new CliSessionClient(runtime, sessionId)
    try {
      await runtime.ready().catch(() => {})
      await client.configure(cliOverride)
      const snap = await client.refresh({ includeEntries: false })
      const line = formatContextFileList(snap.resources.contextFiles, {
        cwd: snap.cwd,
        homeDir: homedir(),
        agentDir,
      })
      if (line) logger.info(`[context] ${line}`)
      if (snap.extensionErrors.length > 0) {
        for (const err of snap.extensionErrors) {
          console.error(err)
        }
      }
      if (!snap.modelInfo) {
        const prefix = env.VELA_RECORD ? '[record]' : '[model]'
        console.error(
          `${prefix} ${cliErrorMessage(snap.modelError ?? 'No model selected')}`,
        )
        await exit(1)
      }
      const code = await runPrintMode({
        runtime,
        session: client,
        messages,
        images: attachments.images,
        mode: mode === 'json' ? 'json' : 'text',
      })
      await exit(code)
    } finally {
      client.dispose()
    }
  } else {
    const { runInteractive } = await import('./interactive.ts')
    const projectConfigPath = join(cwd, '.vela', 'config.json')
    await runInteractive({
      runtime,
      cwd,
      messages,
      images: attachments.images,
      sessionId,
      resume,
      pick: args.resume,
      newSessionId,
      configure: async (target, opts) => {
        try {
          if (args.approve !== undefined) {
            approvedSessionIds.add(target.id)
          }
          await target.configure(cliOverride)
          const snap = await target.refresh()
          if (!snap.modelInfo && !opts?.quiet) {
            console.error(
              `[model] ${cliErrorMessage(snap.modelError ?? 'No model selected')}`,
            )
          }
          return Boolean(snap.modelInfo)
        } catch (error) {
          if (!opts?.quiet) {
            console.error(`[model] ${cliErrorMessage(error)}`)
          }
          return false
        }
      },
      describeError: cliErrorMessage,
      loginOptions: { getDeviceId: () => installationId(agentDir) },
      agentDir,
      offline,
      attachLogger: interactiveLogger?.attach,
      setupOnly: args.setup,
      setupTarget: args.setupTarget,
      noSession: args.noSession,
      ...(Object.keys(transientEnv).length > 0
        ? { modelEnv: transientEnv }
        : {}),
      projectSettingsPath:
        existsSync(projectConfigPath) &&
        resolve(projectConfigPath) !== resolve(join(agentDir, 'config.json'))
          ? projectConfigPath
          : undefined,
      onConfigured: () => {
        args.model = undefined
        args.thinking = undefined
        cliOverride = buildCliSessionOverride(args, env, cwd, args.approve)
      },
      onExit: async () => {
        await clearTransientApproval?.().catch(() => {})
        await runtime?.dispose()
      },
    })
    process.exit(0)
  }
} catch (error) {
  const errMsgs: string[] = []
  for (
    let cause: unknown = error;
    cause !== undefined;
    cause = cause instanceof Error ? cause.cause : undefined
  )
    errMsgs.push(errorMessage(cause))
  const rawMsg = errMsgs.join(': ')
  const msg = cliErrorMessage(rawMsg)
  const isConfigError =
    rawMsg.includes('[config]') ||
    rawMsg.includes('is not valid JSON') ||
    /not a valid SQLite database|file is not a database|database disk image is malformed|SQLITE_NOTADB/i.test(
      rawMsg,
    )
  const isToolSelectionError =
    rawMsg.includes('Invalid --tools list') ||
    rawMsg.includes('Unknown tool:') ||
    rawMsg.includes('Unknown tools:') ||
    rawMsg.includes('tool names cannot be mixed') ||
    rawMsg.includes('exact tool names, not patterns') ||
    rawMsg.includes('was renamed to')
  const prefixed =
    isConfigError && !msg.includes('[config]')
      ? `[config] ${msg}`
      : env.VELA_RECORD && msg.startsWith('No model available.')
        ? `[record] ${msg}`
        : msg
  console.error(prefixed)
  await exit(isConfigError || isToolSelectionError ? 2 : 1)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
