import { homedir } from 'node:os'
import { join } from 'node:path'
import { projectTrustRequired as coreTrust } from '../driver/diagnostics.ts'
import {
  type VelaConfig as CoreConfig,
  type VelaSettings as CoreSettings,
  type LoadConfigOptions,
  loadConfig as loadCoreConfig,
} from '../driver/index.ts'
import type { ChannelVelaOptions } from '../legacy-channels/index.ts'
import { type McpServersFile, mcpConfig } from '../mcp/index.ts'

export { defaultAgentDir, extensionName } from '../driver/diagnostics.ts'
export type {
  ExtensionEntry,
  LoadConfigOptions,
  ProviderApi,
  ProviderConfig,
} from '../driver/index.ts'
export { importExtension, loadModels } from '../driver/index.ts'
export { savedTrust, saveTrust } from './trust.ts'

export interface VelaSettings extends CoreSettings {
  /** Unmatched events may reach this existing enabled top-level chat; unset drops them. */
  eventDefaultTarget?: ChannelVelaOptions['eventDefaultTarget']
}

export interface VelaConfig extends CoreConfig {
  settings: VelaSettings
  mcp: McpServersFile
}
export function loadConfig(options: LoadConfigOptions = {}): VelaConfig {
  const core = loadCoreConfig(options)
  const settings: VelaSettings = core.settings
  const target = settings.eventDefaultTarget
  if (
    target !== undefined &&
    (!target ||
      typeof target !== 'object' ||
      Object.keys(target).some(
        (key) => key !== 'channel' && key !== 'chatId',
      ) ||
      typeof target.channel !== 'string' ||
      !target.channel.trim() ||
      typeof target.chatId !== 'string' ||
      !target.chatId.trim())
  )
    throw new Error(
      `${core.files.join(', ')}: eventDefaultTarget must be { channel, chatId } with nonempty strings`,
    )
  if (target)
    settings.eventDefaultTarget = {
      channel: target.channel.trim(),
      chatId: target.chatId.trim(),
    }
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
