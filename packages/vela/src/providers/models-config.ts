import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { anthropic, createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI, openai } from '@ai-sdk/openai'
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider'
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
  type ProviderContext,
  type ProviderDefinition,
} from './models/index.ts'

export type { ProviderConfig } from '../shared/provider-types.ts'

const anthropicProtocolModels = new WeakSet<object>()

/** Marks a resolved or wrapped LanguageModel as using the `anthropic-messages` protocol. */
export function markAnthropicMessagesModel<T extends object>(model: T): T {
  anthropicProtocolModels.add(model)
  return model
}

/** Whether a resolved LanguageModel was created for an `anthropic-messages` provider regardless of provider name. */
export function isAnthropicMessagesModel(model: unknown): boolean {
  return (
    typeof model === 'object' &&
    model !== null &&
    anthropicProtocolModels.has(model)
  )
}

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
      if (oauthRequests?.localOnly && channel) {
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
      const registerProtocol = <T extends LanguageModel>(resolved: T): T => {
        if (api === 'anthropic-messages' && typeof resolved !== 'string')
          anthropicProtocolModels.add(resolved)
        return resolved
      }
      const transform = oauthRequests?.transformParams
      if (
        (api !== 'openai-responses' &&
          api !== 'openai-completions' &&
          !transform) ||
        typeof model === 'string'
      ) {
        return typeof model === 'string'
          ? model
          : registerProtocol(declareHosted(model))
      }
      const responsesOptionsKey = name.includes('azure') ? 'azure' : 'openai'
      const stripStatelessWrapStream: LanguageModelV4Middleware['wrapStream'] =
        api === 'openai-responses'
          ? async (options) => {
              const streamResult =
                compat.deepseekReasoningStream && deepseekReasoningStream
                  ? await deepseekReasoningStream(options)
                  : await options.doStream()
              if (
                !isStatelessResponsesCall(options.params, responsesOptionsKey)
              )
                return streamResult
              return {
                ...streamResult,
                stream: streamResult.stream.pipeThrough(
                  new TransformStream<
                    LanguageModelV4StreamPart,
                    LanguageModelV4StreamPart
                  >({
                    transform(part, controller) {
                      controller.enqueue(stripStatelessStreamPartItemId(part))
                    },
                  }),
                ),
              }
            }
          : undefined
      const wrapped = wrapLanguageModel({
        model,
        middleware: {
          specificationVersion: 'v4',
          ...(stripStatelessWrapStream
            ? {
                wrapGenerate: async ({ doGenerate, params }) => {
                  const res = await doGenerate()
                  if (!isStatelessResponsesCall(params, responsesOptionsKey))
                    return res
                  return {
                    ...res,
                    content: res.content.map(stripStatelessContentItemId),
                  }
                },
                wrapStream: stripStatelessWrapStream,
              }
            : {}),
          transformParams: async ({ params }) => {
            if (api === 'openai-responses' || api === 'openai-completions') {
              const openai = { ...params.providerOptions?.openai }
              if (api === 'openai-responses') {
                if (compat.store !== undefined && openai.store === undefined)
                  openai.store = compat.store
                if (
                  compat.includeWebSearchSources !== undefined &&
                  openai.includeWebSearchSources === undefined
                )
                  openai.includeWebSearchSources =
                    compat.includeWebSearchSources
              }
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
              oauthRequests?.localOnly && Boolean(ctx.channel()),
            )
            let finalParams =
              transform &&
              !blockedLocalOAuth &&
              (await ctx.credential())?.type === 'oauth'
                ? transform(params)
                : params
            if (api === 'openai-responses') {
              const stateless = isStatelessResponsesCall(
                finalParams,
                responsesOptionsKey,
              )
              finalParams = prepareResponsesPrompt(finalParams, stateless)
            }
            return finalParams
          },
        },
      })
      return registerProtocol(declareHosted(wrapped))
    },
  }
}

const RESPONSES_OPTION_KEYS = ['openai', 'azure'] as const

function isStatelessResponsesCall(
  params: LanguageModelV4CallOptions,
  responsesOptionsKey: 'openai' | 'azure',
): boolean {
  const opts = params.providerOptions as
    | Record<string, Record<string, unknown> | undefined>
    | undefined
  return (
    opts?.[responsesOptionsKey]?.store === false ||
    opts?.openai?.store === false
  )
}

function editResponsesProviderOptions<
  T extends Record<string, unknown> | undefined,
>(
  opts: T,
  shouldStripItemId: (nsOpts: Record<string, unknown>) => boolean,
  stripVela = false,
): T {
  if (!opts) return opts
  let changed = false
  const out: Record<string, unknown> = { ...opts }
  if (stripVela && 'vela' in out) {
    delete out.vela
    changed = true
  }
  for (const key of RESPONSES_OPTION_KEYS) {
    const ns = out[key] as Record<string, unknown> | undefined
    if (!ns || !shouldStripItemId(ns)) continue
    changed = true
    const { itemId: _, ...restNs } = ns
    if (Object.keys(restNs).length > 0) out[key] = restNs
    else delete out[key]
  }
  if (!changed) return opts
  return (Object.keys(out).length > 0 ? out : undefined) as T
}

function withStatelessTag(
  meta: Record<string, unknown> | undefined,
  markStateless: boolean,
): Record<string, unknown> | undefined {
  const cleaned = editResponsesProviderOptions(
    meta,
    (ns) => typeof ns.itemId === 'string',
  )
  if (!markStateless) return cleaned
  return { ...cleaned, vela: { stored: false } }
}

function isStatelessHostedPart(part: {
  type: string
  providerExecuted?: boolean
}): boolean {
  return (
    ((part.type === 'tool-call' || part.type === 'tool-input-start') &&
      part.providerExecuted === true) ||
    part.type === 'tool-result'
  )
}

function stripStatelessContentItemId<
  T extends {
    type: string
    providerExecuted?: boolean
    providerMetadata?: Record<string, unknown>
  },
>(part: T): T {
  const markStateless = isStatelessHostedPart(part)
  if (!part.providerMetadata && !markStateless) return part
  const next = withStatelessTag(part.providerMetadata, markStateless)
  if (next === part.providerMetadata) return part
  if (next !== undefined) return { ...part, providerMetadata: next }
  const { providerMetadata: _, ...plain } = part
  return plain as T
}

function stripStatelessStreamPartItemId(
  part: LanguageModelV4StreamPart,
): LanguageModelV4StreamPart {
  const providerExecuted =
    'providerExecuted' in part ? part.providerExecuted : undefined
  const markStateless = isStatelessHostedPart({
    type: part.type,
    providerExecuted,
  })
  const currentMeta =
    'providerMetadata' in part
      ? (part.providerMetadata as Record<string, unknown> | undefined)
      : undefined
  if (!currentMeta && !markStateless) return part
  const next = withStatelessTag(currentMeta, markStateless)
  if (next === currentMeta) return part
  if (next !== undefined)
    return {
      ...part,
      providerMetadata: next,
    } as LanguageModelV4StreamPart
  const { providerMetadata: _, ...plain } =
    part as LanguageModelV4StreamPart & {
      providerMetadata?: unknown
    }
  return plain as LanguageModelV4StreamPart
}

function isVelaStatelessPart(part: { providerOptions?: unknown }): boolean {
  const vela = (
    part.providerOptions as { vela?: { stored?: unknown } } | undefined
  )?.vela
  return vela?.stored === false
}

function formatHostedResult(output: unknown): string {
  const value = JSON.stringify(output, (key, val) =>
    key === 'encrypted_content' || key === 'encryptedContent' ? undefined : val,
  )
  return value ?? 'unavailable'
}

/**
 * Prepares OpenAI Responses prompt history across store modes:
 * - On `store: false`, strips unencrypted `rs_...` `itemId`s so OpenAI never emits broken `item_reference`s.
 * - On `store !== false`, converts hosted parts recorded during `store: false` into plain text so the SDK
 *   does not emit `item_reference` from `part.toolCallId`, and strips internal `vela` metadata.
 */
function prepareResponsesPrompt(
  params: LanguageModelV4CallOptions,
  statelessTarget: boolean,
): LanguageModelV4CallOptions {
  if (!Array.isArray(params.prompt)) return params
  let changed = false
  const statelessHostedIds = new Set<string>()
  if (!statelessTarget) {
    for (const message of params.prompt) {
      if (message.role !== 'assistant' || !Array.isArray(message.content))
        continue
      for (const part of message.content) {
        if (
          (part.type === 'tool-call' || part.type === 'tool-result') &&
          isVelaStatelessPart(part)
        ) {
          statelessHostedIds.add(part.toolCallId)
        }
      }
    }
  }
  const prompt = params.prompt.flatMap((message) => {
    if (message.role === 'tool' && Array.isArray(message.content)) {
      let msgChanged = false
      const nextParts = message.content.flatMap((part) => {
        if (
          part.type === 'tool-result' &&
          (statelessHostedIds.has(part.toolCallId) || isVelaStatelessPart(part))
        ) {
          msgChanged = true
          changed = true
          return []
        }
        const cleaned = editResponsesProviderOptions(
          part.providerOptions as Record<string, unknown> | undefined,
          () => false,
          true,
        )
        if (cleaned !== part.providerOptions) {
          msgChanged = true
          changed = true
          if (cleaned !== undefined)
            return [
              {
                ...part,
                providerOptions:
                  cleaned as LanguageModelV4CallOptions['providerOptions'],
              },
            ]
          const { providerOptions: _, ...plain } = part
          return [plain]
        }
        return [part]
      })
      if (!nextParts.length) return []
      return msgChanged ? [{ ...message, content: nextParts }] : [message]
    }
    if (message.role !== 'assistant' || !Array.isArray(message.content))
      return [message]
    let partChanged = false
    const resultById = new Map<string, unknown>()
    if (!statelessTarget && statelessHostedIds.size > 0) {
      for (const part of message.content) {
        if (
          part.type === 'tool-result' &&
          statelessHostedIds.has(part.toolCallId)
        )
          resultById.set(part.toolCallId, part.output)
      }
    }
    const content = message.content.flatMap((part) => {
      if (!statelessTarget) {
        if (
          part.type === 'tool-call' &&
          statelessHostedIds.has(part.toolCallId)
        ) {
          partChanged = true
          changed = true
          const resultText = resultById.has(part.toolCallId)
            ? `\nProvider ${part.toolName} result: ${formatHostedResult(resultById.get(part.toolCallId))}`
            : ''
          return [
            {
              type: 'text' as const,
              text: `Provider ${part.toolName}: ${JSON.stringify(part.input)}${resultText}`,
            },
          ]
        }
        if (
          part.type === 'tool-result' &&
          statelessHostedIds.has(part.toolCallId)
        ) {
          partChanged = true
          changed = true
          return []
        }
      }
      const next = editResponsesProviderOptions(
        part.providerOptions as Record<string, unknown> | undefined,
        (ns) =>
          statelessTarget &&
          typeof ns.itemId === 'string' &&
          ns.itemId.startsWith('rs_') &&
          (typeof ns.reasoningEncryptedContent !== 'string' ||
            ns.reasoningEncryptedContent.length === 0),
        true,
      )
      if (next === part.providerOptions) return [part]
      partChanged = true
      changed = true
      if (next !== undefined)
        return [
          {
            ...part,
            providerOptions:
              next as LanguageModelV4CallOptions['providerOptions'],
          },
        ]
      const { providerOptions: __, ...plain } = part
      return [plain]
    })
    return [partChanged ? { ...message, content } : message]
  })
  return changed
    ? ({ ...params, prompt } as LanguageModelV4CallOptions)
    : params
}
