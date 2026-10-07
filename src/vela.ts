import { join, resolve } from 'node:path'
import type { LanguageModel } from 'ai'
import type { VelaSessionEventListener } from './agent/events'
import { ChannelGateway } from './channels/gateway'
import { resolveLimits, type VelaLimits } from './limits'
import { silentLogger, type VelaLogger } from './logger'
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
import { PromptPipeline } from './prompt/pipelins'
import type { EmbeddingFn } from './rag/embedder'
import { SqliteVectorStore } from './rag/sqllite-store'
import { HookPipeline } from './security/hooks'
import { ToolResultStore } from './session/tool-results'
import { SkillLoader } from './skills/loader'
import { createCoreTools } from './tools'
import { createMemoryTool } from './tools/memory-tool'
import { createRagTools } from './tools/rag'
import { ToolRegistry } from './tools/registry'
import { registerToolSearchTool } from './tools/tool-search'
import { VelaSession } from './vela-session'

export interface VelaOptions {
  /** 主模型。core 不读环境变量：CLI 负责创建，测试传入 faux 模型。 */
  model: LanguageModel
  /** 文件、搜索、bash 工具和 skill 的工作目录，默认 process.cwd()。 */
  cwd?: string
  /** .sessions / .memory / .usage / knowledge.db 的根目录，默认等于 cwd。 */
  dataDir?: string
  /** embedding 函数；不传时不注册 RAG 工具，system prompt 也不包含知识库段落。 */
  embedder?: EmbeddingFn
  /** 轮数、重试、预算、压缩阈值等上限；未给出的字段用默认值（见 src/limits.ts）。 */
  limits?: Partial<VelaLimits>
  /** 非事件类的诊断输出（插件、hooks、会话文件坏行……），默认静默。 */
  logger?: VelaLogger
  /** 解析插件配置里 `${VAR}` 用的环境变量，默认为空；CLI 传 process.env。 */
  env?: Record<string, string | undefined>
}

/**
 * 装配一个 Vela：工具、hooks、prompt、记忆、RAG、skills、插件和通道。
 * 对话通过 `vela.session(id)` 打开；同一个 Vela 可以同时开多个会话，
 * 它们共享工具、记忆和知识库，各自有消息历史、上下文压缩、用量和运行锁。
 */
export function createVela(options: VelaOptions) {
  const cwd = resolve(options.cwd ?? process.cwd())
  const dataDir = resolve(cwd, options.dataDir ?? '.')
  const { model, embedder } = options
  const limits = resolveLimits(options.limits)
  const logger = options.logger ?? silentLogger

  // Vela 级 registry 只持有共享的工具定义；真正执行工具的是每个会话 fork 出来的 registry。
  // 它自己的结果目录以 . 开头，不会和任何会话 id 冲突。
  const registry = new ToolRegistry(
    new ToolResultStore(join(dataDir, '.sessions', '.shared', 'tool-results')),
  )
  registry.setLogger(logger)
  registry.register(
    ...createCoreTools({ cwd, bashTimeoutMs: limits.bashTimeoutMs }),
  )

  const hooks = new HookPipeline(logger)
  hooks.registerPre('audit-log', (toolName, input, context) => {
    if (toolName === 'write_file' || toolName === 'edit_file') {
      const path = (input as { path?: string } | null)?.path || 'unknown'
      context.emit({ type: 'audit', toolName, path })
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

  const memoryStore = new MemoryStore(dataDir, logger)
  memoryStore.init()
  registry.register(createMemoryTool(memoryStore))

  const vectorStore = new SqliteVectorStore(join(dataDir, 'knowledge.db'))
  if (embedder)
    registry.register(...createRagTools(vectorStore, embedder, { cwd }))

  const builder = new PromptPipeline()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('toolHistoryGuide', toolHistoryGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('memoryContext', memoryContext(memoryStore))
  if (embedder) builder.pipe('ragContext', ragContext(vectorStore))
  builder
    .pipe('skillContext', (ctx) =>
      skillLoader.buildPromptSection(ctx.activeSkills ?? new Set()),
    )
    .pipe('sessionContext', sessionContext())

  const listeners = new Set<VelaSessionEventListener>()
  const sessions = new Map<string, VelaSession>()
  let disposed = false

  /**
   * 打开（或取回已打开的）会话；id 会成为 `.sessions/<id>.jsonl` 的文件名。
   * 需要恢复历史时再 `await session.resume()`。
   */
  const session = (id = 'default'): VelaSession => {
    if (disposed) throw new Error('Vela 已 dispose')
    const existing = sessions.get(id)
    if (existing) return existing
    const created = new VelaSession(id, {
      model,
      limits,
      logger,
      dataDir,
      registry,
      builder,
      forward: (event, sessionId) => {
        for (const listener of listeners) listener(event, sessionId)
      },
      onClose: (closed) => {
        if (sessions.get(closed.id) === closed) sessions.delete(closed.id)
      },
    })
    sessions.set(id, created)
    return created
  }

  const gateway = new ChannelGateway({ session, logger })
  const pluginManager = new PluginManager(registry, gateway, {
    logger,
    env: options.env,
  })

  return {
    cwd,
    dataDir,
    model,
    limits,
    logger,
    /** 共享的工具 registry：在这里注册的工具所有会话都能用 */
    registry,
    hooks,
    builder,
    memoryStore,
    vectorStore,
    skillLoader,
    gateway,
    pluginManager,

    session,

    /** 当前打开的会话。 */
    sessions(): VelaSession[] {
      return [...sessions.values()]
    },

    /** 订阅所有会话的事件；返回取消订阅的函数。 */
    subscribe(listener: VelaSessionEventListener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /** 停止通道、关闭所有会话（中断正在跑的任务并保存）、卸载插件、断开 MCP。 */
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      await gateway.stopAll()
      await Promise.all([...sessions.values()].map((s) => s.close()))
      await pluginManager.unloadAll()
      await registry.closeAllMCP()
      listeners.clear()
    },
  }
}

export type Vela = ReturnType<typeof createVela>
