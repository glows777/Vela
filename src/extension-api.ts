/** Acyclic public extension contracts; never import the product/root barrel here. */

export type { VelaEvent } from './agent/events.ts'
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
export type { VelaLogger } from './logger.ts'
export { silentLogger } from './logger.ts'
export type { ImageContent, ModelMessage, ToolContent } from './messages.ts'
export type {
  PermissionDecision,
  PermissionRules,
} from './security/permissions.ts'
export { publishChannelEvent } from './session/channel-events.ts'
export { messageText } from './session/message-queue.ts'
export type { SessionScope } from './session/scope.ts'
export { defineJsonSchemaTool } from './tools/json-schema.ts'
export type { ToolContext, ToolDefinition } from './tools/registry.ts'
export type {
  ExecuteToolOptions,
  ToolAnnotations,
  ToolCallOutcome,
  ToolExecutionMode,
  ToolExposure,
  ToolNamespace,
} from './tools/types.ts'
export { ToolExecutionResult } from './tools/types.ts'
export type { StepRecord, StepUsage, UsageTotals } from './usage/tracker.ts'
export type { SessionOptions, VelaSession } from './vela-session.ts'
