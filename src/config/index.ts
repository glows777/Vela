import { homedir } from 'node:os'
import { join } from 'node:path'
import { type McpServersFile, mcpConfig } from '../extensions/mcp/config.ts'
import {
  type VelaConfig as CoreConfig,
  projectTrustRequired as coreTrust,
  type LoadConfigOptions,
  loadConfig as loadCoreConfig,
} from './settings.ts'

export * from './core.ts'

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
