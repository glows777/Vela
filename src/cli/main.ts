#!/usr/bin/env node
import type { LanguageModel } from 'ai'
import {
  defaultAgentDir,
  loadConfig,
  type VelaConfig,
} from '../config/index.ts'
import { memorySessionStorage } from '../session/storage.ts'
import { createMockModel } from '../testing/demo-model.ts'
import { loadFauxScenario } from '../testing/faux.ts'
import { recordModel } from '../testing/record.ts'
import { ModelRegistry } from '../models/index.ts'
import { createVela } from '../vela.ts'
import type { VelaSession } from '../vela-session.ts'
import { runInteractive } from './interactive.ts'
import { redirectConsoleToStderr, writeStdout } from './json-event.ts'
import { join } from 'node:path'
import { createConsoleLogger, createInteractiveLogger } from './logger.ts'
import { runPrintMode } from './print-mode.ts'
import { runRpcMode } from './rpc-mode.ts'
import { newSessionId } from './sessions.ts'
import {
  BUILTIN_EXTENSIONS,
  type CliArgs,
  extensionConfigFromEnv,
  legacyDataHint,
  loadCliExtensions,
  parseArgs,
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
  usageError(error instanceof Error ? error.message : String(error))
  throw error
}
const env = process.env
const cwd = process.cwd()

/**
 * 运行方式（同 pi）：`--mode rpc` / `--mode json` 显式选；`-p`、`--mode text` 或 stdin / stdout 被重定向时是单次模式；
 * 否则（终端里）是交互模式。
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
// 非交互模式 stdout 只放结果 / 协议：扩展、SDK 的 console 输出都改到 stderr
if (mode !== 'interactive') redirectConsoleToStderr()
if (mode === 'rpc' && args.messages.length)
  usageError('--mode rpc 从 stdin 读命令，不接受命令行里的 prompt')
if (mode !== 'interactive' && args.resume)
  usageError('-r 只能在交互模式用；单次 / json / rpc 模式用 --session <id> 或 -c')

// 单次模式：管道进来的 stdin 拼在第一个 prompt 前面（同 pi：`git diff | vela -p "review"`）
const messages = [...args.messages]
if (mode === 'print' || mode === 'json') {
  const piped = process.stdin.isTTY ? '' : (await readStdin()).trim()
  if (piped) messages[0] = messages[0] ? `${piped}\n\n${messages[0]}` : piped
  if (!messages.length) usageError('没有 prompt：在命令行给出，或从 stdin 输入')
}
// 配置：~/.vela/settings.json + 信任后的 <cwd>/.vela/settings.json（第 4 步，见 04-plan.md）
const agentDir = defaultAgentDir(env)
const trust = await resolveTrust({
  cwd,
  agentDir,
  approve: args.approve,
  interactive: mode === 'interactive',
})
if (trust.warning) console.error(trust.warning)
let config: VelaConfig
try {
  config = loadConfig({
    cwd,
    agentDir,
    env,
    trusted: trust.trusted,
    builtins: Object.keys(BUILTIN_EXTENSIONS),
  })
} catch (error) {
  console.error(`[配置] ${error instanceof Error ? error.message : error}`)
  process.exit(2)
}
// -p 模式也提示（--continue 找不到旧会话时用户要知道为什么）；走 stderr，stdout 留给结果
const legacyHint = legacyDataHint(cwd, config.dataDir)
if (legacyHint) console.error(legacyHint)

/**
 * 默认模型：VELA_MODEL=mock / faux:<场景> 优先（离线体验、回放），否则 `--model` → settings 的
 * defaultModel → `openai/$OPENAI_API_MODEL_NAME`（旧的环境变量写法）。
 */
const NO_MODEL =
  '没有选模型：用 --model provider/id，或在 ~/.vela/settings.json 写 defaultModel（provider 见 ~/.vela/models.json，内置 openai / anthropic 读 OPENAI_API_KEY / ANTHROPIC_API_KEY），或设置 OPENAI_API_KEY + OPENAI_API_MODEL_NAME；离线体验用 VELA_MODEL=mock。'

/** 默认模型；都没配置时是 undefined（--continue 恢复的会话可能保存了模型，否则启动时提示 NO_MODEL） */
async function chooseModel(): Promise<LanguageModel | string | undefined> {
  // VELA_MODEL=mock：用内置关键词 demo 模型离线体验（模拟 prompt cache 行为）
  if (env.VELA_MODEL === 'mock') return createMockModel()
  // VELA_MODEL=faux:<scenario.json>：按 JSON 场景脚本回放模型响应（复现问题、CLI e2e）
  if (env.VELA_MODEL?.startsWith('faux:'))
    return loadFauxScenario(env.VELA_MODEL.slice('faux:'.length))
  return (
    args.model ??
    config.settings.defaultModel ??
    (env.OPENAI_API_MODEL_NAME ? `openai/${env.OPENAI_API_MODEL_NAME}` : undefined)
  )
}
const chosenModel = await chooseModel()

// VELA_RECORD=<file.json>：把这次运行的模型响应和用户输入录成 faux 场景，之后用 VELA_MODEL=faux:<file> 回放
// （只录默认模型；按名字选的模型这里先用 models.json / 内置 provider 解析，扩展注册的 provider 不支持录制）
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
    console.error(`[录制] ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}

// 交互模式的日志进 TUI 的对话区，debug 写 ~/.vela/debug.log；其它模式写 stderr
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
  limits: config.settings.limits,
  logger,
  extensionConfig: extensionConfigFromEnv(env, config.extensionConfig),
  // 内置扩展（memory / rag / web / supabase / feishu）+ ~/.vela/extensions + .vela/extensions + settings + -e
  extensions: await loadCliExtensions(config, args, (message) =>
    console.error(message),
  ),
})

/**
 * 用哪个会话（同 pi）：`--session <id>`；`-c` 接最近保存的（没有就开新的）；`-r` 交互模式里选；
 * 否则每次启动一个新会话。
 */
const sessionId =
  args.session ??
  (args.continue ? (await vela.listSessions())[0]?.id : undefined) ??
  newSessionId()
const resume = args.session !== undefined || args.continue
// 录制主会话的输入（-r 选中的会话 id 在 configure 时才知道），不录通道会话
let recordedSession = sessionId
if (recorder)
  vela.subscribe((event, id) => {
    if (event.type === 'agent_start' && id === recordedSession)
      recorder.addInput(event.input)
  })

/**
 * 恢复的会话带着保存的模型和 thinking；命令行显式给的优先，VELA_MODEL=mock / faux 和
 * VELA_RECORD 包装过的模型也优先（不然 --continue 会绕过回放 / 录制，改用保存的真实模型）。
 * 返回模型是否可用。
 */
function applyModelArgs(target: VelaSession): boolean {
  recordedSession = target.id
  if (args.thinking) target.setThinkingLevel(args.thinking)
  const override =
    args.model ??
    recorder?.model ??
    (typeof chosenModel === 'string' ? undefined : chosenModel)
  try {
    if (override) target.setModel(override)
    else void target.modelInfo
    return true
  } catch (error) {
    console.error(
      `[模型] ${chosenModel === undefined && !args.model ? NO_MODEL : error instanceof Error ? error.message : error}`,
    )
    return false
  }
}

const exit = async (code: number): Promise<never> => {
  await vela.dispose()
  await recorder?.flush()
  process.exit(code)
}

if (mode === 'print' || mode === 'json') {
  // 单次模式没有界面：扩展的 confirm 一律按“否”处理（同 pi 的 print 模式）
  const session = vela.session(sessionId)
  if (resume) await session.resume()
  // 扩展注册的 provider 要等扩展加载完才能解析（加载失败的话 prompt 会报）
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
  await vela.ready().catch((error) =>
    console.error(error instanceof Error ? error.message : error),
  )
  await runRpcMode({
    vela,
    sessionId,
    resume,
    newSessionId,
    // 没有模型时照样启动，客户端可以 set_model（错误打到 stderr）
    configure: (session) => void applyModelArgs(session),
    input: process.stdin,
    write: writeStdout,
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
