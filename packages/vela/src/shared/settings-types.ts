import type { ProviderApi, ThinkingLevel } from './provider-types.ts'

interface RuntimeSettingsModel {
  id: string
  contextWindow?: number
  reasoning?: boolean
}

export interface RuntimeSettingsProvider {
  name: string
  credential?: string
  custom: boolean
  models: RuntimeSettingsModel[]
}

export interface RuntimeSettingsLarkState {
  appId: string
  appSecretSaved: boolean
  chats: string[]
  envExpression: boolean
  enabled: boolean
  loaded: boolean
  startupError?: string
}

export interface RuntimeSettingsState {
  folder: string
  files: { config: string; auth: string }
  setup: {
    required: boolean
    reason?: 'no-model' | 'missing-credential' | 'unknown-model'
    provider?: string
  }
  model?: string
  thinkingLevel?: ThinkingLevel | 'max'
  lark: RuntimeSettingsLarkState
  providers: RuntimeSettingsProvider[]
}

export interface RuntimeModelSetupInput {
  provider: string
  model: string
  key?: string
  thinkingLevel?: ThinkingLevel
  custom?: { api: ProviderApi; baseUrl: string }
}

export type RuntimeLarkSetupInput =
  | { appId: string; appSecret?: string }
  | { removeChat: string }
  | { enabled: boolean }

export interface RuntimeLarkDiscoveryGroup {
  chatId: string
  name?: string
}
