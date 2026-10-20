import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { type LanguageModel, wrapLanguageModel } from 'ai'
import {
  chatGPTRequests,
  openaiChatGPTLogin,
} from '../auth/oauth/openai-chatgpt.ts'
import { openRouterLogin } from '../auth/oauth/openrouter.ts'
import type { Credential, FetchFunction, OAuthLogin } from '../auth/types.ts'
import {
  catalogLookup,
  catalogModels,
  type ModelSpec,
  type ProviderContext,
  type ProviderDefinition,
} from '../models/index.ts'
import { deepseekReasoningStream } from './deepseek-responses.ts'
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

interface BuiltinProvider {
  config: ProviderConfig
  /** Environment variable with the API key (checked after auth.json and models.json, like pi) */
  envKey: string
  defaultModel: string
  oauth?: OAuthLogin
  /** Request rules while the OAuth credential is used (an endpoint with its own rules, like Sign in with ChatGPT) */
  oauthRequests?: {
    /** Refuse the OAuth credential in channel sessions (it is for the local terminal only) */
    localOnly?: boolean
    transformParams?(
      params: LanguageModelV4CallOptions,
    ): LanguageModelV4CallOptions
    wrapFetch?(fetch: FetchFunction): FetchFunction
  }
  /** Rewrites the JSON request body for provider-specific fields the AI SDK doesn't send */
  prepareBody?: (body: Record<string, unknown>) => void
}

/**
 * OpenRouter takes reasoning effort as `reasoning: { effort }` (pi's `thinkingFormat: 'openrouter'`), and the
 * system role rather than `developer` for every model it routes to.
 */
function openRouterBody(body: Record<string, unknown>): void {
  if (typeof body.reasoning_effort === 'string') {
    body.reasoning = { effort: body.reasoning_effort }
    delete body.reasoning_effort
  }
  if (Array.isArray(body.messages))
    for (const message of body.messages as { role?: string }[])
      if (message.role === 'developer') message.role = 'system'
}

/**
 * Built-in providers (pi's ids, defaults and environment variables). Their models come from the built-in
 * catalog; a models.json provider with the same name overrides fields (e.g. `api`, `baseUrl`) and adds models.
 */
const BUILTIN_PROVIDERS: Record<string, BuiltinProvider> = {
  anthropic: {
    config: { api: 'anthropic-messages' },
    envKey: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-opus-4-8',
  },
  openai: {
    config: { api: 'openai-responses', baseUrl: '$OPENAI_API_BASE_URL' },
    envKey: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5.5',
    oauth: openaiChatGPTLogin,
    oauthRequests: chatGPTRequests,
  },
  openrouter: {
    config: {
      api: 'openai-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
    },
    envKey: 'OPENROUTER_API_KEY',
    defaultModel: 'moonshotai/kimi-k2.6',
    oauth: openRouterLogin,
    prepareBody: openRouterBody,
  },
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
  for (const name of names) {
    const builtin = BUILTIN_PROVIDERS[name]
    const own = fromFile[name] ?? {}
    providers[name] = createProvider(
      name,
      {
        ...builtin?.config,
        ...own,
        models: mergeModels(
          name,
          builtin ? catalogModels(name) : [],
          own.models,
        ),
      },
      builtin,
      env,
      file,
    )
  }
  return providers
}

/** Catalog models, then models.json entries (a listed id overrides the catalog entry field by field) */
function mergeModels(
  provider: string,
  catalog: ModelSpec[],
  listed: ModelSpec[] = [],
): ModelSpec[] {
  const byId = new Map<string, ModelSpec>()
  for (const model of catalog) {
    const { api: _, ...spec } = model as ModelSpec & { api?: string }
    byId.set(spec.id, spec)
  }
  for (const model of listed) {
    const { api: _, ...known } = (byId.get(model.id) ??
      catalogLookup(provider, model.id) ?? { id: model.id }) as ModelSpec & {
      api?: string
    }
    byId.set(model.id, { ...known, ...model })
  }
  return [...byId.values()]
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
      throw new Error(
        `${file}: providers.${name}.models must be an array of objects with an id`,
      )
  }
  return providers as Record<string, ProviderConfig>
}

/** Placeholder the AI SDK sends until the auth fetch replaces it with the key of this request */
const MANAGED_KEY = 'vela-managed-key'

function createProvider(
  name: string,
  config: ProviderConfig,
  builtin: BuiltinProvider | undefined,
  env: Env,
  file: string,
): ProviderDefinition {
  const read = (value: string | undefined) =>
    value === undefined ? undefined : interpolate(value, env) || undefined
  const headers = config.headers
    ? Object.fromEntries(
        Object.entries(config.headers).map(([k, v]) => [
          k,
          interpolate(v, env),
        ]),
      )
    : undefined
  const oauth = builtin?.oauth
  const oauthRequests = builtin?.oauthRequests
  const envKey = builtin?.envKey
  const configured = () => read(config.apiKey)

  // Like pi: a stored credential first, then models.json's apiKey, then the environment variable
  const authSource = (credential: Credential | undefined) => {
    if (credential)
      return credential.type === 'oauth' ? 'OAuth (auth.json)' : 'auth.json'
    if (configured())
      return config.apiKey?.startsWith('$')
        ? config.apiKey.replace(/[${}]/g, '')
        : 'models.json'
    if (envKey && env[envKey]) return envKey
  }

  const requestKey = async (
    ctx: ProviderContext,
  ): Promise<{ key: string; oauth: boolean }> => {
    const credential = await ctx.credential()
    if (credential?.type === 'api_key')
      return { key: credential.key, oauth: false }
    if (credential?.type === 'oauth') {
      if (!oauth)
        throw new Error(
          `auth.json has an OAuth credential for ${name}, but Vela has no OAuth sign-in for this provider; run /logout ${name}`,
        )
      const channel = ctx.channel()
      if (oauthRequests?.localOnly && channel)
        throw new Error(
          `${oauth.name} is only for the local terminal, not for ${channel}; give ${name} an API key (/login ${name} → Enter an API key, or the ${envKey} environment variable) or have this channel use another model`,
        )
      return { key: credential.access, oauth: true }
    }
    const key = configured() ?? (envKey ? env[envKey] : undefined)
    if (key) return { key, oauth: false }
    const ways = [
      ...(oauth || builtin ? [`run /login ${name}`] : []),
      ...(config.apiKey?.startsWith('$')
        ? [
            `set the ${config.apiKey.replace(/[${}]/g, '')} environment variable`,
          ]
        : envKey
          ? [`set the ${envKey} environment variable`]
          : []),
      `set apiKey in ${file}`,
    ]
    throw new Error(`Provider ${name} has no API key (${ways.join(', or ')})`)
  }

  return {
    models: config.models,
    ...(builtin
      ? { defaultModel: builtin.defaultModel, apiKeyLogin: true }
      : {}),
    ...(oauth ? { oauth } : {}),
    authSource,
    createModel(id, ctx) {
      if (!config.api)
        throw new Error(`${file}: providers.${name} is missing api`)
      const api = config.api
      // Each request asks for the current key (OAuth tokens expire and are refreshed, /login can switch accounts)
      const fetchWithAuth: FetchFunction = async (input, init) => {
        const { key, oauth: isOAuth } = await requestKey(ctx)
        const requestHeaders = new Headers(init?.headers)
        if (api === 'anthropic-messages') requestHeaders.set('x-api-key', key)
        else requestHeaders.set('authorization', `Bearer ${key}`)
        let body = init?.body
        if (builtin?.prepareBody && typeof body === 'string') {
          const json = JSON.parse(body) as Record<string, unknown>
          builtin.prepareBody(json)
          body = JSON.stringify(json)
        }
        const base: FetchFunction = (i, o) => globalThis.fetch(i, o)
        const send =
          isOAuth && oauthRequests?.wrapFetch
            ? oauthRequests.wrapFetch(base)
            : base
        return send(input, { ...init, headers: requestHeaders, body })
      }
      const settings = {
        apiKey: MANAGED_KEY,
        baseURL: read(config.baseUrl),
        headers,
        name,
        fetch: fetchWithAuth as typeof globalThis.fetch,
      }
      let model: LanguageModel
      switch (api) {
        case 'openai-completions':
          model = createOpenAI(settings).chat(id)
          break
        case 'openai-responses':
          model = createOpenAI(settings).responses(id)
          break
        case 'anthropic-messages':
          model = createAnthropic(settings)(id)
          break
      }
      const transform = oauthRequests?.transformParams
      if (
        (api !== 'openai-responses' && !transform) ||
        typeof model === 'string'
      )
        return model
      const spec =
        config.models?.find((m) => m.id === id) ?? catalogLookup(name, id)
      const deepseekResponses =
        api === 'openai-responses' &&
        settings.baseURL !== undefined &&
        new URL(settings.baseURL).hostname === 'api.deepseek.com'
      return wrapLanguageModel({
        model,
        middleware: {
          specificationVersion: 'v4',
          ...(deepseekResponses ? { wrapStream: deepseekReasoningStream } : {}),
          transformParams: async ({ params }) => {
            if (api === 'openai-responses') {
              const openai = { ...params.providerOptions?.openai }
              // The SDK infers capability from IDs; positive metadata also enables custom IDs.
              if (
                openai.forceReasoning === undefined &&
                spec?.reasoning === true
              )
                openai.forceReasoning = true
              const level =
                params.reasoning === 'none' ? 'off' : params.reasoning
              const effort =
                level && level !== 'provider-default'
                  ? spec?.thinkingLevelMap?.[level]
                  : undefined
              if (
                openai.reasoningEffort === undefined &&
                typeof effort === 'string'
              )
                openai.reasoningEffort = effort
              // DeepSeek treats developer messages as user messages. Keep the system instruction's role.
              if (deepseekResponses) {
                // DeepSeek is stateless: let the SDK serialize history inline.
                openai.store = false
                if (openai.systemMessageMode === undefined)
                  openai.systemMessageMode = 'system'
              }
              params = {
                ...params,
                providerOptions: { ...params.providerOptions, openai },
              }
            }
            // The OAuth route's requirements remain authoritative over caller/default options.
            return transform && (await ctx.credential())?.type === 'oauth'
              ? transform(params)
              : params
          },
        },
      })
    },
  }
}
