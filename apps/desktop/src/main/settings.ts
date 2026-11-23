import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CredentialStore,
  larkConfig,
  type ProviderDefinition,
  usableModel,
} from '@glows777/vela'
import { loadConfig, resolveModel } from '@glows777/vela/legacy-desktop'
import type { SettingsProvider, SettingsState } from '../shared/bridge.ts'
import { larkState } from './lark-settings.ts'

export function loadDesktopConfig(cwd: string, agentDir?: string) {
  return loadConfig({
    deferSystemFiles: true,
    cwd,
    agentDir,
    env: process.env,
    trusted: false,
    extensionConfigs: [larkConfig],
    builtins: ['background', 'memory', 'web', 'lark', 'mcp', 'todo'],
  })
}

/**
 * Whether a saved `provider/id` names something a session could use: the same resolution a session
 * does, so a model whose provider was removed from models.json reads as unusable instead of opening
 * the app on a model that would fail at the first reply.
 */
function resolves(
  ref: string,
  providers: Record<string, ProviderDefinition>,
  credentials: CredentialStore,
): boolean {
  try {
    resolveModel(ref, { providers, credentials })
    return true
  } catch {
    return false
  }
}

/** Providers `models.json` defines, by name only: their values may hold a key or a header. */
function customProviders(agentDir: string): Set<string> {
  const path = join(agentDir, 'models.json')
  if (!existsSync(path)) return new Set()
  const file = JSON.parse(readFileSync(path, 'utf8')) as {
    providers?: Record<string, unknown>
  }
  return new Set(Object.keys(file.providers ?? {}))
}

/**
 * Vela's configuration as the pages show it: derived values only. The contents of settings.json,
 * models.json and auth.json stay in main, because a models.json entry may carry an `apiKey` and the
 * Lark section carries its secret.
 *
 * `directModel` is a model handed to the host (`VELA_MODEL=faux:<scenario>`), and
 * `hasAvailableModel` says some provider already has a credential; either one means no setup screen.
 */
export function readSettings(options: {
  agentDir: string
  cwd: string
  larkLoaded: boolean
  larkStartupError?: string
  directModel: boolean
  hasAvailableModel: boolean
}): SettingsState {
  const config = loadDesktopConfig(options.cwd, options.agentDir)
  const custom = customProviders(config.agentDir)
  const providers: SettingsProvider[] = Object.entries(config.providers).map(
    ([name, definition]: [string, ProviderDefinition]) => ({
      name,
      ...(definition.authSource
        ? { credential: definition.authSource(config.credentials.get(name)) }
        : {}),
      custom: custom.has(name),
      models: (definition.models ?? []).map(
        ({ id, contextWindow, reasoning }) => ({
          id,
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(reasoning === undefined ? {} : { reasoning }),
        }),
      ),
    }),
  )
  const model = config.settings.defaultModel
  return {
    folder: config.agentDir,
    lark: larkState(
      config.settings.extensionConfig?.lark ?? {},
      config.extensionConfig.lark ?? {},
      options.larkLoaded,
      options.larkStartupError,
    ),
    files: {
      settings: join(config.agentDir, 'settings.json'),
      models: join(config.agentDir, 'models.json'),
      auth: join(config.agentDir, 'auth.json'),
    },
    setup: options.directModel
      ? { required: false }
      : model === undefined
        ? options.hasAvailableModel
          ? { required: false }
          : { required: true, reason: 'no-model' }
        : resolves(model, config.providers, config.credentials)
          ? usableSetup(
              usableModel({
                providers: config.providers,
                credentials: config.credentials,
                model,
              }),
            )
          : { required: true, reason: 'unknown-model' },
    ...(model === undefined ? {} : { model }),
    ...(config.settings.defaultThinkingLevel === undefined
      ? {}
      : { thinkingLevel: config.settings.defaultThinkingLevel }),
    providers,
  }
}

function usableSetup(check: {
  usable: boolean
  reason?: 'no-model' | 'missing-credential'
  provider?: string
}): SettingsState['setup'] {
  if (check.usable) return { required: false }
  return {
    required: true,
    ...(check.reason ? { reason: check.reason } : {}),
    ...(check.provider ? { provider: check.provider } : {}),
  }
}
