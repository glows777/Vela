import { createInterface } from 'node:readline'
import { createOpenAI } from '@ai-sdk/openai'
import {
  Client,
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/client'
import type { LanguageModel } from 'ai'
import { createVela } from './app'
import { printEvent } from './cli/print-event'
import {
  type CommandContext,
  contextCommands,
  createDispatcher,
  debugCommands,
  memoryCommands,
} from './commands'
import { createChannelCommands } from './commands/channel'
import { dreamCommands } from './commands/dream'
import { createPluginCommands } from './commands/plugin'
import { ragCommands } from './commands/rag'
import { createSecurityCommands } from './commands/security'
import { createSkillCommands } from './commands/skill'
import { createMockModel } from './mock'
import { feishuPlugin } from './plugins/built-in-plugins/feishu-plugin'
import { supabasePlugin } from './plugins/built-in-plugins/supabase-plugin'
import type { PluginDefinition } from './plugins/types'
import { createEmbedder, type EmbeddingFn } from './rag/embedder'

function resolveModel(): LanguageModel {
  // VELA_MODEL=mock：用内置 Mock 模型离线运行（模拟 prompt cache 行为）
  if (process.env.VELA_MODEL === 'mock') return createMockModel()
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
    console.log(
      '[RAG] 未配置 EMBEDDING_MODEL_KEY / EMBEDDING_MODEL / EMBEDDING_MODEL_BASE_URL，知识库功能已关闭',
    )
    return
  }
  return createEmbedder({ apiKey, url, modelId })
}

const vela = createVela({
  model: resolveModel(),
  embedder: resolveEmbedder(),
  onEvent: printEvent,
})
const { busy, messages } = vela

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})
let rlClosed = false
rl.on('close', () => {
  rlClosed = true
  vela.abort(new DOMException('输入已关闭', 'AbortError'))
})

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
    const tools = await vela.registry.registerMCPServer(
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
      vela.abort()
      console.log('\n[取消] 正在停止当前请求和工具…')
    }
  } else rl.close()
}
rl.on('SIGINT', cancelOrClose)
process.on('SIGINT', cancelOrClose)

const isContinue = process.argv.includes('--continue')

const availablePlugins = new Map<string, PluginDefinition>([
  ['supabase', supabasePlugin],
  ['feishu', feishuPlugin],
])
const dispatch = createDispatcher([
  ...debugCommands,
  ...contextCommands,
  ...memoryCommands,
  ...dreamCommands,
  ...ragCommands,
  ...createSkillCommands(vela.skillLoader, vela.activeSkills),
  ...createPluginCommands(vela.pluginManager, availablePlugins),
  ...createChannelCommands(vela.gateway),
  ...createSecurityCommands(vela.registry, vela.hooks),
])

if (isContinue && (await vela.resume())) {
  console.log(`[Session] 恢复会话，${messages.length} 条历史消息`)
} else {
  console.log(`[Session] 新会话`)
}

// Persist the history identity before any tool side effects, including on legacy resume.
await vela.saveSession()

vela.builder.debug({
  ...vela.makePromptCtx(),
  toolCount: vela.registry.getAllTools().length,
}) // 显示各模块状态
console.log('  加载插件...')
for (const [name, def] of availablePlugins) {
  try {
    const tools = await vela.pluginManager.load(def)
    console.log(`  ✓ ${name} — ${tools.length} 个工具`)
  } catch {
    console.log(`  ✗ ${name} — 加载失败`)
  }
}

console.log('  启动 Channel...')
await vela.gateway.startAll()
const ask = () => {
  if (rlClosed) {
    return
  }

  rl.question('You: ', async (input) => {
    await connectMCP()

    const trimmed = input.trim()
    if (!trimmed || trimmed === 'exit') {
      console.log('Bye!')
      await vela.dispose()
      rl.close()
      return
    }

    const ctx: CommandContext = vela.commandContext(ask)
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
    if (process.env.VELA_DEBUG === '1') console.log(vela.buildSystem())

    try {
      await vela.run(trimmed)
    } catch (error) {
      console.error(
        '[Agent] 本轮停止:',
        error instanceof Error ? error.message : error,
      )
    }

    const status = vela.tracker.status
    console.log(`  [Token] ~${status.tokens} tokens (${status.percent}%)`)
    ask()
  })
}

if (rlClosed) {
  await vela.registry.closeAllMCP()
} else {
  ask()
}
