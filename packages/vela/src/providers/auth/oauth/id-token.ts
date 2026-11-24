// Verifies the ID token OpenAI returns for Sign in with ChatGPT and returns the account identity it proves
// (https://developers.openai.com/siwc/token-sharing-open-source/sign-in, "Validate the ID token"). This flow is a
// public client with no secret, so the signature against OpenAI's JWKS is the only proof that OpenAI issued it.
import { Buffer } from 'node:buffer'
import { createPublicKey, type KeyObject, verify } from 'node:crypto'

const DISCOVERY_URL = 'https://auth.openai.com/.well-known/openid-configuration'
/** OpenAI rotates its signing keys, so discovery and keys are reused this long and then read again */
const CACHE_TTL_MS = 10 * 60 * 1000
/** Clock difference allowed for `exp` and `iat`, in seconds */
const CLOCK_SKEW_S = 60

/** The part of OpenAI's OpenID Connect discovery document the sign-in needs */
export interface OpenAIDiscovery {
  issuer: string
  jwksUri: string
  /** Where a sign-out revokes the refresh token; absent when OpenAI publishes none */
  revocationEndpoint?: string
}

/** The ChatGPT account an ID token proves */
export interface IdTokenIdentity {
  subject: string
  email?: string
}

let cachedDiscovery: { value: OpenAIDiscovery; expires: number } | undefined
let cachedKeys: { value: Map<string, KeyObject>; expires: number } | undefined

/** @internal Starts a test from an empty cache (the cache is module state with a 10 minute TTL) */
export function resetIdTokenCache(): void {
  cachedDiscovery = undefined
  cachedKeys = undefined
}

async function fetchJson(
  url: string,
  what: string,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    signal,
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `Could not read ${what} (${response.status}): ${text || response.statusText}; check this machine's network and sign in again`,
    )
  }
  const data: unknown = await response.json()
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new Error(`${what} is not a JSON object; sign in again`)
  return data as Record<string, unknown>
}

/** OpenAI's discovery document, cached for 10 minutes (`logout` reads its revocation endpoint) */
export async function openAIDiscovery(
  signal?: AbortSignal,
): Promise<OpenAIDiscovery> {
  if (cachedDiscovery && cachedDiscovery.expires > Date.now())
    return cachedDiscovery.value
  const data = await fetchJson(
    DISCOVERY_URL,
    "OpenAI's OpenID configuration",
    signal,
  )
  const { issuer, jwks_uri: jwksUri, revocation_endpoint: revocation } = data
  if (typeof issuer !== 'string' || !issuer)
    throw new Error(
      "OpenAI's OpenID configuration names no issuer; sign in again",
    )
  if (typeof jwksUri !== 'string' || !jwksUri)
    throw new Error(
      "OpenAI's OpenID configuration names no jwks_uri; sign in again",
    )
  const value: OpenAIDiscovery = {
    issuer,
    jwksUri,
    ...(typeof revocation === 'string' && revocation
      ? { revocationEndpoint: revocation }
      : {}),
  }
  cachedDiscovery = { value, expires: Date.now() + CACHE_TTL_MS }
  return value
}

/**
 * The RSA keys OpenAI publishes for signing ID tokens, by `kid`, cached for 10 minutes. `refresh` reads them again
 * even when cached, for a token signed by a key that was rolled out after the last read.
 */
async function publishedKeys(
  jwksUri: string,
  signal: AbortSignal | undefined,
  refresh: boolean,
): Promise<Map<string, KeyObject>> {
  if (!refresh && cachedKeys && cachedKeys.expires > Date.now())
    return cachedKeys.value
  const data = await fetchJson(
    jwksUri,
    "OpenAI's published signing keys",
    signal,
  )
  const keys = new Map<string, KeyObject>()
  for (const entry of Array.isArray(data.keys) ? data.keys : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const { kid, kty, n, e } = entry as Record<string, unknown>
    if (
      typeof kid !== 'string' ||
      !kid ||
      kty !== 'RSA' ||
      typeof n !== 'string' ||
      typeof e !== 'string'
    )
      continue
    try {
      keys.set(
        kid,
        createPublicKey({ key: { kty: 'RSA', n, e }, format: 'jwk' }),
      )
    } catch {
      // A key Node cannot load cannot verify this token either; the missing kid is reported below
    }
  }
  if (!keys.size)
    throw new Error(
      "OpenAI's published signing keys contain no usable RSA key; sign in again",
    )
  cachedKeys = { value: keys, expires: Date.now() + CACHE_TTL_MS }
  return keys
}

function decodeSegment(segment: string, what: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  } catch {
    throw new Error(
      `The ChatGPT sign-in returned an ID token whose ${what} is not JSON; sign in again`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(
      `The ChatGPT sign-in returned an ID token whose ${what} is not a JSON object; sign in again`,
    )
  return parsed as Record<string, unknown>
}

/**
 * Verifies an ID token against OpenAI's JWKS and checks the claims that tie it to this sign-in attempt: issuer,
 * audience (the issued client id), expiry, issued-at and nonce. Rejects with an error that says what failed.
 */
export async function verifyIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string; signal?: AbortSignal },
): Promise<IdTokenIdentity> {
  const parts = idToken.split('.')
  if (parts.length !== 3 || parts.some((part) => !part))
    throw new Error(
      'The ChatGPT sign-in returned a malformed ID token; sign in again',
    )
  const [rawHeader, rawPayload, rawSignature] = parts as [
    string,
    string,
    string,
  ]
  const header = decodeSegment(rawHeader, 'header')
  const payload = decodeSegment(rawPayload, 'payload')
  if (header.alg !== 'RS256')
    throw new Error(
      `The ChatGPT ID token is signed with ${String(header.alg)}, not RS256; sign in again`,
    )
  if (typeof header.kid !== 'string' || !header.kid)
    throw new Error('The ChatGPT ID token names no signing key; sign in again')
  const kid = header.kid
  const discovery = await openAIDiscovery(expected.signal)
  let keys = await publishedKeys(discovery.jwksUri, expected.signal, false)
  // A kid the cache does not know may be a key OpenAI published since it was read
  if (!keys.has(kid))
    keys = await publishedKeys(discovery.jwksUri, expected.signal, true)
  const key = keys.get(kid)
  if (!key)
    throw new Error(
      `The ChatGPT ID token is signed with key ${kid}, which OpenAI does not publish; sign in again`,
    )
  const signed = Buffer.from(`${rawHeader}.${rawPayload}`)
  if (
    !verify('RSA-SHA256', signed, key, Buffer.from(rawSignature, 'base64url'))
  )
    throw new Error(
      "The ChatGPT ID token's signature does not match OpenAI's published key; sign in again",
    )

  if (payload.iss !== discovery.issuer)
    throw new Error(
      `The ChatGPT ID token was issued by ${String(payload.iss)}, not ${discovery.issuer}; sign in again`,
    )
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!audience.includes(expected.clientId))
    throw new Error(
      'The ChatGPT sign-in returned an ID token for another client id; sign in again',
    )
  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== 'number')
    throw new Error('The ChatGPT ID token has no expiry; sign in again')
  if (payload.exp + CLOCK_SKEW_S <= now)
    throw new Error('The ChatGPT ID token has expired; sign in again')
  if (typeof payload.iat !== 'number')
    throw new Error('The ChatGPT ID token has no issued-at time; sign in again')
  if (payload.iat - CLOCK_SKEW_S > now)
    throw new Error(
      "The ChatGPT ID token was issued in the future; check this machine's clock and sign in again",
    )
  if (payload.nonce !== expected.nonce)
    throw new Error(
      'The ChatGPT sign-in returned an ID token for another sign-in attempt; sign in again',
    )
  if (typeof payload.sub !== 'string' || !payload.sub)
    throw new Error(
      'The ChatGPT ID token has no subject, so it cannot identify the account; sign in again',
    )
  return typeof payload.email === 'string' && payload.email
    ? { subject: payload.sub, email: payload.email }
    : { subject: payload.sub }
}
