import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'

/** An API key stored with `/login` (pi's `api_key` credential). */
export interface ApiKeyCredential {
  type: 'api_key'
  key: string
}

/** OAuth tokens stored with `/login` (pi's `oauth` credential); providers may keep extra fields (e.g. `clientId`). */
export interface OAuthCredential {
  type: 'oauth'
  access: string
  refresh: string
  /** Expiry time in ms since the epoch */
  expires: number
  [key: string]: unknown
}

/** One credential per provider, the shape of an `auth.json` entry (same as pi). */
export type Credential = ApiKeyCredential | OAuthCredential

/**
 * Where credentials live, keyed by provider name. `modify` is the only write path: it runs `fn` on the current
 * credential while no other write to that provider can run (in this process, and across processes for the file
 * store), so an OAuth refresh with a rotating refresh token happens once. `fn` returns the new credential, or
 * undefined to leave it unchanged; `modify` resolves with the credential stored afterwards.
 */
export interface CredentialStore {
  /** The stored credential (possibly expired) */
  get(provider: string): Credential | undefined
  /** Providers that have a stored credential */
  list(): string[]
  modify(
    provider: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined>
  delete(provider: string): Promise<void>
}

/** A question asked during `/login` (pi's AuthPrompt). `select` resolves with the option id. */
export type AuthPrompt = { signal?: AbortSignal } & (
  | {
      type: 'text' | 'secret' | 'manual_code'
      message: string
      placeholder?: string
    }
  | {
      type: 'select'
      message: string
      options: readonly { id: string; label: string }[]
    }
)

/** Progress shown during `/login` (pi's AuthEvent). */
export type AuthEvent =
  | { type: 'info' | 'progress'; message: string }
  | { type: 'auth_url'; url: string; instructions?: string }

/**
 * How a login talks to the user. `prompt` rejects when the user cancels or `AuthPrompt.signal` aborts
 * (a callback that arrived first cancels the "paste the redirect URL" prompt this way).
 */
export interface AuthInteraction {
  signal: AbortSignal
  prompt(prompt: AuthPrompt): Promise<string>
  notify(event: AuthEvent): void
}

/** App context for a login (pi's LoginOptions). */
export interface LoginOptions {
  /** Stable UUID of this installation; required by Sign in with ChatGPT (the CLI keeps it in `~/.vela/installation-id`) */
  getDeviceId?: () => string
  /** Name the app introduces itself with; default `Vela` */
  agentName?: string
}

/**
 * An OAuth sign-in for `/login` (pi's OAuthAuth; extensions pass it as `registerProvider(name, { oauth })`).
 * `login` returns the credential to store: OAuth tokens, or an API key for providers whose OAuth hands out a key.
 */
export interface OAuthLogin {
  /** Shown in `/login`, e.g. `OpenAI (ChatGPT Plus/Pro)` */
  name: string
  login(
    interaction: AuthInteraction,
    options: LoginOptions & { previous?: Credential },
  ): Promise<Credential>
  /** Exchanges the refresh token; Vela calls it under the store lock when the token has under 5 minutes left */
  refresh?(
    credential: OAuthCredential,
    signal: AbortSignal,
  ): Promise<OAuthCredential>
  /** Adjusts each model call while this OAuth credential is used (for endpoints with their own request rules) */
  transformParams?(
    params: LanguageModelV4CallOptions,
  ): LanguageModelV4CallOptions
  /**
   * Wraps the provider's fetch while this OAuth credential is used, for endpoints that need requests
   * shaped differently than with an API key (Sign in with ChatGPT).
   */
  wrapFetch?(fetch: FetchFunction): FetchFunction
}

/** A fetch function (what AI SDK providers accept as `fetch`) */
export type FetchFunction = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>
