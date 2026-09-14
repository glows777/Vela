import fs from 'node:fs'
import { createInterface } from 'node:readline'
import { createOpenAI } from '@ai-sdk/openai'
import {
  Client,
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/client'
import type { ModelMessage } from 'ai'
import { agentLoop } from './agent'
import { ChannelGateway } from './channels/gateway'
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
import { createSkillCommands } from './commands/skill'
import { createSecurityCommands } from './commands/security'
import { estimateMessageTokens } from './context/defense'
import { ContextManager } from './context/manager'
import { MemoryStore } from './memory/store'
import { feishuPlugin } from './plugins/built-in-plugins/feishu-plugin'
import { supabasePlugin } from './plugins/built-in-plugins/supabase-plugin'
import { PluginManager } from './plugins/manager'
import type { PluginDefinition } from './plugins/types'
import {
  coreRules,
  deferredTools,
  memoryContext,
  ragContext,
  sessionContext,
  toolGuide,
  toolHistoryGuide,
} from './prompt'
import { type PromptContext, PromptPipeline } from './prompt/pipelins'
import { chunkDocument } from './rag/chunker'
import { createEmbedder, embed } from './rag/embedder'
import { SqliteVectorStore } from './rag/sqllite-store'
import { SessionStore } from './session'
import { HookPipeline } from './security/hooks'
import { SkillLoader } from './skills/loader'
import { allTools } from './tools'
import { createMemoryTool } from './tools/memory-tool'
import { createRagTools } from './tools/rag'
import { ToolRegistry } from './tools/registry'
import { registerToolSearchTool } from './tools/tool-search'
import { TokenTracker } from './usage/tracker'

const apiKey = process.env.OPENAI_API_KEY
const modelName = process.env.OPENAI_API_MODEL_NAME
const embeddingApiKey = process.env.EMBEDDING_MODEL_KEY
const embeddingModel = process.env.EMBEDDING_MODEL
const embeddingBaseUrl = process.env.EMBEDDING_MODEL_BASE_URL

if (!apiKey || !modelName) {
  console.error(
    'api key or model name is not set, please set OPENAI_API_KEY and OPENAI_API_MODEL_NAME in your environment.',
  )
  process.exit(1)
}

if (!embeddingApiKey || !embeddingModel || !embeddingBaseUrl) {
  console.error(
    'embedding api key or model name or url is not set, please set ..... in your environment',
  )
  process.exit(1)
}
const model = createOpenAI({
  apiKey,
  baseURL: process.env.OPENAI_API_BASE_URL,
}).chat(modelName)

// const model = createMockModel();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})
let rlClosed = false
rl.on('close', () => {
  rlClosed = true
  busy.controller?.abort(new DOMException('输入已关闭', 'AbortError'))
})

const messages: ModelMessage[] = []
const store = new SessionStore('default')
const toolRegistry = new ToolRegistry(store.results)
toolRegistry.register(...allTools)

const hookPipeline = new HookPipeline()
hookPipeline.registerPre('audit-log', (toolName, input) => {
  if (toolName === 'write_file' || toolName === 'edit_file') {
    const path = (input as { path?: string } | null)?.path || 'unknown'
    console.log(`  [audit] 文件写入操作: ${toolName} → ${path}`)
  }
  return { action: 'allow' }
})
hookPipeline.registerPost('bash-timestamp', (toolName, _input, output) => {
  if (toolName === 'bash') {
    return {
      action: 'modify',
      modifiedOutput: `[${new Date().toISOString()}]\n${output}`,
    }
  }
  return { action: 'allow' }
})
toolRegistry.setHookPipeline(hookPipeline)

registerToolSearchTool(toolRegistry)

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
    const tools = await toolRegistry.registerMCPServer(
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

const skillLoader = new SkillLoader('.')
const loadedSkills = skillLoader.load()
const activeSkills = new Set<string>()
/** agent 循环互斥锁（单飞）：任意 agentLoop 运行期间置位，拒绝并发启动第二个循环 */
const busy: CommandContext['busy'] = { locked: false }
const cancelOrClose = () => {
  if (busy.locked && busy.controller) {
    if (!busy.controller.signal.aborted) {
      busy.controller.abort(new DOMException('用户取消当前操作', 'AbortError'))
      console.log('\n[取消] 正在停止当前请求和工具…')
    }
  } else rl.close()
}
rl.on('SIGINT', cancelOrClose)
process.on('SIGINT', cancelOrClose)

const isContinue = process.argv.includes('--continue')
const tokenTracker = new TokenTracker('.usage/today.jsonl')
const contextManager = new ContextManager(store, tokenTracker, {
  messages,
  timestamps: new Map(),
  summary: '',
})
const timestamps = contextManager.state.timestamps
const prepareContextForModel = contextManager.prepare.bind(contextManager)
const saveSession = contextManager.save.bind(contextManager)

const gateway = new ChannelGateway({
  model,
  registry: toolRegistry,
  buildSystem: () => builder.build(makePromptCtx()),
  prepareContext: prepareContextForModel,
})

const pluginManager = new PluginManager(toolRegistry, gateway)
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
  ...createSkillCommands(skillLoader, activeSkills),
  ...createPluginCommands(pluginManager, availablePlugins),
  ...createChannelCommands(gateway),
  ...createSecurityCommands(toolRegistry, hookPipeline),
])

const memoryStore = new MemoryStore('.')
memoryStore.init()
toolRegistry.register(createMemoryTool(memoryStore))

const vectorStore = new SqliteVectorStore('knowledge.db')
const embedFn = createEmbedder({
  apiKey: embeddingApiKey,
  url: embeddingBaseUrl,
  modelId: embeddingModel,
})
toolRegistry.register(...createRagTools(vectorStore, embedFn))

function makePromptCtx(): PromptContext {
  return {
    toolCount: toolRegistry.getActiveTools().length,
    deferredToolSummary: toolRegistry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId: 'default',
  }
}

if (isContinue && (await store.exists())) {
  const state = await store.loadState()
  contextManager.restore(state)
  tokenTracker.setEstimatedTokens(estimateMessageTokens(messages))
  console.log(`[Session] 恢复会话，${messages.length} 条历史消息`)
} else {
  console.log(`[Session] 新会话`)
}

// Persist the history identity before any tool side effects, including on legacy resume.
await saveSession()

const builder = new PromptPipeline()
  .pipe('coreRules', coreRules())
  .pipe('toolGuide', toolGuide())
  .pipe('toolHistoryGuide', toolHistoryGuide(store.results))
  .pipe('deferredTools', deferredTools())
  .pipe('memoryContext', memoryContext(memoryStore))
  .pipe('ragContext', ragContext(vectorStore))
  .pipe('skillContext', () => skillLoader.buildPromptSection(activeSkills))
  .pipe('sessionContext', sessionContext())

const promptCtx: PromptContext = {
  toolCount: toolRegistry.getAllTools().length,
  deferredToolSummary: toolRegistry.getDeferredToolSummary(),
  sessionMessageCount: messages.length,
  sessionId: 'default',
}

builder.debug(promptCtx) // 显示各模块状态
console.log('  加载插件...')
for (const [name, def] of availablePlugins) {
  try {
    const tools = await pluginManager.load(def)
    console.log(`  ✓ ${name} — ${tools.length} 个工具`)
  } catch {
    console.log(`  ✗ ${name} — 加载失败`)
  }
}

console.log('  启动 Channel...')
await gateway.startAll()
const ask = () => {
  if (rlClosed) {
    return
  }

  rl.question('You: ', async (input) => {
    await connectMCP()

    const trimmed = input.trim()
    if (!trimmed || trimmed === 'exit') {
      console.log('Bye!')
      await toolRegistry.closeAllMCP()
      await pluginManager.unloadAll()
      await gateway.stopAll()
      rl.close()
      return
    }

    const ctx: CommandContext = {
      messages,
      timestamps,
      registry: toolRegistry,
      builder,
      tracker: tokenTracker,
      sessionStore: store,
      model,
      makePromptCtx,
      prepareContext: prepareContextForModel,
      saveSession,
      ask,
      memoryStore,
      vectorStore,
      busy,
    }
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

    const userMsg: ModelMessage = { role: 'user', content: trimmed }
    messages.push(userMsg)
    tokenTracker.addMessage(userMsg)
    timestamps.set(userMsg, Date.now())

    // * 在每次循环前重新构建system prompt，以便在工具注册或记忆更新后，系统 prompt 能够在下一轮对话中反映最新状态
    const currentSystem = builder.build(makePromptCtx())
    console.log(currentSystem)

    busy.locked = true
    busy.controller = new AbortController()
    try {
      await agentLoop({
        model,
        systemPrompt: () => builder.build(makePromptCtx()),
        toolRegistry,
        messages,
        tokenTracker,
        prepareContext: prepareContextForModel,
        abortSignal: busy.controller.signal,
      })
    } catch (error) {
      console.error(
        '[Agent] 本轮停止:',
        error instanceof Error ? error.message : error,
      )
    } finally {
      try {
        await saveSession()
      } catch (error) {
        console.error(
          '[Session] 保存失败:',
          error instanceof Error ? error.message : error,
        )
      }
      busy.locked = false
      busy.controller = undefined
    }

    const status = tokenTracker.status
    console.log(`  [Token] ~${status.tokens} tokens (${status.percent}%)`)
    ask()
  })
}

if (rlClosed) {
  await toolRegistry.closeAllMCP()
} else {
  ask()
}
