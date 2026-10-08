/**
 * Public entry point of the Vela SDK (`import { createVela } from '@glows777/vela'`).
 * Export only from here; the CLI lives in src/cli/main.ts and test helpers in 'vela/testing'.
 * test/unit/public-api.test.ts snapshots the public surface: update the snapshot when changing this file.
 */

export type {
  VelaEvent,
  VelaEventListener,
  VelaSessionEventListener,
} from './agent/events.ts'
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
} from './config/index.ts'
export type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from './channels/types.ts'
export { type FeishuOptions, feishu } from './extensions/feishu/index.ts'
export { memory } from './extensions/memory/index.ts'
export { type RagOptions, rag } from './extensions/rag/index.ts'
export { createEmbedder, type EmbeddingFn } from './extensions/rag/embedder.ts'
export type { LoadedExtension } from './extensions/runner.ts'
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
} from './extensions/types.ts'
export { type WebOptions, web } from './extensions/web/index.ts'
export type { VelaLimits } from './limits.ts'
export type {
  ModelInfo,
  ModelSpec,
  ProviderDefinition,
  ThinkingLevel,
} from './models/index.ts'
export { silentLogger, type VelaLogger } from './logger.ts'
export type {
  PermissionDecision,
  PermissionRules,
  Role,
} from './security/roles.ts'
export {
  fileSessionStorage,
  memorySessionStorage,
  type SessionCheckpoint,
  type SessionStorage,
  type SessionSummary,
} from './session/storage.ts'
export type { ToolContext, ToolDefinition } from './tools/registry.ts'
export type { ModelPricing, TokenStatus, UsageTotals } from './usage/tracker.ts'
export { createVela, type Vela, type VelaOptions } from './vela.ts'
export {
  type PromptOptions,
  type QueueMode,
  type SessionOptions,
  VelaSession,
} from './vela-session.ts'
