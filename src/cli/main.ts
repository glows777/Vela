#!/usr/bin/env bun
import { createInterface } from 'node:readline'
import {
  Client,
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/client'
import type { LanguageModel } from 'ai'
import {
  defaultAgentDir,
  loadConfig,
  type VelaConfig,
} from '../config'
import type { ExtensionUI } from '../extensions/types'
import { memorySessionStorage } from '../session/storage'
import { createMockModel } from '../testing/demo-model'
import { loadFauxScenario } from '../testing/faux'
import { recordModel } from '../testing/record'
import { ModelRegistry } from '../models'
import { createVela, velaInternals } from '../vela'
import type { VelaSession } from '../vela-session'
import type { CommandContext } from './commands'
import { createCliDispatcher } from './dispatcher'
import { createConsoleLogger } from './logger'
import { printEvent } from './print-event'
import {
  BUILTIN_EXTENSIONS,
  type CliArgs,
  extensionConfigFromEnv,
  legacyDataHint,
  loadCliExtensions,
  parseArgs,
  resolveTrust,
} from './setup'

let args: CliArgs
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  console.error(
    '用法: vela [-p "<prompt>"] [--continue] [-e <扩展>]... [--no-extensions] [--no-session] [--approve | --no-approve] [--model provider/id] [--thinking <级别>]',
  )
  process.exit(2)
}
const printMode = args.print
const isContinue = args.continue
const env = process.env
const cwd = process.cwd()

// 配置：~/.vela/settings.json + 信任后的 <cwd>/.vela/settings.json（第 4 步，见 04-plan.md）
const agentDir = defaultAgentDir(env)
const trust = await resolveTrust({
  cwd,
  agentDir,
  approve: args.approve,
  interactive: printMode === undefined && process.stdin.isTTY === true,
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

const logger = createConsoleLogger({ debug: env.VELA_DEBUG === '1' })
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
const internals = velaInternals(vela)
vela.subscribe((event, sessionId) => {
  if (recorder && event.type === 'agent_start' && sessionId === 'default')
    recorder.addInput(event.input)
  printEvent(event)
})

/** 恢复的会话带着保存的模型和 thinking；命令行显式给的优先。返回模型是否可用。 */
function applyModelArgs(target: VelaSession): boolean {
  if (args.thinking) target.setThinkingLevel(args.thinking)
  try {
    if (args.model) target.setModel(args.model)
    else void target.modelInfo
    return true
  } catch (error) {
    console.error(
      `[模型] ${chosenModel === undefined && !args.model ? NO_MODEL : error instanceof Error ? error.message : error}`,
    )
    return false
  }
}

if (printMode !== undefined) {
  // -p 模式没有界面：扩展的 confirm 一律按“否”处理（同 pi 的 print 模式）
  const session = vela.session()
  if (isContinue) await session.resume()
  // 扩展注册的 provider 要等扩展加载完才能解析（加载失败的话 prompt 会报）
  await vela.ready().catch(() => {})
  if (!applyModelArgs(session)) {
    await vela.dispose()
    process.exit(1)
  }
  let exitCode = 0
  try {
    await session.prompt(printMode)
  } catch (error) {
    console.error(
      '[Agent] 本轮停止:',
      error instanceof Error ? error.message : error,
    )
    exitCode = 1
  }
  await vela.dispose()
  await recorder?.flush()
  process.exit(exitCode)
}
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})
let rlClosed = false
// 自己排队输入行：管道输入会一次性读完，rl.question 注册前到达的行会丢失
const pendingLines: string[] = []
let lineWaiter: ((line: string | undefined) => void) | undefined
rl.on('line', (line) => {
  const waiter = lineWaiter
  lineWaiter = undefined
  if (waiter) waiter(line)
  else pendingLines.push(line)
})
rl.on('close', () => {
  rlClosed = true
  lineWaiter?.(undefined)
  lineWaiter = undefined
  // 终端里 Ctrl+D 中断当前任务；管道输入读到 EOF 时让已排队的行照常跑完
  if (process.stdin.isTTY)
    session.abort(new DOMException('输入已关闭', 'AbortError'))
})
const nextLine = (): Promise<string | undefined> => {
  if (pendingLines.length) return Promise.resolve(pendingLines.shift())
  if (rlClosed) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    lineWaiter = resolve
  })
}

/** 交互模式下扩展的界面：在终端里提问，读下一行输入作为回答。 */
const terminalUI: ExtensionUI = {
  notify: (message, level = 'info') =>
    console.log(level === 'info' ? `\n${message}` : `\n[${level}] ${message}`),
  async confirm(title, message) {
    console.log(`\n${title}\n${message}`)
    process.stdout.write('允许？(y/N) ')
    const answer = (await nextLine())?.trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  },
  async select(title, options) {
    console.log(`\n${title}`)
    for (const [i, option] of options.entries())
      console.log(`  ${i + 1}. ${option}`)
    process.stdout.write('选择编号（回车取消）: ')
    const index = Number((await nextLine())?.trim()) - 1
    return options[index]
  },
  async input(title, placeholder) {
    process.stdout.write(
      `\n${title}${placeholder ? ` (${placeholder})` : ''}: `,
    )
    const answer = (await nextLine())?.trim()
    return answer || undefined
  },
}
const session = vela.session('default', { ui: terminalUI })
const { busy, messages } = session

const MCP_INITIAL_RETRY_DELAY_MS = 30_000
const MCP_MAX_RETRY_DELAY_MS = 5 * 60_000

const mcpConnection: Promise<boolean> | null = null
let mcpFailureCount = 0
let nextMCPRetryAt = 0

async function connectMCP() {
  // if (mcpConnection) {
  //   await mcpConnection;
  //   return;
  // }
  // if (Date.now() < nextMCPRetryAt) {
  //   return;
  // }
  // const connection = connectGitHubMCP();
  // mcpConnection = connection;
  // const connected = await connection;
  // if (connected) {
  //   mcpFailureCount = 0;
  //   nextMCPRetryAt = 0;
  // } else {
  //   if (mcpConnection === connection) {
  //     mcpConnection = null;
  //   }
  //   scheduleMCPRetry();
  // }
}

async function connectGitHubMCP(): Promise<boolean> {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN

  if (!githubToken) {
    console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，使用 Mock MCP')
    return true
  }

  console.log('\n连接 GitHub MCP Server...')
  try {
    const transport = new StdioClientTransport({
      command: 'bunx',
      args: ['@modelcontextprotocol/server-github'],
      env: {
        ...getDefaultEnvironment(),
        GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
      },
    })
    const client = new Client({ name: 'Vela-agent', version: '1.0.0' })
    const tools = await internals.registry.registerMCPServer(
      'github',
      client,
      transport,
    )
    console.log(`  已注册 ${tools.length} 个 MCP 工具`)
    return true
  } catch (err) {
    console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`)
    console.log(err)
    return false
  }
}

function scheduleMCPRetry() {
  mcpFailureCount++
  const delay = Math.min(
    MCP_INITIAL_RETRY_DELAY_MS * 2 ** (mcpFailureCount - 1),
    MCP_MAX_RETRY_DELAY_MS,
  )
  nextMCPRetryAt = Date.now() + delay
  console.log(`  MCP 将在 ${Math.round(delay / 1000)} 秒后再次尝试连接`)
}

await connectMCP()

const cancelOrClose = () => {
  // 正在跑 agent loop 或扩展命令（例如 /rag ingest）时取消它，空闲时退出
  const signal = session.signal
  if (signal) {
    if (!signal.aborted) {
      session.abort()
      console.log('\n[取消] 正在停止当前请求和工具…')
    }
  } else rl.close()
}
rl.on('SIGINT', cancelOrClose)
process.on('SIGINT', cancelOrClose)

const dispatch = createCliDispatcher(vela)

if (isContinue && (await session.resume())) {
  console.log(`[Session] 恢复会话，${messages.length} 条历史消息`)
} else {
  console.log(`[Session] 新会话`)
}

// Persist the history identity before any tool side effects, including on legacy resume.
await session.save()

// 显示各 prompt 段落的状态
console.log('\n=== Prompt PipeLine Debug ===')
for (const { name, chars } of internals.builder.status({
  ...session.promptContext(),
  toolCount: internals.registry.getAllTools().length,
}))
  console.log(`  ${name}: ${chars === null ? '[OFF]' : `[ON] ${chars} chars`}`)
console.log('========================\n')
try {
  await vela.ready()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
}
if (applyModelArgs(session))
  console.log(
    `  模型 ${session.modelInfo.ref}${session.thinkingLevel ? `，thinking ${session.thinkingLevel}` : ''}`,
  )
else console.error('  用 /model provider/id 换一个模型')
for (const ext of vela.extensions())
  console.log(
    `  ✓ 扩展 ${ext.name}${ext.tools.length ? ` — ${ext.tools.length} 个工具` : ''}`,
  )
console.log('  启动 Channel...')
await vela.startChannels()
const ask = () => {
  if (rlClosed) process.stdout.write('You: ')
  else {
    rl.setPrompt('You: ')
    rl.prompt()
  }
  void nextLine().then(async (input) => {
    await connectMCP()

    const trimmed = (input ?? '').trim()
    if (!trimmed || trimmed === 'exit') {
      console.log('Bye!')
      await vela.dispose()
      await recorder?.flush()
      rl.close()
      return
    }

    const ctx: CommandContext = { vela, internals, session, ask }
    if (busy.locked) {
      console.log('\n[system] 有任务正在执行中，请稍候再输入\n')
      // 不调用 ask()：当前 agentLoop 的 .then/.catch 完成后会重新注册 question
      return
    }
    const handled = dispatch(trimmed, ctx)
    if (handled === 'async') return
    if (handled) {
      ask()
      return
    }

    // VELA_DEBUG=1 时打印每轮重新构建的 system prompt
    if (process.env.VELA_DEBUG === '1') console.log(session.buildSystem())

    try {
      await session.prompt(trimmed)
    } catch (error) {
      console.error(
        '[Agent] 本轮停止:',
        error instanceof Error ? error.message : error,
      )
    }

    const status = session.tracker.status
    console.log(`  [Token] ~${status.tokens} tokens (${status.percent}%)`)
    ask()
  })
}

ask()
