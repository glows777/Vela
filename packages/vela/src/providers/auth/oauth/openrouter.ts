// OpenRouter OAuth PKCE (https://openrouter.ai/docs/use-cases/oauth-pkce), adapted from pi-mono
// (packages/ai/src/auth/oauth/openrouter.ts, MIT). OpenRouter exchanges the code for a regular API key the
// user controls, so the result is stored as an API key and never needs refreshing.
import type { OAuthLogin } from '../types.ts'
import {
  startCallbackServer,
  waitForCallbackOrPaste,
} from './callback-server.ts'
import { generatePKCE } from './pkce.ts'

const AUTHORIZE_URL = 'https://openrouter.ai/auth'
const KEY_URL = 'https://openrouter.ai/api/v1/auth/keys'
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

async function exchange(code: string, verifier: string, signal: AbortSignal) {
  const response = await fetch(KEY_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: 'S256',
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  })
  const body = (await response.json().catch(() => ({}))) as {
    key?: unknown
    error?: { message?: unknown } | unknown
    message?: unknown
  }
  if (!response.ok) {
    const error = body.error as { message?: unknown } | string | undefined
    const detail =
      typeof error === 'string'
        ? error
        : typeof error?.message === 'string'
          ? error.message
          : typeof body.message === 'string'
            ? body.message
            : response.statusText
    throw new Error(
      `OpenRouter key exchange failed (HTTP ${response.status}): ${detail}`,
    )
  }
  if (typeof body.key !== 'string' || !body.key)
    throw new Error('OpenRouter returned no key')
  return { type: 'api_key' as const, key: body.key }
}

function codeFrom(input: string): string | undefined {
  const value = input.trim()
  try {
    return new URL(value).searchParams.get('code') ?? undefined
  } catch {}
  if (value.includes('code='))
    return new URLSearchParams(value).get('code') ?? undefined
  return value || undefined
}

export const openRouterLogin: OAuthLogin = {
  name: 'Sign in with OpenRouter',
  async login(interaction) {
    const { verifier, challenge } = await generatePKCE()
    // OpenRouter sends no `state`; the random path keeps stray requests from completing the sign-in (pi)
    const callback = await startCallbackServer({
      providerName: 'OpenRouter',
      host: '127.0.0.1',
      port: 0,
      path: `/oauth/callback/${crypto.randomUUID()}`,
      complete: (params) =>
        exchange(params.get('code') as string, verifier, interaction.signal),
      signal: interaction.signal,
      timeoutMs: LOGIN_TIMEOUT_MS,
    })
    try {
      const url = new URL(AUTHORIZE_URL)
      url.search = new URLSearchParams({
        callback_url: callback.redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString()
      interaction.notify({
        type: 'auth_url',
        url: url.toString(),
        instructions:
          'Sign in with OpenRouter in your browser. If the browser is on another machine, paste the final redirect URL here.',
      })
      const result = await waitForCallbackOrPaste(interaction, callback, {
        message:
          'Finish signing in in your browser, or paste the final redirect URL here:',
        placeholder: callback.redirectUri,
      })
      if (result.type === 'callback') return result.value
      const code = codeFrom(result.input)
      if (!code) throw new Error('Missing authorization code')
      interaction.notify({
        type: 'progress',
        message: 'Exchanging the code for an API key…',
      })
      return await exchange(code, verifier, interaction.signal)
    } finally {
      callback.close()
    }
  },
}
