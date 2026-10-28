import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type VelaConfig as CoreConfig,
  type LoadConfigOptions,
  loadConfig as loadCoreConfig,
} from '@glows777/vela-core'
import { projectTrustRequired as coreTrust } from '@glows777/vela-core/diagnostics'
import { type McpServersFile, mcpConfig } from '@glows777/vela-mcp'

export type {
  ExtensionEntry,
  LoadConfigOptions,
  ProviderApi,
  ProviderConfig,
  VelaSettings,
} from '@glows777/vela-core'
export { importExtension, loadModels } from '@glows777/vela-core'
export { defaultAgentDir, extensionName } from '@glows777/vela-core/diagnostics'
export { savedTrust, saveTrust } from '../cli/config-trust.ts'

export interface VelaConfig extends CoreConfig {
  mcp: McpServersFile
}
export function loadConfig(options: LoadConfigOptions = {}): VelaConfig {
  let core: CoreConfig
  try {
    core = loadCoreConfig(options)
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('Unknown built-in extension builtin:feishu')
    )
      throw new Error(
        'builtin:feishu -> builtin:lark. Stop Vela and migrate settings with scripts/migrate-lark.ts (dry run first, then --apply).',
      )
    throw error
  }
  if (
    'feishu' in core.extensionConfig ||
    core.settings.defaultTools?.some((name) => /^[+-]?feishu_/.test(name))
  )
    throw new Error(
      'Legacy extensionConfig.feishu / feishu_* tool selectors require migration to lark / lark_*. Stop Vela and run scripts/migrate-lark.ts with each settings file (dry run first).',
    )
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
