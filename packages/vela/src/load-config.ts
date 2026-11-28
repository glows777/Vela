import { homedir } from 'node:os'
import { join } from 'node:path'
import { projectTrustRequired as coreTrust } from './driver/diagnostics.ts'
import {
  type VelaConfig as CoreConfig,
  type LoadConfigOptions,
  loadConfig as loadCoreConfig,
  type VelaSettings,
} from './driver/index.ts'
import { type McpServersFile, mcpConfig } from './mcp/index.ts'

export type {
  ExtensionEntry,
  LoadConfigOptions,
  ProviderApi,
  ProviderConfig,
  VelaSettings,
} from './driver/index.ts'
export { loadModels } from './driver/index.ts'

export interface VelaConfig extends CoreConfig {
  settings: VelaSettings
  mcp: McpServersFile
}

export function loadConfig(options: LoadConfigOptions = {}): VelaConfig {
  const core = loadCoreConfig(options)
  const settings: VelaSettings = core.settings
  const projectDir = join(core.cwd, '.vela')
  const section = mcpConfig.resolve(
    {},
    {
      cwd: core.cwd,
      agentDir: core.agentDir,
      projectDir,
      trusted: options.trusted === true && projectDir !== core.agentDir,
      env: options.env ?? {},
    },
  )
  return Object.assign(core, {
    settings,
    mcp: {
      servers: section.mcpServers as Record<string, unknown>,
      sources: section.sources as Record<string, string>,
      errors: section.errors as string[],
    },
  })
}

export function projectTrustRequired(
  cwd: string,
  agentDir?: string,
  homeDir: string = homedir(),
): boolean {
  return coreTrust(cwd, agentDir, homeDir, [mcpConfig])
}
