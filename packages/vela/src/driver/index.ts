/** SDK entry, independent of platform, MCP and RAG implementations. */

export {
  fileCredentialStore,
  memoryCredentialStore,
} from '../providers/auth/store.ts'
export type {
  ApiKeyCredential,
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Credential,
  CredentialStore,
  LoginOptions,
  LogoutOptions,
  LogoutResult,
  OAuthCredential,
  OAuthLogin,
} from '../providers/auth/types.ts'
export type {
  HostedToolModel,
  LoginProvider,
  ModelCompat,
  ModelInfo,
  ModelSpec,
  ProviderContext,
  ProviderDefinition,
  ThinkingLevel,
} from '../providers/models/index.ts'
export {
  verifyProviderModel,
  writeProviderPreset,
} from '../providers/models/setup.ts'
export type { VelaLimits } from '../shared/limits.ts'
export { silentLogger, type VelaLogger } from '../shared/logger.ts'
export type {
  FinishReason,
  ModelHandle,
  ModelInput,
  ProviderRequestParams,
  ProviderUsage,
  ReasoningOption,
} from '../shared/provider-types.ts'
export {
  resolveShellPath,
  type ShellPathOptions,
} from '../shared/shell-path.ts'
export {
  createJsonSchema,
  type ToolInputSchema,
  type VelaJsonSchema,
} from '../shared/tool-schema.ts'
export type {
  AgentErrorKind,
  AssistantMessageEvent,
  CompactionReason,
  CompactionResult,
  CustomMessageInfo,
  StopReason,
  VelaEvent,
  VelaEventListener,
  VelaSessionEventListener,
} from './agent/events.ts'
export { agentErrorHint, failureHint } from './agent/retry.ts'
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
export { createLocalExecutionEnv } from './execution/local.ts'
export type {
  BinaryReader,
  ExecutionEnv,
  ExecutionError,
  ExecutionErrorCode,
  ExecutionLocation,
  FileError,
  FileErrorCode,
  FileInfo,
  LineScan,
  Result,
  ShellExecOptions,
  ShellExecResult,
} from './execution/types.ts'
export {
  type BackgroundOptions,
  background,
} from './extensions/background/index.ts'
export { memory } from './extensions/memory/index.ts'
export type { LoadedExtension } from './extensions/runner.ts'
export { todo } from './extensions/todo/index.ts'
export type {
  CustomMessage,
  ExtensionAPI,
  ExtensionCommand,
  ExtensionContext,
  ExtensionEventName,
  ExtensionEvents,
  ExtensionHandler,
  InputSource,
  SendMessageOptions,
  VelaExtension,
} from './extensions/types.ts'
export { type WebOptions, web, webConfig } from './extensions/web/index.ts'
export { resolveBinary, setDefaultToolModifiers } from './frontend.ts'
export type {
  AssistantContent,
  AssistantContentPart,
  AssistantModelMessage,
  CustomProviderPart,
  FilePart,
  ImageContent,
  ModelMessage,
  ProviderOptions,
  ReasoningFilePart,
  TextContent,
  ThinkingPart,
  ToolApprovalRequestPart,
  ToolApprovalResponsePart,
  ToolCallPart,
  ToolContent,
  ToolMessageContentPart,
  ToolModelMessage,
  ToolResultContentItem,
  ToolResultOutput,
  ToolResultPart,
  UserContent,
  UserContentPart,
  VelaAssistantMessage,
  VelaMessage,
  VelaPart,
  VelaSystemMessage,
  VelaToolMessage,
  VelaUserMessage,
} from './messages.ts'
export {
  type ContextFile,
  loadContextFiles,
} from './prompt/context-files.ts'
export type { DocsPaths } from './prompt/index.ts'
export { publishChannelEvent } from './session/channel-events.ts'
export {
  type BashExecutionEntry,
  type BranchSummaryEntry,
  bashExecutionToText,
  type CompactionEntry,
  type CustomEntry,
  type CustomMessageEntry,
  SESSION_FORMAT_VERSION,
  type SessionEntry,
  type SessionFileEntry,
  type SessionHeader,
  type SessionMessageEntry,
  type SessionSummary,
  type SessionTreeNode,
} from './session/entries.ts'
export { messageText } from './session/message-queue.ts'
export type {
  ForkOptions,
  NavigateTreeOptions,
  PromptOptions,
  QueueMode,
  SessionOptions,
  SessionPersistence,
  SessionUsage,
} from './session/options.ts'
export type { SessionSearchHit } from './session/search.ts'
export type {
  ApprovalDecision,
  PendingApprovalInfo,
  ResolvedApprovalInfo,
} from './step-recovery.ts'
export { createBinaryResolver } from './tools/binaries.ts'
export { withFileMutationQueue } from './tools/file-mutation-queue.ts'
export { defineJsonSchemaTool } from './tools/json-schema.ts'
export type { ToolContext, ToolDefinition } from './tools/registry.ts'
export type { BashResult } from './tools/shell.ts'
export type {
  ExecutionMetadata,
  ToolAnnotations,
  ToolExecutionMode,
  ToolExposure,
  ToolNamespace,
} from './tools/types.ts'
export { SpilledToolOutput, ToolExecutionResult } from './tools/types.ts'
export type {
  ModelPricing,
  StepRecord,
  StepUsage,
  UsageTotals,
} from './usage/tracker.ts'
export {
  createVela,
  type SavedSessionOptions,
  type Vela,
  type VelaOptions,
} from './vela.ts'
export type { ForkResult } from './vela-session.ts'
export { VelaSession } from './vela-session.ts'
