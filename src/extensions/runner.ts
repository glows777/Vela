import type { VelaEvent } from '../agent/events'
import type { ChannelGateway } from '../channels/gateway'
import { errorMessage, type VelaLogger } from '../logger'
import type { HookPipeline } from '../security/hooks'
import type { ToolRegistry } from '../tools/registry'
import type { VelaSession } from '../vela-session'
import type {
  ExtensionAPI,
  ExtensionCommand,
  ExtensionContext,
  ExtensionEventName,
  ExtensionHandler,
  ToolCallEventResult,
  ToolResultEventResult,
  VelaExtension,
} from './types'

interface RunnerDeps {
  cwd: string
  dataDir: string
  logger: VelaLogger
  registry: ToolRegistry
  hooks: HookPipeline
  gateway: ChannelGateway
  /** 按 id 取已打开的会话（hooks 只知道会话 id） */
  session: (id: string) => VelaSession | undefined
}

export interface LoadedExtension {
  name: string
  tools: string[]
  commands: string[]
  channels: string[]
}

type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown

const COMMAND_NAME = /^[A-Za-z0-9][\w-]*$/

/**
 * 扩展运行时：运行扩展工厂，保存它们注册的 handler 和命令，在对应时机按注册顺序调用。
 * 工具调用的拦截挂在 HookPipeline 上（和 audit 等内部 hook 同一条链）。
 */
export class ExtensionRunner {
  private readonly handlers = new Map<
    ExtensionEventName,
    { extension: string; fn: AnyHandler }[]
  >()
  private readonly commandMap = new Map<
    string,
    { extension: string; command: ExtensionCommand }
  >()
  private readonly loadedList: LoadedExtension[] = []
  /** 所有扩展工厂（包括异步的）跑完；失败时 reject */
  readonly ready: Promise<void>

  constructor(
    private readonly deps: RunnerDeps,
    extensions: readonly VelaExtension[],
  ) {
    deps.hooks.registerPre('extensions', async (toolName, input, context) => {
      const session = context.sessionId
        ? deps.session(context.sessionId)
        : undefined
      if (!session) return { action: 'allow' }
      const result = await this.toolCall(
        session,
        context.toolCallId,
        toolName,
        input,
      )
      if (result.block)
        return { action: 'block', reason: result.reason ?? '被扩展拦截' }
      return result.input === input
        ? { action: 'allow' }
        : { action: 'modify', modifiedInput: result.input }
    })
    deps.hooks.registerPost(
      'extensions',
      async (toolName, input, output, context) => {
        const session = context.sessionId
          ? deps.session(context.sessionId)
          : undefined
        if (!session) return { action: 'allow' }
        const text = await this.toolResult(
          session,
          context.toolCallId,
          toolName,
          input,
          String(output),
        )
        return text === output
          ? { action: 'allow' }
          : { action: 'modify', modifiedOutput: text }
      },
    )

    const pending: Promise<void>[] = []
    extensions.forEach((extension, index) => {
      const name = extension.name || `extension-${index + 1}`
      const result = extension(this.api(name))
      if (result instanceof Promise)
        pending.push(
          result.catch((error) => {
            throw new Error(`扩展 ${name} 加载失败: ${errorMessage(error)}`)
          }),
        )
    })
    this.ready = Promise.all(pending).then(() => {})
    // 没人 await 时也不要变成未处理的 rejection；prompt() 会 await 它并报错
    this.ready.catch(() => {})
  }

  private api(name: string): ExtensionAPI {
    const loaded: LoadedExtension = {
      name,
      tools: [],
      commands: [],
      channels: [],
    }
    this.loadedList.push(loaded)
    const { deps } = this
    const prefix = name.replace(/[^A-Za-z0-9_-]/g, '_')
    return {
      cwd: deps.cwd,
      dataDir: deps.dataDir,
      logger: deps.logger,
      registerTool: (tool) => {
        // 工具名加上扩展名前缀，避免和内置工具或其它扩展的工具重名
        const toolName = `${prefix}_${tool.name}`
        deps.registry.register({ ...tool, name: toolName })
        loaded.tools.push(toolName)
      },
      registerCommand: (commandName, command) => {
        if (!COMMAND_NAME.test(commandName))
          throw new Error(`无效的命令名 "${commandName}"`)
        const existing = this.commandMap.get(commandName)
        if (existing)
          throw new Error(
            `命令 /${commandName} 已由扩展 ${existing.extension} 注册`,
          )
        this.commandMap.set(commandName, { extension: name, command })
        loaded.commands.push(commandName)
      },
      registerChannel: (channel) => {
        deps.gateway.register(channel)
        loaded.channels.push(channel.name)
      },
      on: <K extends ExtensionEventName>(
        event: K,
        handler: ExtensionHandler<K>,
      ) => {
        const list = this.handlers.get(event) ?? []
        const entry = { extension: name, fn: handler as AnyHandler }
        list.push(entry)
        this.handlers.set(event, list)
        return () => {
          const index = list.indexOf(entry)
          if (index !== -1) list.splice(index, 1)
        }
      },
    }
  }

  /** 已加载的扩展和它们注册的东西 */
  loaded(): LoadedExtension[] {
    return this.loadedList.map((e) => ({
      ...e,
      tools: [...e.tools],
      commands: [...e.commands],
      channels: [...e.channels],
    }))
  }

  commands(): { name: string; description?: string; extension: string }[] {
    return [...this.commandMap].map(([name, { extension, command }]) => ({
      name,
      description: command.description,
      extension,
    }))
  }

  context(session: VelaSession): ExtensionContext {
    return {
      session,
      ui: session.ui,
      hasUI: session.hasUI,
      cwd: this.deps.cwd,
      signal: session.signal,
    }
  }

  /** 依次调用 handler；每份副本（handler 列表在调用前复制，调用中取消订阅不影响这一次） */
  private list(event: ExtensionEventName) {
    return [...(this.handlers.get(event) ?? [])]
  }

  private report(extension: string, event: string, error: unknown) {
    this.deps.logger.error(
      `[extension:${extension}] ${event} handler 出错: ${errorMessage(error)}`,
    )
  }

  /** 只读通知：不等待 handler，错误写日志。tool_call / tool_result 由拦截版本处理。 */
  notify(event: VelaEvent, session: VelaSession): void {
    if (event.type === 'tool_call' || event.type === 'tool_result') return
    const handlers = this.list(event.type)
    if (!handlers.length) return
    const ctx = this.context(session)
    for (const { extension, fn } of handlers) {
      try {
        const result = fn(event, ctx)
        if (result instanceof Promise)
          result.catch((error) => this.report(extension, event.type, error))
      } catch (error) {
        this.report(extension, event.type, error)
      }
    }
  }

  /** 生命周期事件：按顺序等待每个 handler，错误写日志后继续。 */
  private async lifecycle(
    event: { type: 'session_start' | 'session_shutdown' },
    session: VelaSession,
  ) {
    const ctx = this.context(session)
    for (const { extension, fn } of this.list(event.type)) {
      try {
        await fn(event, ctx)
      } catch (error) {
        this.report(extension, event.type, error)
      }
    }
  }

  sessionStart(session: VelaSession) {
    return this.lifecycle({ type: 'session_start' }, session)
  }

  sessionShutdown(session: VelaSession) {
    return this.lifecycle({ type: 'session_shutdown' }, session)
  }

  /** before_agent_start：收集这一轮的 system prompt 段落。 */
  async beforeAgentStart(
    session: VelaSession,
    prompt: string,
  ): Promise<Record<string, string>> {
    const event = { type: 'before_agent_start' as const, prompt, sections: {} }
    const ctx = this.context(session)
    for (const { extension, fn } of this.list('before_agent_start')) {
      try {
        await fn(event, ctx)
      } catch (error) {
        this.report(extension, event.type, error)
      }
    }
    return event.sections
  }

  /**
   * tool_call：handler 原地改 input 或返回 `{ block }`。handler 抛错按拦截处理（同 pi，宁可不执行）。
   * 返回的 input 和传入的是同一个对象时表示没有改动。
   */
  private async toolCall(
    session: VelaSession,
    toolCallId: string | undefined,
    toolName: string,
    input: unknown,
  ): Promise<ToolCallEventResult & { input: unknown }> {
    const handlers = this.list('tool_call')
    if (!handlers.length) return { input }
    const before = JSON.stringify(input)
    const event = {
      type: 'tool_call' as const,
      toolCallId,
      toolName,
      input: structuredClone(input) as Record<string, unknown>,
    }
    const ctx = this.context(session)
    for (const { extension, fn } of handlers) {
      try {
        const result = (await fn(event, ctx)) as ToolCallEventResult | undefined
        if (result?.block) return { block: true, reason: result.reason, input }
      } catch (error) {
        this.report(extension, event.type, error)
        return {
          block: true,
          reason: `扩展 ${extension} 检查出错: ${errorMessage(error)}`,
          input,
        }
      }
    }
    return {
      input: JSON.stringify(event.input) === before ? input : event.input,
    }
  }

  /** tool_result：handler 返回 `{ output }` 替换模型看到的文本，依次叠加；出错时保留上一个结果。 */
  private async toolResult(
    session: VelaSession,
    toolCallId: string | undefined,
    toolName: string,
    input: unknown,
    output: string,
  ): Promise<string> {
    const event = {
      type: 'tool_result' as const,
      toolCallId,
      toolName,
      input,
      output,
    }
    const ctx = this.context(session)
    for (const { extension, fn } of this.list('tool_result')) {
      try {
        const result = (await fn(event, ctx)) as
          | ToolResultEventResult
          | undefined
        if (typeof result?.output === 'string') event.output = result.output
      } catch (error) {
        this.report(extension, event.type, error)
      }
    }
    return event.output
  }

  /**
   * `/name args` 是扩展命令时执行它并返回 true；不是命令时返回 false（当普通输入发给模型）。
   * 只有 owner 会话能执行命令：通道发送者发来的 `/xxx` 只是普通文本。
   */
  async runCommand(session: VelaSession, text: string): Promise<boolean> {
    const match = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/)
    if (!match) return false
    await this.ready
    const entry = this.commandMap.get(match[1] ?? '')
    if (!entry || session.role !== 'owner') return false
    await entry.command.handler((match[2] ?? '').trim(), this.context(session))
    return true
  }
}
