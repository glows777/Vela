/**
 * Vela SDK 的公开入口（`import { createVela } from 'vela'`）。
 * 只从这里 export；CLI 在 src/cli/main.ts，测试工具在 'vela/testing'。
 * 公开面由 test/unit/public-api.test.ts 的快照守着：改这里要同时更新快照。
 */

export type {
  VelaEvent,
  VelaEventListener,
  VelaSessionEventListener,
} from './agent/events'
export type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from './channels/types'
export { type FeishuOptions, feishu } from './extensions/feishu'
export type { LoadedExtension } from './extensions/runner'
export { type SupabaseOptions, supabase } from './extensions/supabase'
export type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommand,
  ExtensionContext,
  ExtensionEventName,
  ExtensionEvents,
  ExtensionHandler,
  ExtensionUI,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
  VelaExtension,
} from './extensions/types'
export type { VelaLimits } from './limits'
export { silentLogger, type VelaLogger } from './logger'
export { createEmbedder, type EmbeddingFn } from './rag/embedder'
export type {
  PermissionDecision,
  PermissionRules,
  Role,
} from './security/roles'
export type { ToolDefinition } from './tools/registry'
export type { TokenStatus, UsageTotals } from './usage/tracker'
export { createVela, type Vela, type VelaOptions } from './vela'
export {
  type PromptOptions,
  type SessionOptions,
  VelaSession,
} from './vela-session'
