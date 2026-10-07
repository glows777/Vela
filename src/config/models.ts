import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { ModelSpec, ProviderDefinition } from '../models/index.ts'
import { interpolate, isPlainObject } from './interpolate.ts'

type Env = Record<string, string | undefined>

/** models.json 里 provider 的线协议（同 pi 的 `api` 字段，只支持这几种）。 */
export type ProviderApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'

const APIS: readonly ProviderApi[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
]

/** `~/.vela/models.json` 的一个 provider（同 pi 的形状）。 */
export interface ProviderConfig {
  api?: ProviderApi
  baseUrl?: string
  /** `$VAR` / `${VAR}` 读环境变量 */
  apiKey?: string
  headers?: Record<string, string>
  models?: ModelSpec[]
}

/**
 * 内置 provider：key 从环境变量读。models.json 里同名的 provider 覆盖这里的字段
 * （例如只写 `models` 给 openai 补上 contextWindow / cost）。
 * openai 用 Chat Completions（现有行为，OpenAI 兼容服务都能用）。
 */
const BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
  openai: {
    api: 'openai-completions',
    apiKey: '$OPENAI_API_KEY',
    baseUrl: '$OPENAI_API_BASE_URL',
  },
  anthropic: { api: 'anthropic-messages', apiKey: '$ANTHROPIC_API_KEY' },
}

/**
 * 读 `<agentDir>/models.json`，和内置 provider 合并，返回 createVela 的 `providers`。
 * 只读用户级目录（同 pi，项目里没有 models.json）。
 */
export function loadModels(options: {
  agentDir: string
  env?: Env
}): Record<string, ProviderDefinition> {
  const env = options.env ?? {}
  const file = join(options.agentDir, 'models.json')
  const fromFile = readModelsFile(file)
  const names = new Set([
    ...Object.keys(BUILTIN_PROVIDERS),
    ...Object.keys(fromFile),
  ])
  const providers: Record<string, ProviderDefinition> = {}
  for (const name of names)
    providers[name] = createProvider(
      name,
      { ...BUILTIN_PROVIDERS[name], ...fromFile[name] },
      env,
      file,
    )
  return providers
}

function readModelsFile(file: string): Record<string, ProviderConfig> {
  if (!existsSync(file)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (error) {
    throw new Error(`${file} 不是合法的 JSON: ${(error as Error).message}`)
  }
  const providers = isPlainObject(raw) ? raw.providers : undefined
  if (providers === undefined) return {}
  if (!isPlainObject(providers))
    throw new Error(`${file}: providers 应该是对象`)
  for (const [name, config] of Object.entries(providers)) {
    if (!isPlainObject(config))
      throw new Error(`${file}: providers.${name} 应该是对象`)
    if (config.api !== undefined && !APIS.includes(config.api as ProviderApi))
      throw new Error(
        `${file}: providers.${name}.api 只支持 ${APIS.join(' / ')}`,
      )
    const models = config.models
    if (
      models !== undefined &&
      (!Array.isArray(models) ||
        models.some((m) => !isPlainObject(m) || typeof m.id !== 'string'))
    )
      throw new Error(`${file}: providers.${name}.models 应该是带 id 的对象数组`)
  }
  return providers as Record<string, ProviderConfig>
}

function createProvider(
  name: string,
  config: ProviderConfig,
  env: Env,
  file: string,
): ProviderDefinition {
  const read = (value: string | undefined) =>
    value === undefined ? undefined : interpolate(value, env) || undefined
  const headers = config.headers
    ? Object.fromEntries(
        Object.entries(config.headers).map(([k, v]) => [k, interpolate(v, env)]),
      )
    : undefined
  return {
    models: config.models,
    createModel(id) {
      if (!config.api)
        throw new Error(`${file}: providers.${name} 没有写 api`)
      const apiKey = read(config.apiKey)
      if (!apiKey)
        throw new Error(
          `provider ${name} 没有 API key（${config.apiKey?.startsWith('$') ? `设置环境变量 ${config.apiKey.replace(/[${}]/g, '')}，或` : ''}在 ${file} 里写 apiKey）`,
        )
      const baseURL = read(config.baseUrl)
      switch (config.api) {
        case 'openai-completions':
          return createOpenAI({ apiKey, baseURL, headers, name }).chat(id)
        case 'openai-responses':
          return createOpenAI({ apiKey, baseURL, headers, name }).responses(id)
        case 'anthropic-messages':
          return createAnthropic({ apiKey, baseURL, headers, name })(id)
      }
    },
  }
}
