import { join, resolve } from 'node:path'
import type { LanguageModel, ModelMessage } from 'ai'
import { agentLoop } from './agent'
import type { VelaEventListener } from './agent/events'
import { ChannelGateway } from './channels/gateway'
import type { CommandContext } from './commands'
import { estimateMessageTokens } from './context/defense'
import { ContextManager } from './context/manager'
import { resolveLimits, type VelaLimits } from './limits'
import { MemoryStore } from './memory/store'
import { PluginManager } from './plugins/manager'
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
import type { EmbeddingFn } from './rag/embedder'
import { SqliteVectorStore } from './rag/sqllite-store'
import { HookPipeline } from './security/hooks'
import { SessionStore } from './session'
import { SkillLoader } from './skills/loader'
import { createCoreTools } from './tools'
import { createMemoryTool } from './tools/memory-tool'
import { createRagTools } from './tools/rag'
import { ToolRegistry } from './tools/registry'
import { registerToolSearchTool } from './tools/tool-search'
import { TokenTracker } from './usage/tracker'

export interface VelaOptions {
  /** 主模型。CLI 负责从环境变量创建，测试传入 mock/faux 模型。 */
  model: LanguageModel
  /** 文件、搜索、bash 工具和 skill 的工作目录，默认 process.cwd()。 */
  cwd?: string
  /** .sessions / .memory / .usage / knowledge.db 的根目录，默认等于 cwd。 */
  dataDir?: string
  /** 会话 id，默认 'default'。 */
  sessionId?: string
  /** embedding 函数；不传时不注册 RAG 工具，system prompt 也不包含知识库段落。 */
  embedder?: EmbeddingFn
  /** 运行事件回调（agent loop、上下文压缩、通道）。 */
  onEvent?: VelaEventListener
  /** 轮数、重试、预算、压缩阈值等上限；未给出的字段用默认值（见 src/limits.ts）。 */
  limits?: Partial<VelaLimits>
}

export interface RunOptions {
  signal?: AbortSignal
}

/**
 * 装配一个完整的 Vela 运行环境：工具、hooks、prompt、记忆、RAG、会话、上下文管理、
 * 插件和通道。CLI 与测试共用这一份装配逻辑。
 */
export function createVela(options: VelaOptions) {
  const cwd = resolve(options.cwd ?? process.cwd())
  const dataDir = resolve(cwd, options.dataDir ?? '.')
  const sessionId = options.sessionId ?? 'default'
  const { model, embedder } = options
  const limits = resolveLimits(options.limits)
  let onEvent = options.onEvent
  const emit: VelaEventListener = (event) => onEvent?.(event)

  const messages: ModelMessage[] = []
  const sessionStore = new SessionStore(sessionId, join(dataDir, '.sessions'))
  const registry = new ToolRegistry(sessionStore.results)
  registry.register(...createCoreTools({ cwd, bashTimeoutMs: limits.bashTimeoutMs }))

  const hooks = new HookPipeline()
  hooks.registerPre('audit-log', (toolName, input) => {
    if (toolName === 'write_file' || toolName === 'edit_file') {
      const path = (input as { path?: string } | null)?.path || 'unknown'
      console.log(`  [audit] 文件写入操作: ${toolName} → ${path}`)
    }
    return { action: 'allow' }
  })
  hooks.registerPost('bash-timestamp', (toolName, _input, output) => {
    if (toolName === 'bash') {
      return {
        action: 'modify',
        modifiedOutput: `[${new Date().toISOString()}]\n${output}`,
      }
    }
    return { action: 'allow' }
  })
  registry.setHookPipeline(hooks)
  registerToolSearchTool(registry)

  const skillLoader = new SkillLoader(cwd)
  skillLoader.load()
  const activeSkills = new Set<string>()

  const usageLogPath = join(dataDir, '.usage', 'today.jsonl')
  const tracker = new TokenTracker(usageLogPath)
  const contextManager = new ContextManager(
    sessionStore,
    tracker,
    { messages, timestamps: new Map(), summary: '' },
    emit,
    limits,
  )
  const timestamps = contextManager.state.timestamps
  const prepareContext = contextManager.prepare.bind(contextManager)
  const saveSession = contextManager.save.bind(contextManager)

  const memoryStore = new MemoryStore(dataDir)
  memoryStore.init()
  registry.register(createMemoryTool(memoryStore))

  const vectorStore = new SqliteVectorStore(join(dataDir, 'knowledge.db'))
  if (embedder) registry.register(...createRagTools(vectorStore, embedder))

  const makePromptCtx = (): PromptContext => ({
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId,
  })

  const builder = new PromptPipeline()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('toolHistoryGuide', toolHistoryGuide(sessionStore.results))
    .pipe('deferredTools', deferredTools())
    .pipe('memoryContext', memoryContext(memoryStore))
  if (embedder) builder.pipe('ragContext', ragContext(vectorStore))
  builder
    .pipe('skillContext', () => skillLoader.buildPromptSection(activeSkills))
    .pipe('sessionContext', sessionContext())
  const buildSystem = () => builder.build(makePromptCtx())

  const gateway = new ChannelGateway({
    model,
    registry,
    buildSystem,
    prepareContext,
    createTracker: () => new TokenTracker(usageLogPath),
    onEvent: emit,
    limits,
  })
  const pluginManager = new PluginManager(registry, gateway)

  /** agent 循环互斥锁（单飞）：任意 agentLoop 运行期间置位，拒绝并发启动第二个循环 */
  const busy: CommandContext['busy'] = { locked: false }

  return {
    cwd,
    dataDir,
    sessionId,
    model,
    limits,
    messages,
    timestamps,
    registry,
    hooks,
    builder,
    tracker,
    sessionStore,
    contextManager,
    memoryStore,
    vectorStore,
    skillLoader,
    activeSkills,
    gateway,
    pluginManager,
    busy,
    makePromptCtx,
    buildSystem,
    prepareContext,
    saveSession,

    /** 替换事件回调（例如 CLI 在启动后接上渲染器）。 */
    setEventListener(listener: VelaEventListener | undefined) {
      onEvent = listener
    },

    /** 从磁盘恢复会话；返回是否找到已有会话。 */
    async resume(): Promise<boolean> {
      if (!(await sessionStore.exists())) return false
      contextManager.restore(await sessionStore.loadState())
      tracker.setEstimatedTokens(estimateMessageTokens(messages))
      return true
    },

    /** 追加一条用户消息并跑完一次 agent loop，结束后保存会话。 */
    async run(input: string, runOptions: RunOptions = {}): Promise<void> {
      if (busy.locked) throw new Error('有任务正在执行中')
      const userMsg: ModelMessage = { role: 'user', content: input }
      messages.push(userMsg)
      tracker.addMessage(userMsg)
      timestamps.set(userMsg, Date.now())

      busy.locked = true
      busy.controller = new AbortController()
      const forward = () => busy.controller?.abort(runOptions.signal?.reason)
      runOptions.signal?.addEventListener('abort', forward, { once: true })
      if (runOptions.signal?.aborted) forward()
      try {
        await agentLoop({
          model,
          systemPrompt: buildSystem,
          toolRegistry: registry,
          messages,
          tokenTracker: tracker,
          prepareContext,
          abortSignal: busy.controller.signal,
          onEvent: emit,
          limits,
        })
      } finally {
        runOptions.signal?.removeEventListener('abort', forward)
        try {
          await saveSession()
        } catch (error) {
          emit({ type: 'session_save_failed', error })
        } finally {
          busy.locked = false
          busy.controller = undefined
        }
      }
    },

    /** 中断当前 agent loop（如果有）。 */
    abort(
      reason: unknown = new DOMException('用户取消当前操作', 'AbortError'),
    ) {
      if (busy.controller && !busy.controller.signal.aborted)
        busy.controller.abort(reason)
    },

    /** 给斜杠命令用的上下文；ask 由调用方提供。 */
    commandContext(ask: () => void): CommandContext {
      return {
        messages,
        timestamps,
        registry,
        builder,
        tracker,
        sessionStore,
        model,
        makePromptCtx,
        prepareContext,
        saveSession,
        ask,
        memoryStore,
        vectorStore,
        busy,
        onEvent: emit,
        limits,
      }
    },

    async dispose(): Promise<void> {
      await registry.closeAllMCP()
      await pluginManager.unloadAll()
      await gateway.stopAll()
    },
  }
}

export type Vela = ReturnType<typeof createVela>
