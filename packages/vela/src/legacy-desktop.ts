/**
 * Transitional internal bridge for `apps/desktop` until S4c switches Desktop to the thin daemon client.
 * Not part of the public SDK contract; deleted in S4c.
 * @internal
 */
export {
  type LegacyMigrationResult,
  type LegacyMigrationSummary,
  migrateLegacyVelaDir,
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
export {
  connectLarkSetup,
  discoverLarkGroup,
  LarkSubmitError,
} from './lark/index.ts'
export {
  channelSessionId,
  createChannelVela,
} from './legacy-channels/index.ts'
export { loadConfig } from './load-config.ts'
export { resolveShellPath } from './shared/shell-path.ts'
