/**
 * Public entry point of the Vela SDK (`import { createVela } from '@glows777/vela'`).
 * Export only from here; the CLI lives in src/cli/main.ts and test helpers in 'vela/testing'.
 * test/unit/public-api.test.ts snapshots the public surface: update the snapshot when changing this file.
 */

export type {
  AssistantMessageEvent,
  CompactionReason,
  CompactionResult,
  CustomMessageInfo,
  StopReason,
  VelaEvent,
  VelaEventListener,
  VelaSessionEventListener,
} from './agent/events.ts'
export type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from './channels/types.ts'
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
export { type FeishuOptions, feishu } from './extensions/feishu/index.ts'
export { memory } from './extensions/memory/index.ts'
export { createEmbedder, type EmbeddingFn } from './extensions/rag/embedder.ts'
export { type RagOptions, rag } from './extensions/rag/index.ts'
export type { LoadedExtension } from './extensions/runner.ts'
export type {
  AfterProviderResponseEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BeforeProviderRequestEvent,
  ContextEvent,
  ContextEventResult,
  CustomMessage,
  ExtensionAPI,
  ExtensionCommand,
  ExtensionContext,
  ExtensionEventName,
  ExtensionEvents,
  ExtensionHandler,
  ExtensionUI,
  InputEvent,
  InputEventResult,
  InputSource,
  ProviderStreamEvent,
  SendMessageOptions,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionUI,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
  VelaExtension,
} from './extensions/types.ts'
export { type WebOptions, web } from './extensions/web/index.ts'
export type { VelaLimits } from './limits.ts'
export { silentLogger, type VelaLogger } from './logger.ts'
export type {
  ModelInfo,
  ModelSpec,
  ProviderDefinition,
  ThinkingLevel,
} from './models/index.ts'
export {
  type ContextFile,
  loadContextFiles,
} from './prompt/context-files.ts'
export type {
  PermissionDecision,
  PermissionRules,
  Role,
} from './security/roles.ts'
export {
  type CompactionEntry,
  type ContextEditEntry,
  type CustomEntry,
  type CustomMessageEntry,
  type ModelChangeEntry,
  migrateSessionV1,
  type NestedToolCallRecord,
  type NestedToolCalls,
  SESSION_FORMAT_VERSION,
  type SessionEntry,
  type SessionEntryBase,
  type SessionFileEntry,
  type SessionHeader,
  type SessionInfoEntry,
  type SessionMessageEntry,
  type SessionSummary,
  summarizeSession,
  type ThinkingLevelChangeEntry,
} from './session/entries.ts'
export {
  fileSessionStorage,
  memorySessionStorage,
  type SessionStorage,
} from './session/storage.ts'
export { withFileMutationQueue } from './tools/file-mutation-queue.ts'
export type {
  ExecuteToolOptions,
  ToolAnnotations,
  ToolCallOutcome,
  ToolContext,
  ToolDefinition,
  ToolExecutionMode,
  ToolExposure,
  ToolNamespace,
} from './tools/registry.ts'
export type { ModelPricing, TokenStatus, UsageTotals } from './usage/tracker.ts'
export { createVela, type Vela, type VelaOptions } from './vela.ts'
export {
  type PromptOptions,
  type QueueMode,
  type SessionOptions,
  VelaSession,
} from './vela-session.ts'
