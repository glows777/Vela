#!/usr/bin/env bun
import { createInterface } from 'node:readline'
import { createOpenAI } from '@ai-sdk/openai'
import {
  Client,
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/client'
import type { LanguageModel } from 'ai'
import { feishu } from '../extensions/feishu'
import { supabase } from '../extensions/supabase'
import type { ExtensionUI } from '../extensions/types'
import { createEmbedder, type EmbeddingFn } from '../rag/embedder'
import { createMockModel } from '../testing/demo-model'
import { loadFauxScenario } from '../testing/faux'
import { recordModel } from '../testing/record'
import { createVela, velaInternals } from '../vela'
import type { CommandContext } from './commands'
import { createCliDispatcher } from './dispatcher'
import { createConsoleLogger } from './logger'
import { printEvent } from './print-event'

async function resolveModel(): Promise<LanguageModel> {
  // VELA_MODEL=mock：用内置关键词 demo 模型离线体验（模拟 prompt cache 行为）
  if (process.env.VELA_MODEL === 'mock') return createMockModel()
  // VELA_MODEL=faux:<scenario.json>：按 JSON 场景脚本回放模型响应（复现问题、CLI e2e）
  if (process.env.VELA_MODEL?.startsWith('faux:'))
    return loadFauxScenario(process.env.VELA_MODEL.slice('faux:'.length))
  const apiKey = process.env.OPENAI_API_KEY
  const modelName = process.env.OPENAI_API_MODEL_NAME
  if (!apiKey || !modelName) {
    console.error(
      'api key or model name is not set, please set OPENAI_API_KEY and OPENAI_API_MODEL_NAME in your environment, or run with VELA_MODEL=mock to use the offline mock model.',
    )
    process.exit(1)
  }
  return createOpenAI({
    apiKey,
    baseURL: process.env.OPENAI_API_BASE_URL,
  }).chat(modelName)
}

function resolveEmbedder(): EmbeddingFn | undefined {
  const apiKey = process.env.EMBEDDING_MODEL_KEY
  const modelId = process.env.EMBEDDING_MODEL
  const url = process.env.EMBEDDING_MODEL_BASE_URL
  if (!apiKey || !modelId || !url) {
    if (!printMode)
      console.log(
        '[RAG] 未配置 EMBEDDING_MODEL_KEY / EMBEDDING_MODEL / EMBEDDING_MODEL_BASE_URL，知识库功能已关闭',
      )
    return
  }
  return createEmbedder({ apiKey, url, modelId })
}

/** `-p "<prompt>"` / `--print "<prompt>"`：跑一轮就退出，不进入交互循环。 */
function printPrompt(argv: string[]): string | undefined {
  const i = argv.findIndex((arg) => arg === '-p' || arg === '--print')
  if (i === -1) return
  const prompt = argv[i + 1]
  if (!prompt) {
    console.error('用法: vela -p "<prompt>" [--continue]')
    process.exit(2)
  }
  return prompt
}

const printMode = printPrompt(process.argv.slice(2))
const isContinue = process.argv.includes('--continue')

// VELA_RECORD=<file.json>：把这次运行的模型响应和用户输入录成 faux 场景，之后用 VELA_MODEL=faux:<file> 回放
const recorder = process.env.VELA_RECORD
  ? recordModel(await resolveModel(), { path: process.env.VELA_RECORD })
  : undefined

const env = process.env
const vela = createVela({
  model: recorder?.model ?? (await resolveModel()),
  embedder: resolveEmbedder(),
  logger: createConsoleLogger({ debug: env.VELA_DEBUG === '1' }),
  // CLI 默认带上的内置扩展；配置从环境变量读（第 4 步换成配置文件）
  extensions: [
    supabase({ url: env.SUPABASE_URL, key: env.SUPABASE_KEY }),
    feishu({
      appId: env.FEISHU_APP_ID,
      appSecret: env.FEISHU_APP_SECRET,
      owners: env.FEISHU_OWNERS?.split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    }),
  ],
})
const internals = velaInternals(vela)
vela.subscribe((event, sessionId) => {
  if (recorder && event.type === 'agent_start' && sessionId === 'default')
    recorder.addInput(event.input)
  printEvent(event)
})

if (printMode !== undefined) {
  // -p 模式没有界面：扩展的 confirm 一律按“否”处理（同 pi 的 print 模式）
  const session = vela.session()
  if (isContinue) await session.resume()
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
  if (busy.locked && busy.controller) {
    if (!busy.controller.signal.aborted) {
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
