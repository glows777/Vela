export {
  interpolateConfigLayer,
  mergeConfig,
  PROJECT_PRIVILEGED_KEYS,
  parseConfig,
  RESOURCE_KEYS,
  stripProjectPrivilegedKeys,
  toExtensionConfigView,
  type VelaSettings,
  validateProvidersRecord,
} from './schema.ts'
export { savedTrust, saveTrust } from './trust.ts'
export {
  detectLegacyConfigFiles,
  readRawConfigFile,
  updateConfigFile,
  writeRawConfigFile,
} from './writer.ts'
