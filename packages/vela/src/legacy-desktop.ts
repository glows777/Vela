/**
 * Transitional internal bridge for `apps/desktop` until S4c switches Desktop to the thin daemon client.
 * Not part of the public SDK contract; deleted in S4c.
 * @internal
 */
export { DaemonLarkHost } from './daemon/lark-host.ts'
export {
  type OpenDatabaseOptions,
  openDatabase,
  type RunResult,
  SCHEMA_VERSION,
  type SqlParam,
  VelaDatabase,
} from './db/index.ts'
export { defaultAgentDir } from './driver/config/paths.ts'
export { resolveModel } from './driver/diagnostics.ts'
export { loadModels } from './driver/index.ts'
export { createVelaAgentDriver } from './driver/runtime-adapter.ts'
export { parseChats as parseLarkChats } from './lark/chats.ts'
export {
  connectLarkSetup,
  createLarkChannelAdapter,
  discoverLarkGroup,
} from './lark/index.ts'
export { loadConfig } from './load-config.ts'
export {
  type ChannelAdapter,
  type ChannelAdapterContext,
  type ChannelBinding,
  type ChannelOutboundMessage,
  type ProjectRecord,
  type RuntimeEvent,
  type SessionRecord,
  type SessionStatusInfo,
  type TimerRecord,
  VelaRuntimeEngine,
  type VelaRuntimeEngineOptions,
} from './runtime/index.ts'
export { createRuntime, type LocalVelaRuntime } from './runtime-sdk.ts'
export {
  localRoutineInstant,
  nextOccurrence,
  type RoutineSchedule,
  routineLocalTime,
  routineTimezone,
} from './shared/routine-time.ts'
export { resolveShellPath } from './shared/shell-path.ts'
