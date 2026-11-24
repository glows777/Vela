import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import {
  resetIdTokenCache,
  verifyIdToken,
} from '../../../../src/providers/auth/oauth/id-token.ts'

const DISCOVERY_URL = 'https://auth.openai.com/.well-known/openid-configuration'
const JWKS_URL = 'https://auth.openai.com/.well-known/jwks.json'
const ISSUER = 'https://auth.openai.com'
const CLIENT_ID = 'oaiapp_issued'
const NONCE = 'attempt-nonce'

const realFetch = globalThis.fetch
beforeEach(() => resetIdTokenCache())
afterEach(() => {
  globalThis.fetch = realFetch
})

interface TestKey {
  kid: string
  privateKey: KeyObject
  publicKey: KeyObject
}

function testKey(kid = 'openai-key-1'): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  })
  return { kid, privateKey, publicKey }
}

const base64url = (value: string | Buffer) =>
  Buffer.from(value).toString('base64url')

/** A token shaped like OpenAI's ID token: RS256 over `<header>.<payload>` */
function idToken(
  key: TestKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const head = base64url(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header }),
  )
  const body = base64url(JSON.stringify(claims))
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`${head}.${body}`),
    key.privateKey,
  )
  return `${head}.${body}.${base64url(signature)}`
}

/** The claims of a token OpenAI issued for this sign-in attempt */
function claims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'user-1',
    email: 'user@example.com',
    nonce: NONCE,
    iat: now,
    exp: now + 600,
    ...overrides,
  }
}

/** Serves OpenAI's discovery document and JWKS; `keys` runs per request so a test can rotate them */
function fakeOpenAI(keys: () => TestKey[]) {
  const requests: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    if (url === DISCOVERY_URL)
      return new Response(
        JSON.stringify({ issuer: ISSUER, jwks_uri: JWKS_URL }),
      )
    if (url === JWKS_URL)
      return new Response(
        JSON.stringify({
          keys: keys().map((key) => ({
            ...key.publicKey.export({ format: 'jwk' }),
            kid: key.kid,
            alg: 'RS256',
            use: 'sig',
          })),
        }),
      )
    throw new Error(`unexpected request to ${url}`)
  }) as typeof fetch
  return requests
}

test('a well-formed ID token verifies and yields the account subject and email', async () => {
  const key = testKey()
  const requests = fakeOpenAI(() => [key])
  const token = idToken(key, claims())
  await expect(
    verifyIdToken(token, { clientId: CLIENT_ID, nonce: NONCE }),
  ).resolves.toEqual({ subject: 'user-1', email: 'user@example.com' })
  // Discovery and keys are reused instead of read once per token
  await verifyIdToken(token, { clientId: CLIENT_ID, nonce: NONCE })
  expect(requests.filter((url) => url === DISCOVERY_URL)).toHaveLength(1)
  expect(requests.filter((url) => url === JWKS_URL)).toHaveLength(1)
})

test('a token without an email yields the subject alone', async () => {
  const key = testKey()
  fakeOpenAI(() => [key])
  await expect(
    verifyIdToken(idToken(key, claims({ email: undefined })), {
      clientId: CLIENT_ID,
      nonce: NONCE,
    }),
  ).resolves.toEqual({ subject: 'user-1' })
})

test('a key published after the keys were read is picked up by refetching the JWKS once', async () => {
  const settled = testKey('openai-key-1')
  const rotated = testKey('openai-key-2')
  let served = 0
  const requests = fakeOpenAI(() =>
    served++ === 0 ? [settled] : [settled, rotated],
  )
  await verifyIdToken(idToken(settled, claims()), {
    clientId: CLIENT_ID,
    nonce: NONCE,
  })
  await expect(
    verifyIdToken(idToken(rotated, claims()), {
      clientId: CLIENT_ID,
      nonce: NONCE,
    }),
  ).resolves.toMatchObject({ subject: 'user-1' })
  expect(requests.filter((url) => url === JWKS_URL)).toHaveLength(2)
})

test('a token whose signature does not match the published key is rejected', async () => {
  const key = testKey()
  // Same kid, another key pair: only the signature check can catch this
  const impostor = testKey()
  fakeOpenAI(() => [key])
  await expect(
    verifyIdToken(idToken(impostor, claims()), {
      clientId: CLIENT_ID,
      nonce: NONCE,
    }),
  ).rejects.toThrow('signature does not match')
})

test('a token for another client id is rejected', async () => {
  const key = testKey()
  fakeOpenAI(() => [key])
  await expect(
    verifyIdToken(idToken(key, claims({ aud: 'oaiapp_other' })), {
      clientId: CLIENT_ID,
      nonce: NONCE,
    }),
  ).rejects.toThrow('another client id')
})

test('a token from another issuer is rejected', async () => {
  const key = testKey()
  fakeOpenAI(() => [key])
  await expect(
    verifyIdToken(idToken(key, claims({ iss: 'https://evil.example' })), {
      clientId: CLIENT_ID,
      nonce: NONCE,
    }),
  ).rejects.toThrow('was issued by https://evil.example')
})

test('a token for another sign-in attempt is rejected', async () => {
  const key = testKey()
  fakeOpenAI(() => [key])
  await expect(
    verifyIdToken(idToken(key, claims({ nonce: 'other-attempt' })), {
      clientId: CLIENT_ID,
      nonce: NONCE,
    }),
  ).rejects.toThrow('another sign-in attempt')
})

test('an expired token is rejected', async () => {
  const key = testKey()
  fakeOpenAI(() => [key])
  const expired = Math.floor(Date.now() / 1000) - 120
  await expect(
    verifyIdToken(idToken(key, claims({ exp: expired })), {
      clientId: CLIENT_ID,
      nonce: NONCE,
    }),
  ).rejects.toThrow('The ChatGPT ID token has expired; sign in again')
})

test('a token without a subject is rejected', async () => {
  const key = testKey()
  fakeOpenAI(() => [key])
  await expect(
    verifyIdToken(idToken(key, claims({ sub: undefined })), {
      clientId: CLIENT_ID,
      nonce: NONCE,
    }),
  ).rejects.toThrow('no subject')
})
