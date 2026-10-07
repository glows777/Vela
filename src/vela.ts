import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { LanguageModel } from 'ai'
import type { VelaSessionEventListener } from './agent/events'
import { ChannelGateway } from './channels/gateway'
import { ExtensionRunner, type LoadedExtension } from './extensions/runner'
import type { VelaExtension } from './extensions/types'
import { resolveLimits, type VelaLimits } from './limits'
import { silentLogger, type VelaLogger } from './logger'
import {
  coreRules,
  deferredTools,
  extensionSections,
  sessionContext,
  toolGuide,
  toolHistoryGuide,
} from './prompt'
import { PromptPipeline } from './prompt/pipelins'
import { HookPipeline } from './security/hooks'
import {
  fileSessionStorage,
  memorySessionStorage,
  type SessionStorage,
} from './session/storage'
import { ToolResultStore } from './session/tool-results'
import { SkillLoader } from './skills/loader'
import { createCoreTools } from './tools'
import { ToolRegistry } from './tools/registry'
import {
  DEFAULT_THINKING_LEVEL,
  describeModel,
  type ModelInfo,
  ModelRegistry,
  type ProviderDefinition,
  type ResolvedModel,
  type ThinkingLevel,
} from './models'
import { registerToolSearchTool } from './tools/tool-search'
import { type SessionOptions, VelaSession } from './vela-session'

export interface VelaOptions {
  /**
   * 默认模型：AI SDK 的 LanguageModel（测试传 faux），或 `provider/id`（在 `providers` 和扩展注册的
   * provider 里找）。core 不读环境变量：CLI 用 loadConfig() 的 providers。
   * 不给时会话要先 setModel()（或恢复一个保存了模型的会话）才能 prompt。
   */
  model?: LanguageModel | string
  /** 模型 provider（loadConfig() 给的内置 openai / anthropic + models.json，或自己写的） */
  providers?: Record<string, ProviderDefinition>
  /** 新会话的 thinking 级别，默认 medium（同 pi） */
  thinkingLevel?: ThinkingLevel
  /** 文件、搜索、bash 工具和 skill 的工作目录，默认 process.cwd()。 */
  cwd?: string
  /**
   * 项目数据目录（sessions/、usage/、扩展数据如 memory/、rag/），相对路径按 cwd 解析。
   * 不给时什么都不持久化：会话在内存里，工具长输出等写到临时目录，dispose() 时删掉。
   * CLI 用 `~/.vela/projects/<编码后的 cwd>`（见 loadConfig）。
   */
  dataDir?: string
  /** 会话历史存哪；默认有 dataDir 时是 `<dataDir>/sessions/*.jsonl`，否则在内存里 */
  sessionStorage?: SessionStorage
  /** skill 目录（每个子目录一个 `SKILL.md`），后面的同名 skill 覆盖前面的；默认 `<cwd>/.skills`、`<cwd>/.vela/skills` */
  skillDirs?: string[]
  /** 每个扩展的配置段，扩展通过 `vela.config` 读到自己那一段（按扩展名） */
  extensionConfig?: Record<string, Record<string, unknown>>
  /** 轮数、重试、预算、压缩阈值等上限；未给出的字段用默认值（见 src/limits.ts）。 */
  limits?: Partial<VelaLimits>
  /** 非事件类的诊断输出（扩展、hooks、会话文件坏行……），默认静默。 */
  logger?: VelaLogger
  /**
   * 要加载的扩展，按顺序运行（同 pi，SDK 默认不带内置扩展）。
   * 记忆、知识库、网页工具也是扩展：`[memory(), rag({ embedder }), web({ tavilyKey })]`。
   * 扩展的配置通过工厂参数传入，例如 `feishu({ appId, appSecret })`。
   */
  extensions?: VelaExtension[]
}

/** createVela() 的返回值。 */
export interface Vela {
  readonly cwd: string
  readonly dataDir: string
  /** 默认模型（按名字给的在第一次访问时解析；没给或解析不了时抛错） */
  readonly model: LanguageModel
  readonly limits: VelaLimits
  /** provider 列出的模型（`provider/id`、上下文窗口、价格…），`/model` 用 */
  models(): ModelInfo[]
  /**
   * 打开（或取回已打开的）会话；文件存储时 id 是 `sessions/<id>.jsonl` 的文件名。
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
 * 装配一个 Vela：核心工具（文件、搜索、bash）、hooks、prompt、skills、扩展和通道。
 * 对话通过 `vela.session(id)` 打开；同一个 Vela 可以同时开多个会话，
 * 它们共享工具和扩展，各自有消息历史、上下文压缩、用量、角色和运行锁。
 */
export function createVela(options: VelaOptions = {}): Vela {
  const cwd = resolve(options.cwd ?? process.cwd())
  // 没给 dataDir 时用临时目录（工具长输出、工具历史、扩展数据），dispose 时删掉
  const ephemeral = options.dataDir === undefined
  const dataDir = ephemeral
    ? mkdtempSync(join(tmpdir(), 'vela-'))
    : resolve(cwd, options.dataDir as string)
  const sessionStorage =
    options.sessionStorage ??
    (ephemeral
      ? memorySessionStorage()
      : fileSessionStorage(join(dataDir, 'sessions'), options.logger))
  const { model } = options
  const models = new ModelRegistry(options.providers)
  const resolveModel = (
    choice: string | LanguageModel | undefined,
  ): ResolvedModel => {
    if (choice === undefined)
      throw new Error('没有选模型：给 createVela() 传 model，或调用 session.setModel()')
    return typeof choice === 'string'
      ? models.resolve(choice)
      : { model: choice, info: describeModel(choice) }
  }
  const limits = resolveLimits(options.limits)
  const logger = options.logger ?? silentLogger

  // Vela 级 registry 只持有共享的工具定义；真正执行工具的是每个会话 fork 出来的 registry。
  // 它自己的结果目录以 . 开头，不会和任何会话 id 冲突。
  const registry = new ToolRegistry(
    new ToolResultStore(join(dataDir, 'sessions', '.shared', 'tool-results')),
  )
  registry.setLogger(logger)
  registry.register(
    ...createCoreTools({ cwd, bashTimeoutMs: limits.bashTimeoutMs }),
  )

  const hooks = new HookPipeline(logger)
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

  const skillLoader = new SkillLoader(
    options.skillDirs ?? [join(cwd, '.skills'), join(cwd, '.vela', 'skills')],
  )
  skillLoader.load()

  const builder = new PromptPipeline()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('toolHistoryGuide', toolHistoryGuide())
    .pipe('deferredTools', deferredTools())
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
        resolveModel,
        thinkingLevel: options.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
        limitOverrides: options.limits ?? {},
        logger,
        dataDir,
        temporaryDataDir: ephemeral,
        sessionStorage,
        registry,
        builder,
        extensions: {
          ready: runner.ready,
          sessionStart: (s) => runner.sessionStart(s),
          sessionShutdown: (s) => runner.sessionShutdown(s),
          beforeAgentStart: (s, prompt) => runner.beforeAgentStart(s, prompt),
          runCommand: (s, text, signal) => runner.runCommand(s, text, signal),
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
      extensionConfig: options.extensionConfig ?? {},
      logger,
      registry,
      models,
      hooks,
      gateway,
      session: (id) => sessions.get(id),
    },
    options.extensions ?? [],
  )
  // 审计放在扩展的 tool_call 之后：记录的是扩展改过之后真正要写的路径
  hooks.registerPre('audit-log', (toolName, input, context) => {
    if (toolName === 'write_file' || toolName === 'edit_file') {
      const path = (input as { path?: string } | null)?.path || 'unknown'
      context.emit({ type: 'audit', toolName, path })
    }
    return { action: 'allow' }
  })

  let defaultModel: LanguageModel | undefined
  const vela: Vela = {
    cwd,
    dataDir,
    get model() {
      defaultModel ??= resolveModel(model).model
      return defaultModel
    },
    limits,
    models: () => models.list(),
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
      if (ephemeral) rmSync(dataDir, { recursive: true, force: true })
    },
  }
  internals.set(vela, {
    logger,
    registry,
    hooks,
    builder,
    skillLoader,
    gateway,
  })
  return vela
}
