import type { LanguageModel } from 'ai'
import { resolveCredential } from '../auth/resolve.ts'
import { memoryCredentialStore } from '../auth/store.ts'
import type {
  AuthInteraction,
  Credential,
  CredentialStore,
  LoginOptions,
  OAuthLogin,
} from '../auth/types.ts'
import { DEFAULT_LIMITS, type VelaLimits } from '../limits.ts'
import type { ModelPricing } from '../usage/tracker.ts'
import { catalogLookup } from './catalog.ts'

/** Default thinking level (like pi). */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium'

/** Thinking level (like pi). Maps to the AI SDK `reasoning` call option. */
export type ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/** Model metadata (a models.json model entry or a catalog entry, same field names as pi). */
export interface ModelSpec {
  id: string
  /** Display name */
  name?: string
  /** Context window in tokens; when set, compaction thresholds and the input cap derive from it */
  contextWindow?: number
  /** Maximum output tokens */
  maxTokens?: number
  /** Whether thinking is supported; false limits the thinking level to `off` */
  reasoning?: boolean
  /**
   * Provider value per thinking level (pi's thinkingLevelMap); `null` marks a level the model doesn't support.
   * `xhigh` and `max` are only offered when listed here.
   */
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>
  /** Input types (`text`, `image`) */
  input?: string[]
  /** Price in $ / 1M tokens; used for usage stats when set */
  cost?: ModelPricing
}

/** One entry of `vela.models()`; `ref` is `provider/id`. */
export interface ModelInfo extends ModelSpec {
  provider: string
  ref: string
}

/** What createModel() gets besides the id. */
export interface ProviderContext {
  /** Provider name */
  provider: string
  /**
   * The credential stored for this provider with `/login` (`auth.json`), its OAuth token refreshed first when it
   * is about to expire. Call it per request (e.g. in a custom fetch), not once: tokens expire and `/login` can
   * change them while the model is in use. Throws when a refresh fails.
   */
  credential(): Promise<Credential | undefined>
}

/**
 * A model provider: lists known models and creates AI SDK LanguageModels by id. Unlisted ids work too, with
 * metadata from the built-in catalog when it knows the id.
 */
export interface ProviderDefinition {
  models?: ModelSpec[]
  /** Model id used when nothing else picks a model and this provider is the first one with a credential (like pi) */
  defaultModel?: string
  /** `/login` sign-in (pi's registerProvider `oauth`) */
  oauth?: OAuthLogin
  /** `/login` can store an API key for this provider (the provider reads it with `ctx.credential()`) */
  apiKeyLogin?: boolean
  /**
   * Where this provider's credential comes from (`auth.json`, `OPENAI_API_KEY`, …), or undefined when it has none.
   * Providers without credentials are left out of `/model`, `--list-models` and model cycling (like pi).
   * Without this function a provider counts as always configured.
   */
  authSource?(credential: Credential | undefined): string | undefined
  createModel(id: string, ctx: ProviderContext): LanguageModel
}

/** A provider `/login` can sign in to. */
export interface LoginProvider {
  provider: string
  /** OAuth sign-in, when the provider has one */
  oauth?: string
  /** Whether an API key can be stored */
  apiKey: boolean
  /** Current credential source, when configured */
  source?: string
}

/** Default model of each built-in provider, in pi's preference order */
export const DEFAULT_PROVIDER_ORDER = ['anthropic', 'openai', 'openrouter']

export interface ResolvedModel {
  model: LanguageModel
  info: ModelInfo
}

const PROVIDER_NAME = /^[A-Za-z0-9][\w.-]*$/

/**
 * Provider registry fed by createVela's `providers`, models.json and extensions' registerProvider. It also holds
 * the credentials `/login` stores (the CLI's `~/.vela/auth.json`), shared by every session of a Vela.
 */
export class ModelRegistry {
  private readonly providers = new Map<string, ProviderDefinition>()
  readonly credentials: CredentialStore

  constructor(
    providers: Record<string, ProviderDefinition> = {},
    credentials: CredentialStore = memoryCredentialStore(),
  ) {
    this.credentials = credentials
    for (const [name, provider] of Object.entries(providers))
      this.register(name, provider)
  }

  register(name: string, provider: ProviderDefinition): void {
    if (!PROVIDER_NAME.test(name))
      throw new Error(`Invalid provider name "${name}"`)
    if (this.providers.has(name))
      throw new Error(`Provider ${name} is already registered`)
    this.providers.set(name, provider)
  }

  /** Where a provider's credential comes from, or undefined when it has none */
  authSource(name: string): string | undefined {
    const def = this.providers.get(name)
    if (!def) return
    if (!def.authSource) return 'configured'
    return def.authSource(this.credentials.get(name))
  }

  /** Models listed by all providers, configured or not */
  list(): ModelInfo[] {
    return [...this.providers].flatMap(([provider, def]) =>
      (def.models ?? []).map((spec) => ({
        ...spec,
        provider,
        ref: `${provider}/${spec.id}`,
      })),
    )
  }

  /** Models of providers that have a credential (what `/model` and `--list-models` show, like pi) */
  available(): ModelInfo[] {
    return this.list().filter((m) => this.authSource(m.provider) !== undefined)
  }

  /**
   * The model to use when none is chosen (pi's initial model): the default model of the first built-in provider
   * with a credential, else the first available model.
   */
  defaultRef(): string | undefined {
    const available = this.available()
    for (const provider of DEFAULT_PROVIDER_ORDER) {
      const id = this.providers.get(provider)?.defaultModel
      const found = available.find(
        (m) => m.provider === provider && m.id === id,
      )
      if (found) return found.ref
    }
    return available[0]?.ref
  }

  /** Providers `/login` can sign in to */
  loginProviders(): LoginProvider[] {
    return [...this.providers]
      .filter(([, def]) => def.oauth || def.apiKeyLogin)
      .map(([provider, def]) => ({
        provider,
        ...(def.oauth ? { oauth: def.oauth.name } : {}),
        apiKey: def.apiKeyLogin === true,
        ...(this.authSource(provider)
          ? { source: this.authSource(provider) }
          : {}),
      }))
  }

  /**
   * Signs in to a provider and stores the credential (`/login`): `oauth` runs its OAuth flow, `api_key` asks for
   * a key. The new credential replaces the stored one.
   */
  async login(
    provider: string,
    method: 'oauth' | 'api_key',
    interaction: AuthInteraction,
    options: LoginOptions = {},
  ): Promise<void> {
    const def = this.providers.get(provider)
    if (!def) throw new Error(`No provider named ${provider}`)
    let credential: Credential
    if (method === 'oauth') {
      if (!def.oauth)
        throw new Error(`Provider ${provider} has no OAuth sign-in`)
      credential = await def.oauth.login(interaction, {
        ...options,
        previous: this.credentials.get(provider),
      })
    } else {
      if (!def.apiKeyLogin)
        throw new Error(`Provider ${provider} does not take a stored API key`)
      const key = (
        await interaction.prompt({
          type: 'secret',
          message: `API key for ${provider}`,
        })
      ).trim()
      if (!key) throw new Error('No API key entered')
      credential = { type: 'api_key', key }
    }
    interaction.signal.throwIfAborted()
    await this.credentials.modify(provider, async () => credential)
  }

  /** Removes the stored credential (`/logout`); environment variables and models.json keys are untouched */
  async logout(provider: string): Promise<boolean> {
    if (!this.credentials.get(provider)) return false
    await this.credentials.delete(provider)
    return true
  }

  /** `provider/id` → model; the id may contain more `/` (e.g. `openrouter/anthropic/claude`). */
  resolve(ref: string): ResolvedModel {
    const slash = ref.indexOf('/')
    if (slash <= 0 || slash === ref.length - 1)
      throw new Error(`Model must be provider/id, got "${ref}"`)
    const provider = ref.slice(0, slash)
    const id = ref.slice(slash + 1)
    const def = this.providers.get(provider)
    if (!def)
      throw new Error(
        `No provider named ${provider} (available: ${[...this.providers.keys()].join(', ') || 'none'})`,
      )
    const { api: _, ...catalog } = catalogLookup(provider, id) ?? { id }
    const spec = def.models?.find((m) => m.id === id) ?? catalog
    return {
      model: def.createModel(id, {
        provider,
        credential: () =>
          resolveCredential(this.credentials, provider, def.oauth),
      }),
      info: { ...spec, provider, ref: `${provider}/${id}` },
    }
  }
}

/** Metadata for a LanguageModel passed in directly (e.g. the test faux); no ref. */
export function describeModel(model: LanguageModel): ModelInfo {
  if (typeof model === 'string') return { provider: '', id: model, ref: model }
  // AI SDK providers name themselves `anthropic.messages`, `openai.responses`, …: look the id up in the catalog
  const { api: _, ...known } = catalogLookup(
    model.provider.split('.')[0] as string,
    model.modelId,
  ) ?? { id: model.modelId }
  return {
    ...known,
    provider: model.provider,
    id: model.modelId,
    ref: `${model.provider}/${model.modelId}`,
  }
}

/**
 * Thinking level → AI SDK `reasoning`. The level is already clamped to what the model supports (see
 * `clampThinkingLevel`), so `off` on a model without thinking sends nothing; models with thinking get `none`.
 */
export function reasoningOption(
  level: ThinkingLevel,
  info: ModelInfo,
):
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | undefined {
  if (level === 'off') return info.reasoning === false ? undefined : 'none'
  return level
}

/** Tokens reserved for output (pi compaction's default reserveTokens) */
export const RESERVE_TOKENS = 16_384

/**
 * Derives compaction thresholds and the input cap from the model's context window (a 200k
 * window yields the defaults): input cap = window − 16384 (like pi); summary threshold = 75% of
 * the window, but at least 10% of the window below the input cap (the summary request must fit).
 * Defaults apply without contextWindow. `overrides` (explicit limits from createVela / settings) win.
 */
export function limitsForModel(
  info: Pick<ModelSpec, 'contextWindow'>,
  overrides: Partial<VelaLimits> = {},
): VelaLimits {
  const window = info.contextWindow
  let derived: Partial<VelaLimits> = {}
  if (window) {
    // Windows under 2 × 16384 (rare) reserve at most half, so the input cap never hits 0
    const maxInputTokens = Math.max(
      window - RESERVE_TOKENS,
      Math.floor(window / 2),
    )
    const summaryThreshold = Math.min(
      Math.floor(window * 0.75),
      maxInputTokens - Math.floor(window * 0.1),
    )
    derived = {
      maxInputTokens,
      summaryThreshold,
      microcompactThreshold: Math.min(
        Math.floor(window * 0.6),
        Math.floor(summaryThreshold * 0.8),
      ),
      minMicroSavings: Math.floor(window * 0.1),
    }
  }
  const limits = { ...DEFAULT_LIMITS, ...derived }
  for (const [key, value] of Object.entries(overrides))
    if (value !== undefined) limits[key as keyof VelaLimits] = value
  return limits
}
