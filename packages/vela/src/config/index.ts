export {
  type LegacyConfigMigrationResult,
  migrateLegacyConfigFiles,
} from './migrate-legacy.ts'
export {
  formatJsonParseError,
  interpolateConfigLayer,
  mergeConfig,
  PROJECT_PRIVILEGED_KEYS,
  parseConfig,
  RESOURCE_KEYS,
  stripProjectPrivilegedKeys,
  toExtensionConfigView,
  type VelaSettings,
} from './schema.ts'
export { savedTrust, saveTrust } from './trust.ts'
export {
  assertNoLegacyConfigFiles,
  LEGACY_CONFIG_FILES,
  readRawConfigFile,
  removeConfigIfHashMatches,
  updateConfigFile,
  writeRawConfigFile,
} from './writer.ts'
