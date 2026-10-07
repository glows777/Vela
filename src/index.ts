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
export {
  type ExtensionEntry,
  importExtension,
  type LoadConfigOptions,
  loadConfig,
  loadModels,
  type ProviderApi,
  type ProviderConfig,
  type VelaConfig,
  type VelaSettings,
} from './config'
export type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from './channels/types'
export { type FeishuOptions, feishu } from './extensions/feishu'
export { memory } from './extensions/memory'
export { type RagOptions, rag } from './extensions/rag'
export { createEmbedder, type EmbeddingFn } from './extensions/rag/embedder'
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
  SessionUI,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
  VelaExtension,
} from './extensions/types'
export { type WebOptions, web } from './extensions/web'
export type { VelaLimits } from './limits'
export type {
  ModelInfo,
  ModelSpec,
  ProviderDefinition,
  ThinkingLevel,
} from './models'
export { silentLogger, type VelaLogger } from './logger'
export type {
  PermissionDecision,
  PermissionRules,
  Role,
} from './security/roles'
export {
  fileSessionStorage,
  memorySessionStorage,
  type SessionCheckpoint,
  type SessionStorage,
  type SessionSummary,
} from './session/storage'
export type { ToolContext, ToolDefinition } from './tools/registry'
export type { ModelPricing, TokenStatus, UsageTotals } from './usage/tracker'
export { createVela, type Vela, type VelaOptions } from './vela'
export {
  type PromptOptions,
  type QueueMode,
  type SessionOptions,
  VelaSession,
} from './vela-session'
