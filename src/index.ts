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
export {
  fileCredentialStore,
  memoryCredentialStore,
} from './auth/store.ts'
export type {
  ApiKeyCredential,
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Credential,
  CredentialStore,
  FetchFunction,
  LoginOptions,
  OAuthCredential,
  OAuthLogin,
} from './auth/types.ts'
export type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from './channels/types.ts'
export type {
  ChannelExtension as VelaExtension,
  ChannelExtensionAPI as ExtensionAPI,
  LoadedChannelExtension as LoadedExtension,
} from './channels/vela.ts'
export type {
  ExtensionConfigContext,
  ExtensionConfigDefinition,
} from './config/extension-config.ts'
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
export {
  inspectSession,
  inspectVela,
  type SessionInspection,
  type VelaInspection,
} from './diagnostics.ts'
export { configString, configStrings } from './extensions/config.ts'
export {
  customMessageIfChanged,
  customMessageMissing,
  lastCustomMessage,
} from './extensions/custom-message.ts'
export type {
  FeishuCard,
  FeishuCardAction,
  FeishuCardResponse,
} from './extensions/feishu/cards.ts'
export {
  type FeishuOptions,
  feishu,
  larkConfig,
} from './extensions/feishu/index.ts'
export type {
  FeishuHistoryMessage,
  FeishuMessageEvent,
  FeishuSentMessage,
  FeishuTransport,
} from './extensions/feishu/transport.ts'
export { mcpConfig } from './extensions/mcp/config.ts'
export {
  type McpExposure,
  type McpHttpServerConfig,
  type McpOptions,
  type McpServerConfig,
  type McpServersFile,
  type McpStdioServerConfig,
  mcp,
} from './extensions/mcp/index.ts'
export { memory, memoryConfig } from './extensions/memory/index.ts'
export {
  permissionGate,
  permissionGateConfig,
} from './extensions/permission-gate/index.ts'
export { createEmbedder, type EmbeddingFn } from './extensions/rag/embedder.ts'
export { type RagOptions, rag, ragConfig } from './extensions/rag/index.ts'
export type {
  AfterProviderResponseEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BeforeProviderRequestEvent,
  ContextEvent,
  ContextEventResult,
  CustomMessage,
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
  SessionBeforeForkEvent,
  SessionBeforeForkEventResult,
  SessionBeforeTreeEvent,
  SessionBeforeTreeEventResult,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  SessionUI,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
  TreePreparation,
} from './extensions/types.ts'
export { type WebOptions, web, webConfig } from './extensions/web/index.ts'
export { resolveBinary, setDefaultToolModifiers } from './frontend.ts'
export type { VelaLimits } from './limits.ts'
export { silentLogger, type VelaLogger } from './logger.ts'
export type {
  ImageContent,
  ModelMessage,
  TextContent,
  ToolContent,
  ToolModelMessage,
  ToolResultPart,
  UserContent,
} from './messages.ts'
export type {
  LoginProvider,
  ModelInfo,
  ModelSpec,
  ProviderContext,
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
} from './security/permissions.ts'
export { publishChannelEvent } from './session/channel-events.ts'
export {
  type BashExecutionEntry,
  type BranchSummaryEntry,
  bashExecutionToText,
  type CompactionEntry,
  type ContextEditEntry,
  type CustomEntry,
  type CustomMessageEntry,
  type LabelEntry,
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
  type SessionTreeNode,
  summarizeSession,
  type ThinkingLevelChangeEntry,
} from './session/entries.ts'
export { messageText } from './session/message-queue.ts'
export type {
  ForkOptions,
  NavigateTreeOptions,
  QueueMode,
} from './session/options.ts'
export type { SessionScope } from './session/scope.ts'
export {
  fileSessionStorage,
  memorySessionStorage,
  type SessionPersistence,
  type SessionStorage,
} from './session/storage.ts'
export type { ExecutionMetadata } from './session/tool-history.ts'
export { withFileMutationQueue } from './tools/file-mutation-queue.ts'
export { defineJsonSchemaTool } from './tools/json-schema.ts'
export type { ToolContext, ToolDefinition } from './tools/registry.ts'
export type { BashResult } from './tools/shell.ts'
export type {
  ExecuteToolOptions,
  ToolAnnotations,
  ToolCallOutcome,
  ToolExecutionMode,
  ToolExposure,
  ToolNamespace,
} from './tools/types.ts'
export { ToolExecutionResult } from './tools/types.ts'
export type {
  ModelPricing,
  StepRecord,
  StepUsage,
  TokenStatus,
  UsageTotals,
} from './usage/tracker.ts'
export { createVela, type Vela, type VelaOptions } from './vela.ts'
export type { SessionUsage } from './vela-session.ts'
export {
  type ForkResult,
  type PromptOptions,
  type SessionOptions,
  VelaSession,
} from './vela-session.ts'
