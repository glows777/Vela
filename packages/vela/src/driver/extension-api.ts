/** Acyclic public extension contracts; never import the product/root barrel here. */

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
export type { VelaLogger } from '../shared/logger.ts'
export { silentLogger } from '../shared/logger.ts'
export type { ModelPricing } from '../shared/pricing.ts'
export type {
  FinishReason,
  ModelHandle,
  ModelInput,
  ProviderRequestParams,
  ProviderUsage,
  ReasoningOption,
} from '../shared/provider-types.ts'
export {
  createJsonSchema,
  type ToolInputSchema,
  type VelaJsonSchema,
} from '../shared/tool-schema.ts'
export type { AgentErrorKind, VelaEvent } from './agent/events.ts'
export type {
  ExtensionConfigContext,
  ExtensionConfigDefinition,
} from './config/extension-config.ts'
export { configString, configStrings } from './extensions/config.ts'
export {
  customMessageIfChanged,
  customMessageMissing,
  lastCustomMessage,
} from './extensions/custom-message.ts'
export type * from './extensions/types.ts'
export type {
  ImageContent,
  ModelMessage,
  ProviderOptions,
  TextContent,
  ToolContent,
  ToolResultContentItem,
  ToolResultOutput,
  VelaMessage,
  VelaPart,
} from './messages.ts'
export { messageText } from './session/message-queue.ts'
export type { SessionOptions } from './session/options.ts'
export { defineJsonSchemaTool } from './tools/json-schema.ts'
export type { ToolContext, ToolDefinition } from './tools/registry.ts'
export type {
  ToolAnnotations,
  ToolExecutionMode,
  ToolExposure,
  ToolNamespace,
} from './tools/types.ts'
export { SpilledToolOutput, ToolExecutionResult } from './tools/types.ts'
export type { StepRecord, StepUsage, UsageTotals } from './usage/tracker.ts'
export type { VelaSession } from './vela-session.ts'
