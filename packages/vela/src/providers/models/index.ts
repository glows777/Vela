import {
  applyLimits,
  DEFAULT_LIMITS,
  type VelaLimits,
} from '../../shared/limits.ts'
import type { OAuthRegistration } from '../../shared/oauth-registration.ts'
import type { ModelHandle, ModelInput } from '../../shared/provider-types.ts'
import { resolveCredential } from '../auth/resolve.ts'
import { memoryCredentialStore } from '../auth/store.ts'
import type {
  AuthInteraction,
  Credential,
  CredentialStore,
  LoginOptions,
  LogoutOptions,
  LogoutResult,
  OAuthLogin,
  OAuthRegistrationStore,
} from '../auth/types.ts'
import { MODEL_CATALOG } from './catalog.generated.ts'
import type { CatalogModel, ModelSpec, ThinkingLevel } from './catalog.ts'

export type { ModelCompat, ModelSpec, ThinkingLevel } from './catalog.ts'
export { DEFAULT_THINKING_LEVEL, THINKING_LEVELS } from './catalog.ts'

/** Catalog models of one provider (empty for providers the catalog doesn't know). */
export function catalogModels(provider: string): CatalogModel[] {
  return MODEL_CATALOG[provider] ?? []
}

/**
 * Catalog metadata for a model: the same provider and id first, then the same id under any catalog provider
 * (so a models.json provider serving a well-known model still gets its context window and price).
 */
export function catalogLookup(
  provider: string,
  id: string,
): CatalogModel | undefined {
  const own = MODEL_CATALOG[provider]?.find((m) => m.id === id)
  if (own) return own
  for (const models of Object.values(MODEL_CATALOG)) {
    const found = models.find((m) => m.id === id)
    if (found) return found
  }
}

/** One entry of `vela.models()`; `ref` is `provider/id`. */
export interface ModelInfo extends ModelSpec {
  provider: string
  ref: string
  /** The plan paying for this model, e.g. `ChatGPT plan`, when a subscription sign-in funds the provider */
  planLabel?: string
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
  /** The channel the requesting session answers on (e.g. `lark`), undefined for local sessions; read per request */
  channel(): string | undefined
}

const localOnlyOAuthChecks = new WeakMap<ProviderContext, () => boolean>()
const managedModelRefs = new WeakMap<ModelHandle, string>()
const managedModelOwners = new WeakMap<ModelHandle, ModelRegistry>()
const localOnlyChannelRebinders = new WeakMap<
  ModelHandle,
  (channel: () => string | undefined) => ResolvedModel
>()

/** @internal True when this request's channel session withheld a `localOnly` OAuth token. */
export function isLocalOnlyOAuthBlocked(ctx: ProviderContext): boolean {
  return localOnlyOAuthChecks.get(ctx)?.() ?? false
}

/** Returns `provider/id` when `model` was resolved by a `ModelRegistry`. */
function managedModelRef(model: ModelInput): string | undefined {
  return typeof model === 'object' && model !== null
    ? managedModelRefs.get(model)
    : undefined
}

/** Optional provider-hosted equivalents for Vela tools, resolved for each request. */
export type HostedToolModel = ModelHandle & {
  hostedTools?: (options?: {
    reasoning?: string
  }) => Promise<Record<string, unknown>>
}

/**
 * A model provider: lists known models and creates model handles by id. Unlisted ids work too, with
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
  createModel(id: string, ctx: ProviderContext): ModelInput | HostedToolModel
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
  /** Whether non-token OAuth client registration metadata is saved in `vela.db`. */
  hasRegistration?: boolean
}

/** Default model of each built-in provider, in pi's preference order */
const DEFAULT_PROVIDER_ORDER = ['anthropic', 'openai', 'openrouter', 'deepseek']

export interface ResolvedModel {
  model: ModelInput
  info: ModelInfo
}

const PROVIDER_NAME = /^[A-Za-z0-9][\w.-]*$/

/**
 * Provider registry fed by createVela's `providers`, models.json and extensions' registerProvider. It also holds
 * the credentials `/login` stores (the CLI's `~/.vela/auth.json`), shared by every session of a Vela.
 */
export class ModelRegistry {
  private readonly providers = new Map<string, ProviderDefinition>()
  private readonly authQueues = new Map<string, Promise<unknown>>()
  readonly credentials: CredentialStore

  constructor(
    providers: Record<string, ProviderDefinition> = {},
    credentials: CredentialStore = memoryCredentialStore(),
    private readonly registrations?: OAuthRegistrationStore,
  ) {
    this.credentials = credentials
    for (const [name, provider] of Object.entries(providers))
      this.register(name, provider)
  }

  private serializeAuth<T>(
    provider: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const run = (this.authQueues.get(provider) ?? Promise.resolve()).then(
      task,
      task,
    )
    const tail = run.catch(() => {})
    this.authQueues.set(provider, tail)
    void tail.then(() => {
      if (this.authQueues.get(provider) === tail) {
        this.authQueues.delete(provider)
      }
    })
    return run
  }

  hasProvider(name: string): boolean {
    return this.providers.has(name)
  }

  register(name: string, provider: ProviderDefinition): void {
    if (!PROVIDER_NAME.test(name))
      throw new Error(`Invalid provider name "${name}"`)
    if (this.providers.has(name))
      throw new Error(`Provider ${name} is already registered`)
    this.providers.set(name, provider)
  }

  /** Update a user-configured provider after a successful setup. */
  configure(name: string, provider: ProviderDefinition): void {
    if (!PROVIDER_NAME.test(name))
      throw new Error(`Invalid provider name "${name}"`)
    this.providers.set(name, provider)
  }

  /** Where a provider's credential comes from, or undefined when it has none */
  authSource(name: string, channel?: string): string | undefined {
    const def = this.providers.get(name)
    if (!def) return
    if (!def.authSource) return 'configured'
    const stored = this.credentials.get(name)
    if (channel && def.oauth?.localOnly && stored?.type === 'oauth') {
      return def.authSource(undefined)
    }
    return def.authSource(stored)
  }

  /**
   * The plan paying for a provider's requests (e.g. `ChatGPT plan`), when the stored credential is a subscription
   * sign-in rather than an API key and not blocked by a remote channel; undefined otherwise.
   */
  planLabel(provider: string, channel?: string): string | undefined {
    const oauth = this.providers.get(provider)?.oauth
    if (!oauth?.isSubscription) return
    if (oauth.localOnly && channel) return
    if (this.credentials.get(provider)?.type !== 'oauth') return
    return oauth.planLabel
  }

  /** Effective credential mode for a provider/channel pair (`oauth` vs `api_key`). */
  authMode(
    provider: string,
    channel?: string,
  ): 'oauth' | 'api_key' | undefined {
    const def = this.providers.get(provider)
    const stored = this.credentials.get(provider)
    if (stored?.type === 'oauth') {
      if (def?.oauth?.localOnly && channel) {
        return this.authSource(provider, channel) ? 'api_key' : undefined
      }
      return 'oauth'
    }
    if (stored?.type === 'api_key') return 'api_key'
    return this.authSource(provider, channel) ? 'api_key' : undefined
  }

  /** Models listed by all providers, configured or not, with live `planLabel`. */
  list(channel?: string): ModelInfo[] {
    return [...this.providers].flatMap(([provider, def]) => {
      const planLabel = this.planLabel(provider, channel)
      return (def.models ?? []).map((spec) => ({
        ...spec,
        provider,
        ref: `${provider}/${spec.id}`,
        ...(planLabel ? { planLabel } : {}),
      }))
    })
  }

  /** Models of providers that have a credential (what `/model` and `--list-models` show, like pi) */
  available(channel?: string): ModelInfo[] {
    return this.list(channel).filter(
      (m) => this.authSource(m.provider, channel) !== undefined,
    )
  }

  /**
   * The model to use when none is chosen (pi's initial model): the default model of the first built-in provider
   * with a credential, else the first available model.
   */
  defaultRef(channel?: string): string | undefined {
    const available = this.available(channel)
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
        ...(this.registrations?.get(provider) ? { hasRegistration: true } : {}),
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
    let resolvedDeviceId: string | undefined
    const rawGetDeviceId = options.getDeviceId
    const getMemoizedDeviceId = rawGetDeviceId
      ? (): string => {
          resolvedDeviceId ??= rawGetDeviceId()
          return resolvedDeviceId
        }
      : undefined
    let credential: Credential
    if (method === 'oauth') {
      if (!def.oauth)
        throw new Error(`Provider ${provider} has no OAuth sign-in`)
      const registration = this.registrations?.get(provider)
      credential = await def.oauth.login(interaction, {
        ...options,
        ...(getMemoizedDeviceId ? { getDeviceId: getMemoizedDeviceId } : {}),
        previous: this.credentials.get(provider),
        ...(registration ? { registration } : {}),
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
    await this.serializeAuth(provider, async () => {
      const nextRegistration =
        credential.type === 'oauth' &&
        typeof credential.clientId === 'string' &&
        credential.clientId
          ? {
              clientId: credential.clientId,
              ...(resolvedDeviceId ? { hostId: resolvedDeviceId } : {}),
              ...(typeof credential.subject === 'string' && credential.subject
                ? { subject: credential.subject }
                : {}),
            }
          : undefined
      let prevRegistration: OAuthRegistration | undefined
      let wroteRegistration = false
      try {
        await this.credentials.modify(provider, async () => {
          interaction.signal.throwIfAborted()
          if (nextRegistration && this.registrations) {
            prevRegistration = this.registrations.get(provider)
            this.registrations.set(provider, nextRegistration)
            wroteRegistration = true
          }
          return credential
        })
      } catch (error) {
        if (wroteRegistration && this.registrations) {
          try {
            if (prevRegistration) {
              this.registrations.set(provider, prevRegistration)
            } else {
              this.registrations.delete(provider)
            }
          } catch {
            /* preserve original error */
          }
        }
        throw error
      }
    })
  }

  /**
   * Removes the stored credential (`/logout`). An OAuth sign-in that supports it revokes its session at the
   * provider first; when that fails the credential is removed anyway and `notice` says so. Non-token OAuth
   * client registration metadata is retained unless `forget: true`. Environment variables and config.json keys
   * are untouched.
   */
  async logout(
    provider: string,
    options: LogoutOptions = {},
  ): Promise<LogoutResult> {
    options.signal?.throwIfAborted()
    return this.serializeAuth(provider, async () => {
      options.signal?.throwIfAborted()
      const credential = this.credentials.get(provider)
      if (!credential) {
        const forgotten = options.forget
          ? Boolean(this.registrations?.delete(provider))
          : false
        return {
          removed: false,
          ...(forgotten ? { forgotten: true } : {}),
        }
      }
      if (!this.credentials.deleteIf) {
        return {
          removed: false,
          notice: `Could not log out ${provider}: credential store does not support atomic conditional deletion.`,
        }
      }
      let notice: string | undefined
      const revoke = this.providers.get(provider)?.oauth?.logout
      if (credential.type === 'oauth' && revoke) {
        try {
          await revoke(
            credential,
            options.signal ?? new AbortController().signal,
          )
        } catch (error) {
          if (options.signal?.aborted) throw options.signal.reason ?? error
          notice = `Could not confirm that ${provider} revoked this sign-in at the provider; the credential is removed locally.`
        }
      }
      const prevRegistration = this.registrations?.get(provider)
      let forgotten = false
      let backfilled = false
      if (options.forget) {
        forgotten = Boolean(this.registrations?.delete(provider))
      } else if (
        credential.type === 'oauth' &&
        typeof credential.clientId === 'string' &&
        credential.clientId &&
        !prevRegistration &&
        this.registrations
      ) {
        this.registrations.set(provider, {
          clientId: credential.clientId,
          ...(typeof credential.hostId === 'string' && credential.hostId
            ? { hostId: credential.hostId }
            : {}),
          ...(typeof credential.subject === 'string' && credential.subject
            ? { subject: credential.subject }
            : {}),
        })
        backfilled = true
      }
      let removed: boolean
      try {
        removed = await this.credentials.deleteIf(provider, (current) =>
          sameCredential(credential, current),
        )
      } catch (error) {
        if (
          options.forget &&
          forgotten &&
          prevRegistration &&
          this.registrations
        ) {
          try {
            this.registrations.set(provider, prevRegistration)
          } catch {
            /* preserve original error */
          }
        } else if (backfilled && this.registrations) {
          try {
            this.registrations.delete(provider)
          } catch {
            /* preserve original error */
          }
        }
        throw error
      }
      if (!removed && this.registrations) {
        if (
          options.forget &&
          forgotten &&
          prevRegistration &&
          this.credentials.get(provider)
        ) {
          this.registrations.set(provider, prevRegistration)
          forgotten = false
        } else if (backfilled && this.credentials.get(provider)) {
          this.registrations.delete(provider)
        }
      }
      return {
        removed,
        ...(forgotten ? { forgotten: true } : {}),
        ...(notice ? { notice } : {}),
      }
    })
  }

  /** `provider/id` → model; the id may contain more `/` (e.g. `openrouter/anthropic/claude`). */
  resolve(
    ref: string,
    options: { channel?: () => string | undefined } = {},
  ): ResolvedModel {
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
    const ctx: ProviderContext = {
      provider,
      credential: async () => {
        if (def.oauth?.localOnly && options.channel?.()) {
          const stored = this.credentials.get(provider)
          if (stored?.type === 'api_key') return stored
          return undefined
        }
        return resolveCredential(this.credentials, provider, def.oauth)
      },
      channel: () => options.channel?.(),
    }
    localOnlyOAuthChecks.set(
      ctx,
      () =>
        Boolean(def.oauth?.localOnly && Boolean(options.channel?.())) &&
        this.credentials.get(provider)?.type === 'oauth',
    )
    const planLabel = this.planLabel(provider, options.channel?.())
    const model = def.createModel(id, ctx)
    if (typeof model === 'object' && model !== null) {
      managedModelRefs.set(model, `${provider}/${id}`)
      managedModelOwners.set(model, this)
      if (def.oauth?.localOnly) {
        localOnlyChannelRebinders.set(model, (channel) =>
          this.resolve(`${provider}/${id}`, { channel }),
        )
      }
    }
    return {
      model,
      info: {
        ...spec,
        provider,
        ref: `${provider}/${id}`,
        ...(planLabel ? { planLabel } : {}),
      },
    }
  }
}

/**
 * Resolves a string ref or pre-resolved `ModelHandle`, re-resolving same-registry
 * managed handles on channel sessions and blocking `localOnly` OAuth handles from
 * channels while preserving custom caller-supplied handles on local sessions.
 */
export function resolveModelInput(
  registry: ModelRegistry,
  input: ModelInput,
  channel?: () => string | undefined,
): ResolvedModel {
  if (typeof input === 'string') {
    return registry.resolve(input, { channel })
  }
  const activeChannel = channel?.()
  if (activeChannel && channel) {
    if (managedModelOwners.get(input) === registry) {
      const ref = managedModelRef(input)
      if (ref) {
        const provider = ref.slice(0, ref.indexOf('/'))
        if (registry.hasProvider(provider)) {
          return registry.resolve(ref, { channel })
        }
      }
    }
    const rebind = localOnlyChannelRebinders.get(input)
    if (rebind) {
      return rebind(channel)
    }
  }
  return { model: input, info: describeModel(input) }
}

function sameCredential(a: Credential, b: Credential): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'api_key' && b.type === 'api_key') return a.key === b.key
  if (a.type === 'oauth' && b.type === 'oauth')
    return a.refresh === b.refresh && a.access === b.access
  return false
}

/** Validate that a `ModelHandle` passed to the SDK is a runnable model instance. */
function assertRunnableModelHandle(model: ModelHandle): void {
  if (
    !model ||
    typeof model !== 'object' ||
    typeof (model as { doStream?: unknown }).doStream !== 'function'
  ) {
    throw new Error(
      'Invalid ModelHandle: pass a "provider/model" string, a handle returned by resolveModel()/loadModels(), or createFauxModel()',
    )
  }
}

/** Metadata for a model passed in directly (e.g. the test faux); no ref. */
export function describeModel(model: ModelInput): ModelInfo {
  if (typeof model === 'string') return { provider: '', id: model, ref: model }
  assertRunnableModelHandle(model)
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
const RESERVE_TOKENS = 16_384

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
    }
  }
  return applyLimits({ ...DEFAULT_LIMITS, ...derived }, overrides)
}

/** @experimental Resolve a model for recording without assembling sessions, tools or resources. */
export function resolveModel(
  ref: ModelInput | undefined,
  options: {
    providers?: Record<string, ProviderDefinition>
    credentials?: CredentialStore
  } = {},
): ModelInput {
  const registry = new ModelRegistry(options.providers, options.credentials)
  const choice = ref ?? registry.defaultRef()
  if (choice === undefined)
    throw new Error(
      'No model available. Sign in with /login in interactive mode, or set an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY or DEEPSEEK_API_KEY) and Vela picks a default model; or use --model provider/id, or set model in ~/.vela/config.json. For an offline demo use VELA_MODEL=mock.',
    )
  if (typeof choice === 'string') return registry.resolve(choice).model
  assertRunnableModelHandle(choice)
  return choice
}
