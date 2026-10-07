import { join, resolve } from 'node:path'
import type { LanguageModel } from 'ai'
import type { VelaSessionEventListener } from './agent/events'
import { ChannelGateway } from './channels/gateway'
import { ExtensionRunner, type LoadedExtension } from './extensions/runner'
import type { VelaExtension } from './extensions/types'
import { resolveLimits, type VelaLimits } from './limits'
import { silentLogger, type VelaLogger } from './logger'
import { MemoryStore } from './memory/store'
import {
  coreRules,
  deferredTools,
  extensionSections,
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
import { type SessionOptions, VelaSession } from './vela-session'

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
  /** 非事件类的诊断输出（扩展、hooks、会话文件坏行……），默认静默。 */
  logger?: VelaLogger
  /**
   * 要加载的扩展，按顺序运行（同 pi，SDK 默认不带内置扩展）。
   * 扩展的配置通过工厂参数传入，例如 `feishu({ appId, appSecret })`。
   */
  extensions?: VelaExtension[]
}

/** createVela() 的返回值。 */
export interface Vela {
  readonly cwd: string
  readonly dataDir: string
  readonly model: LanguageModel
  readonly limits: VelaLimits
  /**
   * 打开（或取回已打开的）会话；id 会成为 `.sessions/<id>.jsonl` 的文件名。
   * options 只在第一次打开时生效。需要恢复历史时再 `await session.resume()`。
   */
  session(id?: string, options?: SessionOptions): VelaSession
  /** 当前打开的会话 */
  sessions(): VelaSession[]
  /** 订阅所有会话的事件；返回取消订阅的函数 */
  subscribe(listener: VelaSessionEventListener): () => void
  /** 等所有扩展（包括异步工厂）加载完；加载失败时 reject */
  ready(): Promise<void>
  /** 已加载的扩展和它们注册的工具、命令、通道 */
  extensions(): LoadedExtension[]
  /** 扩展注册的命令 */
  commands(): { name: string; description?: string; extension: string }[]
  /** 扩展注册的通道 */
  channels(): { name: string; description: string }[]
  /** 启动所有通道（开始接收消息） */
  startChannels(): Promise<void>
  /** 停止通道、关闭所有会话（中断正在跑的任务并保存）、断开 MCP */
  dispose(): Promise<void>
}

/** CLI 和测试用的内部对象，不属于公开 API。 */
export interface VelaInternals {
  logger: VelaLogger
  registry: ToolRegistry
  hooks: HookPipeline
  builder: PromptPipeline
  memoryStore: MemoryStore
  vectorStore: SqliteVectorStore
  skillLoader: SkillLoader
  gateway: ChannelGateway
}

const internals = new WeakMap<Vela, VelaInternals>()

/** @internal 取 Vela 的内部对象（CLI 命令、测试用）。 */
export function velaInternals(vela: Vela): VelaInternals {
  const found = internals.get(vela)
  if (!found) throw new Error('不是 createVela() 创建的 Vela')
  return found
}

/**
 * 装配一个 Vela：工具、hooks、prompt、记忆、RAG、skills、扩展和通道。
 * 对话通过 `vela.session(id)` 打开；同一个 Vela 可以同时开多个会话，
 * 它们共享工具、扩展、记忆和知识库，各自有消息历史、上下文压缩、用量、角色和运行锁。
 */
export function createVela(options: VelaOptions): Vela {
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
    .pipe('extensions', extensionSections())
    .pipe('skillContext', (ctx) =>
      skillLoader.buildPromptSection(ctx.activeSkills ?? new Set()),
    )
    .pipe('sessionContext', sessionContext())

  const listeners = new Set<VelaSessionEventListener>()
  const sessions = new Map<string, VelaSession>()
  let disposed = false

  const session = (
    id = 'default',
    sessionOptions?: SessionOptions,
  ): VelaSession => {
    if (disposed) throw new Error('Vela 已 dispose')
    const existing = sessions.get(id)
    if (existing) return existing
    const created: VelaSession = new VelaSession(
      id,
      {
        model,
        limits,
        logger,
        dataDir,
        registry,
        builder,
        extensions: {
          ready: runner.ready,
          sessionStart: (s) => runner.sessionStart(s),
          sessionShutdown: (s) => runner.sessionShutdown(s),
          beforeAgentStart: (s, prompt) => runner.beforeAgentStart(s, prompt),
          runCommand: (s, text) => runner.runCommand(s, text),
        },
        forward: (event, sessionId) => {
          for (const listener of listeners) listener(event, sessionId)
          const source = sessions.get(sessionId)
          if (source) runner.notify(event, source)
        },
        onClose: (closed) => {
          if (sessions.get(closed.id) === closed) sessions.delete(closed.id)
        },
      },
      sessionOptions,
    )
    sessions.set(id, created)
    return created
  }

  const gateway: ChannelGateway = new ChannelGateway({ session, logger })
  const runner: ExtensionRunner = new ExtensionRunner(
    {
      cwd,
      dataDir,
      logger,
      registry,
      hooks,
      gateway,
      session: (id) => sessions.get(id),
    },
    options.extensions ?? [],
  )

  const vela: Vela = {
    cwd,
    dataDir,
    model,
    limits,
    session,
    sessions: () => [...sessions.values()],
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ready: () => runner.ready,
    extensions: () => runner.loaded(),
    commands: () => runner.commands(),
    channels: () => gateway.list(),
    startChannels: () => gateway.startAll(),
    async dispose() {
      if (disposed) return
      disposed = true
      await gateway.stopAll()
      await Promise.all([...sessions.values()].map((s) => s.close()))
      await registry.closeAllMCP()
      listeners.clear()
    },
  }
  internals.set(vela, {
    logger,
    registry,
    hooks,
    builder,
    memoryStore,
    vectorStore,
    skillLoader,
    gateway,
  })
  return vela
}
