// Sign in with ChatGPT: OpenAI's token sharing for open-source and local agents
// (https://developers.openai.com/siwc/token-sharing-open-source/sign-in). Adapted from pi-mono
// (packages/ai/src/auth/oauth/openai-chatgpt.ts, MIT). No client secret or app registration: the first
// sign-in registers this installation and OpenAI returns the client id to keep for later sign-ins.
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type {
  Credential,
  FetchFunction,
  OAuthCredential,
  OAuthLogin,
} from '../types.ts'
import {
  startCallbackServer,
  waitForCallbackOrPaste,
} from './callback-server.ts'
import { generatePKCE, randomValue } from './pkce.ts'

const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'
const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize'
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token'
const RESOURCE = 'https://api.openai.com/v1'
const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PORT = 1455
const CALLBACK_PATH = '/auth/callback'
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`
const DIRECT_TOKEN_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Refresh this long before the real expiry (pi) */
const EXPIRY_MARGIN_MS = 3 * 60 * 1000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** Request fields the ChatGPT plan route rejects (OpenAI's "Preview limitations" page) */
const UNSUPPORTED_FIELDS = [
  'background',
  'conversation',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'previous_response_id',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
]

interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  id_token?: unknown
  scope?: unknown
}

async function requestToken(
  body: URLSearchParams,
  signal: AbortSignal,
): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `OpenAI token request failed (${response.status}): ${text || response.statusText}`,
    )
  }
  const data: unknown = await response.json()
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new Error('OpenAI token response must be an object')
  return data as TokenResponse
}

function credentialFrom(
  token: TokenResponse,
  clientId: string,
): OAuthCredential {
  const text = (value: unknown, field: string) => {
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`OpenAI token response has no valid ${field}`)
    return value
  }
  const access = text(token.access_token, 'access_token')
  const refresh = text(token.refresh_token, 'refresh_token')
  const scopes = text(token.scope, 'scope').trim().split(/\s+/)
  if (
    typeof token.expires_in !== 'number' ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in <= 0
  )
    throw new Error('OpenAI token response has no valid expires_in')
  // A valid ID token alone does not authorize plan usage: the grant must include the direct-token scope
  if (!scopes.includes(DIRECT_TOKEN_SCOPE))
    throw new Error(
      `The ChatGPT sign-in did not grant ${DIRECT_TOKEN_SCOPE}; allow plan usage when signing in`,
    )
  return {
    type: 'oauth',
    access,
    refresh,
    expires: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS,
    clientId,
    scopes,
  }
}

/** The issued client id of an earlier sign-in, reused so this installation keeps one registration */
const issuedClientId = (previous: Credential | undefined) =>
  previous?.type === 'oauth' &&
  typeof previous.clientId === 'string' &&
  previous.clientId
    ? previous.clientId
    : undefined

/** Where the browser lands: `code`, `state` and (for a new registration) the issued `client_id` */
function parseCallback(
  params: URLSearchParams,
  state: string,
  knownClientId: string | undefined,
): { code: string; clientId: string } {
  const error = params.get('error')
  if (error) throw new Error(`ChatGPT authorization failed: ${error}`)
  if (params.get('state') !== state) throw new Error('OAuth state mismatch')
  const code = params.get('code')
  if (!code) throw new Error('Missing authorization code')
  const returned = params.get('client_id')?.trim()
  if (knownClientId && returned && returned !== knownClientId)
    throw new Error(
      'ChatGPT returned a different client id than this installation registered',
    )
  const clientId = knownClientId ?? returned
  if (!clientId)
    throw new Error('The ChatGPT callback did not contain an issued client id')
  return { code, clientId }
}

function parsePastedUrl(input: string): URLSearchParams {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('Paste the full callback URL from the browser')
  }
  if (`${url.origin}${url.pathname}` !== REDIRECT_URI)
    throw new Error(`The pasted callback URL must start with ${REDIRECT_URI}`)
  return url.searchParams
}

/**
 * The ChatGPT plan route only takes stored-less, streamed Responses requests (OpenAI's "Preview limitations"):
 * `store: false` with encrypted reasoning carried in the input, no system role, and none of the unsupported fields.
 */
function transformParams(
  params: LanguageModelV4CallOptions,
): LanguageModelV4CallOptions {
  const { maxOutputTokens: _m, temperature: _t, topP: _p, ...rest } = params
  const openai = { ...(params.providerOptions?.openai ?? {}) }
  const include = Array.isArray(openai.include) ? openai.include : []
  return {
    ...rest,
    providerOptions: {
      ...params.providerOptions,
      openai: {
        ...openai,
        store: false,
        include: [...new Set([...include, 'reasoning.encrypted_content'])],
        systemMessageMode: 'developer',
      },
    },
  }
}

/**
 * Removes what the route rejects, and turns a non-streamed request (context summaries use generateText) into a
 * streamed one whose `response.completed` event is returned as the JSON response the AI SDK expects.
 */
function wrapFetch(base: FetchFunction): FetchFunction {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    // The token is the user's ChatGPT plan: never send it anywhere but OpenAI (OPENAI_API_BASE_URL may point elsewhere)
    if (new URL(url).origin !== new URL(RESOURCE).origin)
      throw new Error(
        `Sign in with ChatGPT only works with ${RESOURCE}, but the openai provider's base URL is ${new URL(url).origin}; unset OPENAI_API_BASE_URL (or the openai baseUrl in models.json), or use an API key`,
      )
    if (
      !url.endsWith('/responses') ||
      init?.method !== 'POST' ||
      typeof init.body !== 'string'
    )
      return base(input, init)
    const body = JSON.parse(init.body) as Record<string, unknown>
    for (const field of UNSUPPORTED_FIELDS) delete body[field]
    body.store = false
    const streamed = body.stream === true
    body.stream = true
    const response = await base(input, { ...init, body: JSON.stringify(body) })
    if (streamed || !response.ok || !response.body) return response
    const text = await response.text()
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      const event = JSON.parse(data) as {
        type?: string
        response?: unknown
        error?: unknown
      }
      if (
        event.type === 'response.completed' ||
        event.type === 'response.incomplete'
      )
        return new Response(JSON.stringify(event.response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      if (event.type === 'response.failed' || event.type === 'error')
        return new Response(
          JSON.stringify({
            error:
              (event.response as { error?: unknown } | undefined)?.error ??
              event.error ??
              event,
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        )
    }
    throw new Error(
      'The ChatGPT response stream ended without a completed response',
    )
  }
}

export const openaiChatGPTLogin: OAuthLogin = {
  name: 'Sign in with ChatGPT (Plus/Pro)',
  async login(interaction, options) {
    const deviceId = options.getDeviceId?.()
    if (!deviceId || !UUID.test(deviceId))
      throw new Error(
        'Sign in with ChatGPT needs a device id (UUID) for this installation',
      )
    const known = issuedClientId(options.previous)
    const { verifier, challenge } = await generatePKCE()
    const state = randomValue()
    const callback = await startCallbackServer({
      providerName: 'ChatGPT',
      host: CALLBACK_HOST,
      port: CALLBACK_PORT,
      path: CALLBACK_PATH,
      state,
      complete: async (params) => parseCallback(params, state, known),
      signal: interaction.signal,
      timeoutMs: LOGIN_TIMEOUT_MS,
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
        throw new Error(
          `Port ${CALLBACK_PORT} is in use, probably by an unfinished sign-in in another Vela or by the Codex CLI. Finish or cancel that one and try again.`,
        )
      throw error
    })
    try {
      const url = new URL(AUTHORIZE_URL)
      url.search = new URLSearchParams({
        client_id: known ?? DYNAMIC_CLIENT_ID,
        ...(known ? {} : { agent_name_hint: options.agentName ?? 'Vela' }),
        ext_agent_host_id: `urn:uuid:${deviceId.toLowerCase()}`,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        nonce: randomValue(),
      }).toString()
      interaction.notify({
        type: 'auth_url',
        url: url.toString(),
        instructions:
          'Sign in with ChatGPT in your browser. If the browser is on another machine, paste the final redirect URL here.',
      })
      const result = await waitForCallbackOrPaste(interaction, callback, {
        message:
          'Finish signing in in your browser, or paste the final redirect URL here:',
        placeholder: REDIRECT_URI,
      })
      const { code, clientId } =
        result.type === 'callback'
          ? result.value
          : parseCallback(parsePastedUrl(result.input), state, known)
      interaction.notify({
        type: 'progress',
        message: 'Exchanging the authorization code for tokens…',
      })
      const token = await requestToken(
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
          resource: RESOURCE,
        }),
        interaction.signal,
      )
      return credentialFrom(token, clientId)
    } finally {
      callback.close()
    }
  },
  async refresh(credential, signal) {
    const clientId = issuedClientId(credential)
    if (!clientId)
      throw new Error(
        'The stored ChatGPT credential has no client id; sign in again',
      )
    const token = await requestToken(
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: credential.refresh,
        resource: RESOURCE,
      }),
      signal,
    )
    return credentialFrom(token, clientId)
  },
}

/**
 * How the openai provider sends requests while a ChatGPT sign-in is used. OpenAI documents the sign-in for local
 * agents the signed-in person runs, so channel sessions (a Feishu bot) cannot use it.
 */
export const chatGPTRequests = {
  localOnly: true,
  transformParams,
  wrapFetch,
}
