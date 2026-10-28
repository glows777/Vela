/** SDK entry, independent of platform, MCP and RAG implementations. */
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
} from './config/core.ts'
export type {
  ExtensionConfigContext,
  ExtensionConfigDefinition,
} from './config/extension-config.ts'
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
export { memory, memoryConfig } from './extensions/memory/index.ts'
export {
  permissionGate,
  permissionGateConfig,
} from './extensions/permission-gate/index.ts'
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
  VelaExtension,
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
