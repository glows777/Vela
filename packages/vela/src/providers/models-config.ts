import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { anthropic, createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI, openai } from '@ai-sdk/openai'
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { type LanguageModel, wrapLanguageModel } from 'ai'
import { assertNoLegacyConfigFiles, parseConfig } from '../config/index.ts'
import { interpolate } from '../shared/interpolate.ts'
import type { ModelSpec, ProviderConfig } from '../shared/provider-types.ts'
import {
  chatGPTRequests,
  openaiChatGPTLogin,
} from './auth/oauth/openai-chatgpt.ts'
import { openRouterLogin } from './auth/oauth/openrouter.ts'
import type { Credential, FetchFunction, OAuthLogin } from './auth/types.ts'
import { deepseekReasoningStream } from './deepseek-responses.ts'
import {
  catalogLookup,
  catalogModels,
  isLocalOnlyOAuthBlocked,
  isRemoteChannel,
  type ProviderContext,
  type ProviderDefinition,
} from './models/index.ts'

export type { ProviderConfig } from '../shared/provider-types.ts'

type Env = Record<string, string | undefined>

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
export const BUILTIN_PROVIDERS: Record<string, BuiltinProvider> = {
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
  deepseek: {
    config: {
      // Unlike pi's completions path, Responses supports DeepSeek's native search.
      api: 'openai-responses',
      baseUrl: 'https://api.deepseek.com',
      compat: {
        store: false,
        supportsDeveloperRole: false,
        deepseekReasoningStream: true,
      },
      models: [
        { id: 'deepseek-v4-pro', compat: { hostedTools: ['web_search'] } },
      ],
    },
    envKey: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-flash',
  },
}

/**
 * Reads `providers` from `<agentDir>/config.json`, merges it with the built-in providers and
 * returns `providers` for createVela. User-level directory only (projects cannot define providers).
 */
export function loadModels(options: {
  agentDir: string
  env?: Env
  providers?: Record<string, ProviderConfig>
  overrides?: Record<string, ProviderConfig>
}): Record<string, ProviderDefinition> {
  const env = options.env ?? {}
  const file = join(options.agentDir, 'config.json')
  const fromFile = {
    ...(options.providers ?? readProvidersFromConfig(file)),
    ...options.overrides,
  }
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
        compat: { ...builtin?.config.compat, ...own.compat },
        models: mergeModels(
          name,
          mergeModels(
            name,
            builtin ? catalogModels(name) : [],
            // Protocol-specific built-in capabilities must not leak into explicit protocol overrides.
            own.api === undefined || own.api === builtin?.config.api
              ? builtin?.config.models
              : [],
          ),
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
    byId.set(model.id, {
      ...known,
      ...model,
      ...(known.compat || model.compat
        ? { compat: { ...known.compat, ...model.compat } }
        : {}),
    })
  }
  return [...byId.values()]
}

function readProvidersFromConfig(file: string): Record<string, ProviderConfig> {
  assertNoLegacyConfigFiles(dirname(file))
  if (!existsSync(file)) return {}
  return parseConfig(readFileSync(file, 'utf-8'), file).providers ?? {}
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
  const pureEnvVarName = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined
    const match =
      /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(raw)
    return match?.[1] ?? match?.[2]
  }

  // Like pi: a stored credential first, then config.json's apiKey, then the environment variable
  const authSource = (credential: Credential | undefined) => {
    if (credential)
      return credential.type === 'oauth' ? 'OAuth (auth.json)' : 'auth.json'
    if (configured()) return pureEnvVarName(config.apiKey) ?? 'config.json'
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
      if (oauthRequests?.localOnly && isRemoteChannel(channel)) {
        const fallback = configured() ?? (envKey ? env[envKey] : undefined)
        if (fallback) return { key: fallback, oauth: false }
        throw new Error(
          `${oauth.name} is only for the local terminal, not for ${channel}; give ${name} an API key (/login ${name} → Enter an API key, or the ${envKey} environment variable) or have this channel use another model`,
        )
      }
      return { key: credential.access, oauth: true }
    }
    const key = configured() ?? (envKey ? env[envKey] : undefined)
    if (key) return { key, oauth: false }
    if (oauth && isLocalOnlyOAuthBlocked(ctx)) {
      const channel = ctx.channel() ?? 'this channel'
      throw new Error(
        `${oauth.name} is only for the local terminal, not for ${channel}; give ${name} an API key (/login ${name} → Enter an API key, or the ${envKey} environment variable) or have this channel use another model`,
      )
    }
    const envVarName = pureEnvVarName(config.apiKey)
    const ways = [
      ...(oauth || builtin ? [`run /login ${name}`] : []),
      ...(envVarName
        ? [`set the ${envVarName} environment variable`]
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
      const spec =
        config.models?.find((m) => m.id === id) ?? catalogLookup(name, id)
      const compat = { ...config.compat, ...spec?.compat }
      if (
        compat.hostedTools?.includes('web_search') &&
        api === 'openai-completions'
      )
        throw new Error(
          `${file}: hosted web_search is not supported for openai-completions`,
        )
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
      const configuredBaseUrl = read(config.baseUrl)
      const settings = {
        apiKey: MANAGED_KEY,
        baseURL:
          configuredBaseUrl ??
          (api === 'anthropic-messages'
            ? 'https://api.anthropic.com/v1'
            : 'https://api.openai.com/v1'),
        headers,
        name,
        fetch: fetchWithAuth as typeof globalThis.fetch,
      }
      const defaultHosted =
        !configuredBaseUrl &&
        ((name === 'anthropic' && builtin && api === 'anthropic-messages') ||
          (name === 'openai' && builtin && api === 'openai-responses'))
      const supportsHosted =
        compat.hostedTools === undefined
          ? defaultHosted
          : compat.hostedTools.includes('web_search')
      const declareHosted = (model: Exclude<LanguageModel, string>) => {
        if (!supportsHosted) return model
        return Object.assign(model, {
          hostedTools: async (options?: { reasoning?: string }) => {
            if (
              api === 'openai-responses' &&
              (spec?.thinkingLevelMap?.[
                options?.reasoning === 'none'
                  ? 'off'
                  : ((options?.reasoning ?? 'off') as keyof NonNullable<
                      ModelSpec['thinkingLevelMap']
                    >)
              ] ?? options?.reasoning) === 'minimal'
            )
              return {}
            try {
              const auth = await requestKey(ctx)
              if (auth.oauth) return {}
              return api === 'anthropic-messages'
                ? {
                    web_search: anthropic.tools.webSearch_20250305({
                      maxUses: 1,
                    }),
                  }
                : { web_search: openai.tools.webSearch({}) }
            } catch {
              return {}
            }
          },
        })
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
      ) {
        return typeof model === 'string' ? model : declareHosted(model)
      }
      const wrapped = wrapLanguageModel({
        model,
        middleware: {
          specificationVersion: 'v4',
          ...(api === 'openai-responses' && compat.deepseekReasoningStream
            ? { wrapStream: deepseekReasoningStream }
            : {}),
          transformParams: async ({ params }) => {
            if (api === 'openai-responses') {
              const openai = { ...params.providerOptions?.openai }
              if (compat.store !== undefined && openai.store === undefined)
                openai.store = compat.store
              if (
                compat.includeWebSearchSources !== undefined &&
                openai.includeWebSearchSources === undefined
              )
                openai.includeWebSearchSources = compat.includeWebSearchSources
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
              // pi's supportsDeveloperRole: false keeps the system instruction's role.
              if (
                compat.supportsDeveloperRole === false &&
                openai.systemMessageMode === undefined
              )
                openai.systemMessageMode = 'system'
              params = {
                ...params,
                providerOptions: { ...params.providerOptions, openai },
              }
            }
            // The OAuth route's requirements remain authoritative over caller/default options.
            const blockedLocalOAuth = Boolean(
              oauthRequests?.localOnly && isRemoteChannel(ctx.channel()),
            )
            return transform &&
              !blockedLocalOAuth &&
              (await ctx.credential())?.type === 'oauth'
              ? transform(params)
              : params
          },
        },
      })
      return declareHosted(wrapped)
    },
  }
}
