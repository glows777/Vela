import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type VelaConfig as CoreConfig,
  type LoadConfigOptions,
  loadConfig as loadCoreConfig,
} from '@glows777/vela-core'
import { type McpServersFile, mcpConfig } from '@glows777/vela-mcp'
import { projectTrustRequired as coreTrust } from '../cli/config-helpers.ts'

export type {
  ExtensionEntry,
  LoadConfigOptions,
  ProviderApi,
  ProviderConfig,
  VelaSettings,
} from '@glows777/vela-core'
export { importExtension, loadModels } from '@glows777/vela-core'
export { defaultAgentDir, extensionName } from '../cli/config-helpers.ts'
export { savedTrust, saveTrust } from '../cli/config-trust.ts'

export interface VelaConfig extends CoreConfig {
  mcp: McpServersFile
}
export function loadConfig(options: LoadConfigOptions = {}): VelaConfig {
  const core = loadCoreConfig(options)
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
  return {
    ...core,
    mcp: {
      servers: section.mcpServers as Record<string, unknown>,
      sources: section.sources as Record<string, string>,
      errors: section.errors as string[],
    },
  }
}
export function projectTrustRequired(
  cwd: string,
  agentDir?: string,
  homeDir: string = homedir(),
): boolean {
  return coreTrust(cwd, agentDir, homeDir, [mcpConfig])
}
