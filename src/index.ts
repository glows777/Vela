/**
 * Vela SDK 的公开入口（`import { createVela } from 'vela'`）。
 * 只从这里 export；CLI 在 src/cli/main.ts，测试工具在 'vela/testing'。
 * 公开面的取舍和快照测试在第 1b 步（扩展 API）一起定。
 */

export type {
  VelaEvent,
  VelaEventListener,
  VelaSessionEventListener,
} from './agent/events'
export { ChannelGateway, channelSessionId } from './channels/gateway'
export type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from './channels/types'
export { DEFAULT_LIMITS, resolveLimits, type VelaLimits } from './limits'
export { silentLogger, type VelaLogger } from './logger'
export type { PluginApi, PluginConfig, PluginDefinition } from './plugins/types'
export type { PromptContext } from './prompt/pipelins'
export { createEmbedder, type EmbeddingFn } from './rag/embedder'
export type { HookContext, HookResult } from './security/hooks'
export type { Role } from './security/roles'
export {
  type ToolDefinition,
  ToolExecutionResult,
  type ToolRegistry,
} from './tools/registry'
export type { TokenStatus, UsageTotals } from './usage/tracker'
export {
  createVela,
  type SessionOptions,
  type Vela,
  type VelaOptions,
} from './vela'
export {
  type PromptOptions,
  toSessionId,
  VelaSession,
} from './vela-session'
