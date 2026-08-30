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
import {
  type CommandContext,
  contextCommands,
  createDispatcher,
  debugCommands,
  memoryCommands,
} from './commands'
import { dreamCommands } from './commands/dream'
import {
  MICROCOMPACT_TOKEN_THRESHOLD,
  microcompact,
  SUMMARY_TOKEN_THRESHOLD,
  summarize,
} from './context/compressor'
import { applyDefense, estimateMessageTokens } from './context/defense'
import { MemoryStore } from './memory/store'
import {
  coreRules,
  deferredTools,
  memoryContext,
  ragContext,
  sessionContext,
  toolGuide,
} from './prompt'
import { type PromptContext, PromptPipeline } from './prompt/pipelins'
import { chunkDocument } from './rag/chunker'
import { createEmbedder, embed } from './rag/embedder'
import { SqliteVectorStore } from './rag/sqllite-store'
import { SessionStore } from './session'
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
})

const messages: ModelMessage[] = []
const toolRegistry = new ToolRegistry()
toolRegistry.register(...allTools)

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

const isContinue = process.argv.includes('--continue')
const store = new SessionStore('default')
const tokenTracker = new TokenTracker('.usage/today.jsonl')
let summary = ''
const timestamps = new Map<ModelMessage, number>()
const dispatch = createDispatcher([
  ...debugCommands,
  ...contextCommands,
  ...memoryCommands,
  ...dreamCommands,
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
  messages.push(...state.messages)
  for (const [message, timestamp] of state.timestamps) {
    timestamps.set(message, timestamp)
  }
  summary = state.summary
  tokenTracker.setEstimatedTokens(estimateMessageTokens(messages))
  console.log(`[Session] 恢复会话，${messages.length} 条历史消息`)
} else {
  console.log(`[Session] 新会话`)
}

const builder = new PromptPipeline()
  .pipe('coreRules', coreRules())
  .pipe('toolGuide', toolGuide())
  .pipe('deferredTools', deferredTools())
  .pipe('memoryContext', memoryContext(memoryStore))
  .pipe('ragContext', ragContext(vectorStore))
  .pipe('sessionContext', sessionContext())

const promptCtx: PromptContext = {
  toolCount: toolRegistry.getAllTools().length,
  deferredToolSummary: toolRegistry.getDeferredToolSummary(),
  sessionMessageCount: messages.length,
  sessionId: 'default',
}

builder.debug(promptCtx) // 显示各模块状态

function messagesChanged(
  before: ModelMessage[],
  after: ModelMessage[],
): boolean {
  return (
    before.length !== after.length ||
    before.some((message, index) => message !== after[index])
  )
}

function replaceMessagesInPlace(
  target: ModelMessage[],
  replacement: ModelMessage[],
): void {
  const previous = target.slice()
  const knownTimestamps = new Map(timestamps)
  const fallbackTimestamp = Date.now()

  target.splice(0, target.length, ...replacement)
  timestamps.clear()

  replacement.forEach((message, index) => {
    const timestamp =
      knownTimestamps.get(message) ??
      (previous[index] ? knownTimestamps.get(previous[index]!) : undefined) ??
      fallbackTimestamp
    timestamps.set(message, timestamp)
  })
}

function ensureMessageTimestamps(history: ModelMessage[]): void {
  const liveMessages = new Set(history)
  const now = Date.now()

  for (const message of history) {
    if (!timestamps.has(message)) {
      timestamps.set(message, now)
    }
  }

  for (const message of timestamps.keys()) {
    if (!liveMessages.has(message)) {
      timestamps.delete(message)
    }
  }
}

function currentContextTokens(history: ModelMessage[]): number {
  return Math.max(tokenTracker.estimatedTokens, estimateMessageTokens(history))
}

async function prepareContextForModel(history: ModelMessage[]): Promise<void> {
  ensureMessageTimestamps(history)

  const beforeDefense = history.slice()
  const defense = applyDefense(history, timestamps)
  if (messagesChanged(beforeDefense, defense.messages)) {
    tokenTracker.replaceMessages(beforeDefense, defense.messages)
    replaceMessagesInPlace(history, defense.messages)
  }

  if (
    defense.truncated > 0 ||
    defense.compacted > 0 ||
    defense.softPruned > 0 ||
    defense.hardPruned > 0
  ) {
    console.log(
      `  [Defense] truncated=${defense.truncated}, compacted=${defense.compacted}, softPruned=${defense.softPruned}, hardPruned=${defense.hardPruned}`,
    )
  }

  let tokenEstimate = currentContextTokens(history)
  if (tokenEstimate >= MICROCOMPACT_TOKEN_THRESHOLD) {
    const beforeMicrocompact = history.slice()
    const compacted = microcompact(history)
    if (
      compacted.cleared > 0 &&
      messagesChanged(beforeMicrocompact, compacted.messages)
    ) {
      tokenTracker.replaceMessages(beforeMicrocompact, compacted.messages)
      replaceMessagesInPlace(history, compacted.messages)
      tokenEstimate = currentContextTokens(history)
      console.log(
        `  [Microcompact] 清理了 ${compacted.cleared} 个工具结果，~${tokenEstimate} tokens`,
      )
    }
  }

  if (tokenEstimate >= SUMMARY_TOKEN_THRESHOLD) {
    const beforeSummary = history.slice()
    const compacted = await summarize(model, history, summary, tokenEstimate)
    if (
      compacted.compressedCount > 0 &&
      messagesChanged(beforeSummary, compacted.messages)
    ) {
      tokenTracker.replaceMessages(beforeSummary, compacted.messages)
      replaceMessagesInPlace(history, compacted.messages)
      summary = compacted.summary
      console.log(
        `  [Summarization] 压缩了 ${compacted.compressedCount} 条消息，~${currentContextTokens(history)} tokens`,
      )
    }
  }
}

// if (fs.existsSync('docs')) {
//   const files = fs.readdirSync('docs').filter((f) => f.endsWith('.md'))
//   if (files.length > 0) {
//     console.log(`  发现 ${files.length} 个文档，u...`)
//     for (const f of files) {
//       const path = `docs/${f}`
//       const text = fs.readFileSync(path, 'utf-8')
//       const chunks = chunkDocument(path, text)
//       const embeddings = await embed(
//         embedFn,
//         chunks.map((c) => c.text),
//       )
//       vectorStore.addBatch(
//         chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i]! })),
//       )
//       console.log(`    ${f} → ${chunks.length} 个片段`)
//     }
//     console.log(`  知识库就绪，共 ${vectorStore.size()} 个片段\n`)
//   }
// }

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
      ask,
      memoryStore,
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

    try {
      await agentLoop({
        model,
        systemPrompt: currentSystem,
        toolRegistry,
        messages,
        tokenTracker,
        prepareContext: prepareContextForModel,
      })
    } finally {
      ensureMessageTimestamps(messages)
      await store.replace(messages, timestamps, summary)
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
