import type { VelaEvent } from '../agent/events'
import type { ChannelDefinition } from '../channels/types'
import type { VelaLogger } from '../logger'
import type { ProviderDefinition } from '../models'
import type { ToolDefinition } from '../tools/registry'
import type { VelaSession } from '../vela-session'

/**
 * 一个扩展：拿到 ExtensionAPI，注册工具、命令、通道和事件 handler（仿 pi 的 `(pi) => {}`）。
 * 和 pi 不同：每个 Vela 只运行一次，注册的东西由所有并发会话共享；
 * handler 通过 `ctx.session` 知道是哪个会话触发的。
 * 工厂里只做注册，不要起进程 / socket / 定时器：长期资源放到 `session_start` 或通道的 start() 里。
 */
export type VelaExtension = (vela: ExtensionAPI) => void | Promise<void>

/** 扩展和用户交互。没有界面时（SDK、`-p`、通道会话）notify 变成 `notify` 事件，confirm 返回 false，select / input 返回 undefined。 */
export interface ExtensionUI {
  notify(message: string, level?: 'info' | 'warning' | 'error'): void
  confirm(title: string, message: string): Promise<boolean>
  select(title: string, options: string[]): Promise<string | undefined>
  input(title: string, placeholder?: string): Promise<string | undefined>
}

/** handler 的第二个参数：触发事件的会话和它的界面。 */
export interface ExtensionContext {
  session: VelaSession
  ui: ExtensionUI
  /** 是否有能真正弹出 confirm / select 的界面 */
  hasUI: boolean
  cwd: string
  /** 会话正在跑时的中断信号；空闲时为 undefined */
  signal: AbortSignal | undefined
}

export interface ExtensionCommand {
  description?: string
  /** args 是命令名后面的文本（已去掉首尾空白） */
  handler: (args: string, ctx: ExtensionContext) => void | Promise<void>
}

/** 工具执行前。handler 可以原地改 `input`，或返回 `{ block: true, reason }` 拦截；handler 抛错也按拦截处理。 */
export interface ToolCallEvent {
  type: 'tool_call'
  toolCallId: string | undefined
  toolName: string
  input: Record<string, unknown>
}

export interface ToolCallEventResult {
  block?: boolean
  reason?: string
}

/** 工具执行后、结果交给模型前。返回 `{ output }` 替换模型看到的文本；多个 handler 依次叠加。 */
export interface ToolResultEvent {
  type: 'tool_result'
  toolCallId: string | undefined
  toolName: string
  input: unknown
  /** 模型将看到的文本（超长结果是预览） */
  output: string
}

export interface ToolResultEventResult {
  output?: string
}

/**
 * 每次 prompt() 开始、发第一次模型请求前。handler 往 `sections` 里写 system prompt 段落
 * （键是段落名），这一轮里不再变化。
 */
export interface BeforeAgentStartEvent {
  type: 'before_agent_start'
  prompt: string
  sections: Record<string, string>
}

/** 会话第一次 prompt() 之前（恢复历史之后）。 */
export interface SessionStartEvent {
  type: 'session_start'
}

/** 会话关闭（session.close() 或 vela.dispose()）。 */
export interface SessionShutdownEvent {
  type: 'session_shutdown'
}

type InterceptEvents = {
  tool_call: [ToolCallEvent, ToolCallEventResult]
  tool_result: [ToolResultEvent, ToolResultEventResult]
  before_agent_start: [BeforeAgentStartEvent, void]
  session_start: [SessionStartEvent, void]
  session_shutdown: [SessionShutdownEvent, void]
}

/** 只读通知：所有 VelaEvent（tool_call / tool_result 用上面能改东西的版本）。 */
type NotifyEvents = {
  [K in Exclude<VelaEvent['type'], keyof InterceptEvents>]: [
    Extract<VelaEvent, { type: K }>,
    void,
  ]
}

export type ExtensionEvents = InterceptEvents & NotifyEvents
export type ExtensionEventName = keyof ExtensionEvents

export type ExtensionHandler<K extends ExtensionEventName> = (
  event: ExtensionEvents[K][0],
  ctx: ExtensionContext,
) =>
  | ExtensionEvents[K][1]
  | undefined
  | Promise<ExtensionEvents[K][1] | undefined>

export interface ExtensionAPI {
  /** 工具的工作目录 */
  readonly cwd: string
  /** Vela 的数据目录；扩展自己的数据放在 `<dataDir>/<扩展名>/` */
  readonly dataDir: string
  /**
   * 这个扩展的配置段：`createVela({ extensionConfig })` 里按扩展名取（CLI 来自 settings.json 的
   * `extensionConfig.<扩展名>`，字符串已做 `$VAR` 插值）。没有配置时是 `{}`。
   */
  readonly config: Readonly<Record<string, unknown>>
  readonly logger: VelaLogger
  /**
   * 注册一个所有会话共享的工具。模型看到的名字是 `<扩展名>_<name>`（例如 supabase 扩展的
   * `query` 是 `supabase_query`），不会和内置工具重名；重名会抛错。工具名和扩展名相同时不重复前缀
   * （memory 扩展的 `memory` 工具就叫 `memory`）。
   */
  registerTool(tool: ToolDefinition): void
  /**
   * 注册一个模型 provider（同 pi 的 registerProvider，只支持“给出 AI SDK 模型”这一种形式）：
   * 之后 `provider/id` 可以用在 createVela 的 model、`session.setModel()`、CLI 的 `--model` / `/model`。
   * provider 名不加扩展名前缀；和已有的重名会抛错。
   */
  registerProvider(name: string, provider: ProviderDefinition): void
  /** 注册 `/name` 命令：owner 会话里 `session.prompt('/name args')` 会执行它而不是发给模型。 */
  registerCommand(name: string, command: ExtensionCommand): void
  /** 注册一个消息通道（Vela 特有）：每个发送者一个会话，默认 guest 角色。 */
  registerChannel(channel: ChannelDefinition): void
  /** 订阅事件，按扩展加载和注册顺序执行；返回取消订阅的函数。 */
  on<K extends ExtensionEventName>(
    event: K,
    handler: ExtensionHandler<K>,
  ): () => void
}
