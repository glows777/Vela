import type {
  Credential,
  CredentialStore,
  OAuthCredential,
  OAuthLogin,
} from './types.ts'

/** Refresh OAuth tokens with less than this left (pi's default) */
const MIN_VALIDITY_MS = 5 * 60 * 1000
/** A refresh is not cancelled by the caller (the provider may already have rotated the refresh token), only by this timeout */
const REFRESH_TIMEOUT_MS = 15_000

const expiresSoon = (credential: OAuthCredential) =>
  Date.now() + MIN_VALIDITY_MS >= credential.expires

/**
 * The stored credential for a provider, with an OAuth token refreshed first when it has under 5 minutes left
 * (pi's resolveStoredOAuth: expiry is re-checked under the store lock, so concurrent requests and processes refresh
 * once). A failed refresh throws and names `/login`; it never falls back to an environment variable (like pi).
 */
export async function resolveCredential(
  store: CredentialStore,
  provider: string,
  oauth: OAuthLogin | undefined,
): Promise<Credential | undefined> {
  const stored = store.get(provider)
  if (stored?.type !== 'oauth' || !expiresSoon(stored)) return stored
  if (!oauth?.refresh)
    throw new Error(
      `The OAuth token for ${provider} has expired and the provider cannot refresh it; run /login ${provider} to sign in again`,
    )
  const refresh = oauth.refresh.bind(oauth)
  try {
    return await store.modify(provider, async (current) => {
      if (current?.type !== 'oauth' || !expiresSoon(current)) return undefined
      return refresh(current, AbortSignal.timeout(REFRESH_TIMEOUT_MS))
    })
  } catch (error) {
    throw new Error(
      `Refreshing the OAuth token for ${provider} failed: ${error instanceof Error ? error.message : String(error)}. Run /login ${provider} to sign in again`,
      { cause: error },
    )
  }
}
