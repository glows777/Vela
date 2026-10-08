import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { ModelSpec, ProviderDefinition } from '../models/index.ts'
import { interpolate, isPlainObject } from './interpolate.ts'

type Env = Record<string, string | undefined>

/** Wire protocol of a models.json provider (pi's `api` field; only these are supported). */
export type ProviderApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'

const APIS: readonly ProviderApi[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
]

/** One provider in `~/.vela/models.json` (same shape as pi). */
export interface ProviderConfig {
  api?: ProviderApi
  baseUrl?: string
  /** `$VAR` / `${VAR}` reads an environment variable */
  apiKey?: string
  headers?: Record<string, string>
  models?: ModelSpec[]
}

/**
 * Built-in providers; keys come from environment variables. A models.json provider
 * with the same name overrides these fields (e.g. only `models`, to add contextWindow / cost to openai).
 * openai uses Chat Completions (existing behavior; works with any OpenAI-compatible service).
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
 * Reads `<agentDir>/models.json`, merges it with the built-in providers and returns
 * `providers` for createVela. User-level directory only (like pi, projects have no models.json).
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
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`)
  }
  const providers = isPlainObject(raw) ? raw.providers : undefined
  if (providers === undefined) return {}
  if (!isPlainObject(providers))
    throw new Error(`${file}: providers must be an object`)
  for (const [name, config] of Object.entries(providers)) {
    if (!isPlainObject(config))
      throw new Error(`${file}: providers.${name} must be an object`)
    if (config.api !== undefined && !APIS.includes(config.api as ProviderApi))
      throw new Error(
        `${file}: providers.${name}.api must be one of ${APIS.join(' / ')}`,
      )
    const models = config.models
    if (
      models !== undefined &&
      (!Array.isArray(models) ||
        models.some((m) => !isPlainObject(m) || typeof m.id !== 'string'))
    )
      throw new Error(`${file}: providers.${name}.models must be an array of objects with an id`)
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
        throw new Error(`${file}: providers.${name} is missing api`)
      const apiKey = read(config.apiKey)
      if (!apiKey)
        throw new Error(
          `Provider ${name} has no API key (${config.apiKey?.startsWith('$') ? `set the ${config.apiKey.replace(/[${}]/g, '')} environment variable, or ` : ''}set apiKey in ${file})`,
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
