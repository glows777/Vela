import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import type {
  AuthInteraction,
  AuthPrompt,
} from '../../../../src/driver/index.ts'
import { resetIdTokenCache } from '../../../../src/providers/auth/oauth/id-token.ts'
import {
  chatGPTRequests,
  openaiChatGPTLogin,
  revocationTiming,
} from '../../../../src/providers/auth/oauth/openai-chatgpt.ts'
import { openRouterLogin } from '../../../../src/providers/auth/oauth/openrouter.ts'
import { memoryCredentialStore } from '../../../../src/providers/auth/store.ts'
import { ModelRegistry } from '../../../../src/providers/models/index.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})
// The ID token cache and the sign-out budget are module state; each test gets its own keys, and the budget is short
// enough that a timeout case does not cost ten seconds
const REAL_TIMING = { ...revocationTiming }
beforeEach(() => {
  resetIdTokenCache()
  revocationTiming.backoffMs = [10, 10, 10, 10]
  revocationTiming.budgetMs = 300
})
afterEach(() => {
  revocationTiming.backoffMs = REAL_TIMING.backoffMs
  revocationTiming.budgetMs = REAL_TIMING.budgetMs
})

const DEVICE = '0b9d6f3e-8c1a-4f2e-9d7b-5a6c4e3f2a10'

/** Answers OAuth endpoints with `respond`; requests to the loopback callback go to the real network */
function fakeProvider(
  respond: (url: string, body: string) => Response | Promise<Response>,
) {
  const calls: { url: string; body: string }[] = []
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input)
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init)
    const body = String(init?.body ?? '')
    calls.push({ url, body })
    return respond(url, body)
  }) as typeof fetch
  return calls
}

/** A user who opens the URL in a browser: the browser lands on the redirect with these query parameters */
function browserUser(callback: (authorizeUrl: URL) => URL) {
  const prompts: AuthPrompt[] = []
  const pages: string[] = []
  /** What the sign-in told the user (progress and info events) */
  const notices: string[] = []
  let page: Promise<string> | undefined
  const interaction: AuthInteraction = {
    signal: new AbortController().signal,
    prompt: (prompt) => {
      prompts.push(prompt)
      // Never answers; closed by its signal once the callback arrives
      return new Promise((_, reject) =>
        prompt.signal?.addEventListener('abort', () =>
          reject(new Error('closed')),
        ),
      )
    },
    notify: (event) => {
      if (event.type !== 'auth_url') {
        notices.push(event.message)
        return
      }
      page = realFetch(callback(new URL(event.url))).then(async (r) => {
        const text = await r.text()
        pages.push(text)
        return text
      })
    },
  }
  // The browser's page, which must arrive in full although the login closes the server right after it
  const browserPage = () =>
    Promise.race([
      page,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('no callback page')), 2000),
      ),
    ])
  return { interaction, prompts, pages, notices, browserPage }
}

const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token'
const OPENAI_ISSUER = 'https://auth.openai.com'
const OPENAI_DISCOVERY = `${OPENAI_ISSUER}/.well-known/openid-configuration`
const OPENAI_JWKS = `${OPENAI_ISSUER}/.well-known/jwks.json`
const OPENAI_REVOKE = `${OPENAI_ISSUER}/api/accounts/oauth/revoke`
const CHATGPT_KID = 'openai-key-1'
const PLAN_SCOPE =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'

const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 })

/** A token shaped like OpenAI's ID token: RS256 over `<header>.<payload>` */
function signedIdToken(claims: Record<string, unknown>, key: KeyObject) {
  const head = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: CHATGPT_KID }),
  ).toString('base64url')
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key)
  return `${head}.${body}.${signature.toString('base64url')}`
}

/** An ID token OpenAI would issue for this authorization attempt */
function idTokenFor(
  clientId: string,
  nonce: string,
  options: { key?: KeyObject; claims?: Record<string, unknown> } = {},
) {
  const now = Math.floor(Date.now() / 1000)
  return signedIdToken(
    {
      iss: OPENAI_ISSUER,
      aud: clientId,
      sub: 'user-1',
      email: 'user@example.com',
      nonce,
      iat: now,
      exp: now + 600,
      ...options.claims,
    },
    options.key ?? signingKey.privateKey,
  )
}

/** A code-exchange response carrying `idToken` */
function tokenResponse(idToken: string, scope = PLAN_SCOPE) {
  return new Response(
    JSON.stringify({
      access_token: 'at',
      refresh_token: 'rt',
      id_token: idToken,
      expires_in: 3600,
      scope,
    }),
  )
}

/** OpenAI's discovery document and JWKS; every other URL goes to `respond` */
function openAIRespond(
  respond: (url: string, body: string) => Response | Promise<Response>,
) {
  return (url: string, body: string) => {
    if (url === OPENAI_DISCOVERY)
      return new Response(
        JSON.stringify({
          issuer: OPENAI_ISSUER,
          jwks_uri: OPENAI_JWKS,
          revocation_endpoint: OPENAI_REVOKE,
        }),
      )
    if (url === OPENAI_JWKS)
      return new Response(
        JSON.stringify({
          keys: [
            {
              ...signingKey.publicKey.export({ format: 'jwk' }),
              kid: CHATGPT_KID,
              alg: 'RS256',
              use: 'sig',
            },
          ],
        }),
      )
    return respond(url, body)
  }
}

/** The body of the token request among the recorded non-loopback calls */
function tokenRequest(calls: { url: string; body: string }[]) {
  return new URLSearchParams(calls.find((call) => call.url === TOKEN_URL)?.body)
}

test('Sign in with ChatGPT registers with dynamic_agent_client, then keeps the issued client id', async () => {
  let authorize: URL | undefined
  let issued = ''
  const calls = fakeProvider(
    openAIRespond(() => {
      issued = idTokenFor(
        'oaiapp_issued',
        authorize?.searchParams.get('nonce') ?? '',
      )
      return tokenResponse(issued)
    }),
  )
  const user = browserUser((url) => {
    authorize = url
    const redirect = new URL(url.searchParams.get('redirect_uri') as string)
    redirect.search = new URLSearchParams({
      code: 'the-code',
      state: url.searchParams.get('state') as string,
      client_id: 'oaiapp_issued',
    }).toString()
    return redirect
  })
  const credential = await openaiChatGPTLogin.login(user.interaction, {
    getDeviceId: () => DEVICE,
  })
  // The verified identity and the ID token the credential must keep (OpenAI's credential record)
  expect(credential).toMatchObject({
    type: 'oauth',
    access: 'at',
    refresh: 'rt',
    clientId: 'oaiapp_issued',
    idToken: issued,
    subject: 'user-1',
    email: 'user@example.com',
  })
  const firstToken = issued
  // The plan notice belongs to the first sign-in
  expect(user.notices).toContain(
    'Requests now use your ChatGPT plan allowance; usage is managed at https://chatgpt.com/settings/usage',
  )
  expect(authorize?.searchParams.get('client_id')).toBe('dynamic_agent_client')
  expect(authorize?.searchParams.get('agent_name_hint')).toBe('Vela')
  expect(authorize?.searchParams.get('ext_agent_host_id')).toBe(
    `urn:uuid:${DEVICE}`,
  )
  expect(authorize?.searchParams.get('redirect_uri')).toBe(
    'http://127.0.0.1:1455/auth/callback',
  )
  const exchange = tokenRequest(calls)
  expect(exchange.get('client_id')).toBe('oaiapp_issued')
  expect(exchange.get('code')).toBe('the-code')
  expect(exchange.get('resource')).toBe('https://api.openai.com/v1')
  expect(exchange.get('code_verifier')).toBeTruthy()
  expect(await user.browserPage()).toContain('Signed in to ChatGPT')

  // Signing in again reuses the issued client id and drops the name hint (OpenAI's reauthorization)
  const again = browserUser((url) => {
    authorize = url
    const redirect = new URL(url.searchParams.get('redirect_uri') as string)
    redirect.search = `code=c2&state=${url.searchParams.get('state')}`
    return redirect
  })
  await openaiChatGPTLogin.login(again.interaction, {
    getDeviceId: () => DEVICE,
    previous: credential,
  })
  expect(authorize?.searchParams.get('client_id')).toBe('oaiapp_issued')
  expect(authorize?.searchParams.has('agent_name_hint')).toBe(false)
  // The retained token and email skip OpenAI's account selector; the plan notice is not repeated
  expect(authorize?.searchParams.get('id_token_hint')).toBe(firstToken)
  expect(authorize?.searchParams.get('login_hint')).toBe('user@example.com')
  expect(
    again.notices.filter((text) => text.includes('plan allowance')),
  ).toEqual([])
})

test('reauthorization omits the hints it has no stored value for', async () => {
  let authorize: URL | undefined
  fakeProvider(
    openAIRespond(() =>
      tokenResponse(
        idTokenFor('oaiapp_issued', authorize?.searchParams.get('nonce') ?? ''),
      ),
    ),
  )
  const user = browserUser((url) => {
    authorize = url
    const redirect = new URL(url.searchParams.get('redirect_uri') as string)
    redirect.search = `code=c&state=${url.searchParams.get('state')}`
    return redirect
  })
  // A credential from before the ID token was kept: no id_token_hint, no login_hint
  await openaiChatGPTLogin.login(user.interaction, {
    getDeviceId: () => DEVICE,
    previous: {
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 0,
      clientId: 'oaiapp_issued',
    },
  })
  expect(authorize?.searchParams.get('client_id')).toBe('oaiapp_issued')
  expect(authorize?.searchParams.has('id_token_hint')).toBe(false)
  expect(authorize?.searchParams.has('login_hint')).toBe(false)
})

test('reauthorization refuses a different ChatGPT account and keeps the stored credential', async () => {
  let authorize: URL | undefined
  fakeProvider(
    openAIRespond(() =>
      tokenResponse(
        idTokenFor(
          'oaiapp_issued',
          authorize?.searchParams.get('nonce') ?? '',
          {
            claims: { sub: 'someone-else' },
          },
        ),
      ),
    ),
  )
  const user = browserUser((url) => {
    authorize = url
    const redirect = new URL(url.searchParams.get('redirect_uri') as string)
    redirect.search = `code=c&state=${url.searchParams.get('state')}`
    return redirect
  })
  const stored = {
    type: 'oauth',
    access: 'a',
    refresh: 'r',
    expires: 0,
    clientId: 'oaiapp_issued',
    idToken: 'first-token',
    subject: 'user-1',
  } as const
  const registry = new ModelRegistry(
    { openai: { oauth: openaiChatGPTLogin, createModel: () => 'test-model' } },
    memoryCredentialStore({ openai: stored }),
  )
  await expect(
    registry.login('openai', 'oauth', user.interaction, {
      getDeviceId: () => DEVICE,
    }),
  ).rejects.toThrow('different account')
  expect(registry.credentials.get('openai')).toMatchObject({
    idToken: 'first-token',
    subject: 'user-1',
  })
})

test('switching an OpenAI API key to the ChatGPT plan still says what pays and where usage lives', async () => {
  let authorize: URL | undefined
  fakeProvider(
    openAIRespond(() =>
      tokenResponse(
        idTokenFor('oaiapp_issued', authorize?.searchParams.get('nonce') ?? ''),
      ),
    ),
  )
  const user = browserUser((url) => {
    authorize = url
    const redirect = new URL(url.searchParams.get('redirect_uri') as string)
    redirect.search = `code=c&state=${url.searchParams.get('state')}&client_id=oaiapp_issued`
    return redirect
  })
  // `/login openai` on a machine that already stored an API key: no ChatGPT sign-in happened before, so this is a
  // new registration and the callback carries the issued client id
  await openaiChatGPTLogin.login(user.interaction, {
    getDeviceId: () => DEVICE,
    previous: { type: 'api_key', key: 'sk-existing' },
  })
  expect(user.notices).toContain(
    'Requests now use your ChatGPT plan allowance; usage is managed at https://chatgpt.com/settings/usage',
  )
})

test('a ChatGPT sign-in whose ID token does not verify fails and stores nothing', async () => {
  let authorize: URL | undefined
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  fakeProvider(
    openAIRespond(() =>
      tokenResponse(
        idTokenFor('oaiapp_dead', authorize?.searchParams.get('nonce') ?? '', {
          key: otherKey.privateKey,
        }),
      ),
    ),
  )
  const user = browserUser((url) => {
    authorize = url
    const redirect = new URL(url.searchParams.get('redirect_uri') as string)
    redirect.search = `code=c&state=${url.searchParams.get('state')}&client_id=oaiapp_dead`
    return redirect
  })
  const registry = new ModelRegistry(
    { openai: { oauth: openaiChatGPTLogin, createModel: () => 'test-model' } },
    memoryCredentialStore(),
  )
  await expect(
    registry.login('openai', 'oauth', user.interaction, {
      getDeviceId: () => DEVICE,
    }),
  ).rejects.toThrow('signature does not match')
  expect(registry.credentials.list()).toEqual([])
})

test('a ChatGPT grant without plan usage is refused', async () => {
  let authorize: URL | undefined
  fakeProvider(
    openAIRespond(() =>
      tokenResponse(
        idTokenFor('oaiapp_x', authorize?.searchParams.get('nonce') ?? ''),
        'openid profile email',
      ),
    ),
  )
  const user = browserUser((url) => {
    authorize = url
    const redirect = new URL(url.searchParams.get('redirect_uri') as string)
    redirect.search = `code=c&state=${url.searchParams.get('state')}&client_id=oaiapp_x`
    return redirect
  })
  await expect(
    openaiChatGPTLogin.login(user.interaction, { getDeviceId: () => DEVICE }),
  ).rejects.toThrow('did not grant chatgpt.tokens.use.direct')
})

test('ChatGPT requests are made stored-less and streamed; a non-streamed call gets the completed response back', async () => {
  const sent: Record<string, unknown>[] = []
  const base = async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)))
    return new Response(
      'event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","output":[]}}\n\n',
    )
  }
  const fetch = chatGPTRequests.wrapFetch(base)
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-5.5',
      max_output_tokens: 8192,
      temperature: 0,
      store: true,
    }),
  })
  expect(sent[0]).toEqual({ model: 'gpt-5.5', store: false, stream: true })
  expect(await response.json()).toEqual({ id: 'r1', output: [] })

  const params = chatGPTRequests.transformParams({
    prompt: [],
    maxOutputTokens: 100,
    temperature: 1,
    providerOptions: { openai: { include: ['x'] } },
  })
  expect(params.maxOutputTokens).toBeUndefined()
  expect(params.temperature).toBeUndefined()
  expect(params.providerOptions?.openai).toEqual({
    include: ['x', 'reasoning.encrypted_content'],
    store: false,
    systemMessageMode: 'developer',
  })
})

test('a plan limit inside the event stream keeps its code, streamed and synthesized alike', async () => {
  const url = 'https://api.openai.com/v1/responses'
  // A streamed request (what every plan request is) keeps its body untouched: the error text the SDK reports from
  // `response.failed` carries the code, and the hint is added where hosts render errors.
  const failed = [
    'data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"Plan limit reached"}}}',
    '',
  ].join('\n')
  const streamed = await chatGPTRequests.wrapFetch(
    async () =>
      new Response(failed, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  )(url, { method: 'POST', body: JSON.stringify({ stream: true }) })
  expect(streamed.status).toBe(200)
  expect(await streamed.text()).toBe(failed)

  // A non-streamed request (context summaries) is turned into a JSON response, and a plan limit inside the stream
  // keeps its code so the retry layer can see it
  const synthesized = await chatGPTRequests.wrapFetch(
    async () =>
      new Response(failed, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  )(url, { method: 'POST', body: JSON.stringify({ stream: false }) })
  expect(synthesized.status).toBe(500)
  const body = (await synthesized.json()) as { error: { code: string } }
  expect(body.error.code).toBe('subscription_sharing_usage_limit_exceeded')
})

test('the ChatGPT token is never sent to a base URL other than OpenAI', async () => {
  const sent: string[] = []
  const fetch = chatGPTRequests.wrapFetch(async (input) => {
    sent.push(String(input))
    return new Response('{}')
  })
  await expect(
    fetch('https://proxy.example.com/v1/responses', {
      method: 'POST',
      body: '{}',
    }),
  ).rejects.toThrow('unset OPENAI_API_BASE_URL')
  expect(sent).toEqual([])
})

test('ChatGPT refresh keeps the client id and asks for the same resource', async () => {
  const calls = fakeProvider(
    () =>
      new Response(
        JSON.stringify({
          access_token: 'new',
          refresh_token: 'rt2',
          expires_in: 3600,
          scope: 'offline_access chatgpt.tokens.use.direct',
        }),
      ),
  )
  const refreshed = await openaiChatGPTLogin.refresh?.(
    {
      type: 'oauth',
      access: 'a',
      refresh: 'rt1',
      expires: 0,
      clientId: 'oaiapp_1',
      idToken: 'retained-id-token',
      subject: 'user-1',
      email: 'user@example.com',
    },
    AbortSignal.timeout(5000),
  )
  // A refresh rotates the tokens; the account and its retained ID token stay for a later sign-in
  expect(refreshed).toMatchObject({
    access: 'new',
    refresh: 'rt2',
    clientId: 'oaiapp_1',
    idToken: 'retained-id-token',
    subject: 'user-1',
    email: 'user@example.com',
  })
  const body = new URLSearchParams(calls[0]?.body)
  expect(body.get('grant_type')).toBe('refresh_token')
  expect(body.get('refresh_token')).toBe('rt1')
  expect(body.get('client_id')).toBe('oaiapp_1')
})

const storedCredential = {
  type: 'oauth',
  access: 'a',
  refresh: 'rt-1',
  expires: 0,
  clientId: 'oaiapp_1',
  idToken: 'retained-id-token',
  subject: 'user-1',
} as const

function chatGPTLogout() {
  const logout = openaiChatGPTLogin.logout
  if (!logout) throw new Error('Sign in with ChatGPT must support logout')
  return logout
}

test('ChatGPT logout revokes the refresh token at the published revocation endpoint', async () => {
  const calls = fakeProvider(openAIRespond(() => new Response('')))
  await chatGPTLogout()({ ...storedCredential }, AbortSignal.timeout(5000))
  const revoke = calls.find((call) => call.url === OPENAI_REVOKE)
  const body = new URLSearchParams(revoke?.body)
  expect(body.get('token')).toBe('rt-1')
  expect(body.get('token_type_hint')).toBe('refresh_token')
  expect(body.get('client_id')).toBe('oaiapp_1')
})

test('a stalled discovery still ends the sign-out within the revocation budget', async () => {
  const realFetchNow = globalThis.fetch
  let seen: AbortSignal | undefined
  // A provider that never answers, like an unreachable auth.openai.com; fetch rejects when the caller aborts
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('http://127.0.0.1')) return realFetchNow(input, init)
    seen = init?.signal ?? undefined
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new Error('The operation was aborted')),
      )
    })
  }) as typeof fetch
  const started = Date.now()
  await expect(
    chatGPTLogout()({ ...storedCredential }, new AbortController().signal),
  ).rejects.toThrow()
  // One budget covers discovery and the revocation together, so an unreachable provider cannot hold the sign-out
  expect(seen).toBeDefined()
  expect(seen?.aborted).toBe(true)
  expect(Date.now() - started).toBeLessThan(15_000)
}, 20_000)

test('a 5xx revocation is retried, and the sign-out succeeds when a later attempt does', async () => {
  const statuses = [503, 503, 200]
  const calls = fakeProvider(
    openAIRespond(() => new Response('', { status: statuses.shift() ?? 200 })),
  )
  await chatGPTLogout()({ ...storedCredential }, new AbortController().signal)
  // Discovery once, then one revocation POST per attempt
  const posts = calls.filter((call) => call.url === OPENAI_REVOKE)
  expect(posts).toHaveLength(3)
  // Every attempt carries the same documented body
  const body = new URLSearchParams(posts[1]?.body)
  expect(body.get('token')).toBe('rt-1')
  expect(body.get('client_id')).toBe('oaiapp_1')
})

test('a 4xx revocation is final: no retry, and the sign-out reports it', async () => {
  const calls = fakeProvider(
    openAIRespond(() => new Response('invalid_grant', { status: 400 })),
  )
  await expect(
    chatGPTLogout()({ ...storedCredential }, new AbortController().signal),
  ).rejects.toThrow('400')
  expect(calls.filter((call) => call.url === OPENAI_REVOKE)).toHaveLength(1)
})

test('an unreachable provider is retried until the budget runs out, then the local credential still goes', async () => {
  // Discovery answers; every revocation attempt fails like a host that cannot be reached
  const calls = fakeProvider(
    openAIRespond(() => {
      throw new Error('fetch failed: ECONNREFUSED')
    }),
  )
  const credentials = memoryCredentialStore({ openai: storedCredential })
  const registry = new ModelRegistry(
    { openai: { oauth: openaiChatGPTLogin, createModel: () => 'test-model' } },
    credentials,
  )
  const notices: string[] = []
  expect(
    await registry.logout('openai', { onNotice: (text) => notices.push(text) }),
  ).toBe(true)
  // One attempt per backoff step fits the test budget; a single POST would mean no retry at all
  expect(
    calls.filter((call) => call.url === OPENAI_REVOKE).length,
  ).toBeGreaterThan(1)
  expect(registry.credentials.list()).toEqual([])
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain('Could not confirm that openai revoked')
})

test('a credential without an issued client id cannot be revoked', async () => {
  const calls = fakeProvider(openAIRespond(() => new Response('')))
  await expect(
    chatGPTLogout()(
      { type: 'oauth', access: 'a', refresh: 'r', expires: 0 },
      AbortSignal.timeout(5000),
    ),
  ).rejects.toThrow('no issued client id')
  expect(calls).toEqual([])
})

test('logout still removes the credential when the revocation fails, and says so', async () => {
  fakeProvider(
    openAIRespond(() => new Response('server exploded', { status: 503 })),
  )
  const credentials = memoryCredentialStore({ openai: storedCredential })
  const registry = new ModelRegistry(
    { openai: { oauth: openaiChatGPTLogin, createModel: () => 'test-model' } },
    credentials,
  )
  const notices: string[] = []
  expect(
    await registry.logout('openai', { onNotice: (text) => notices.push(text) }),
  ).toBe(true)
  expect(registry.credentials.list()).toEqual([])
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain('Could not confirm that openai revoked')
})

test('logout revokes the session while the credential is still stored', async () => {
  const credentials = memoryCredentialStore({ openai: storedCredential })
  let storedDuringRevocation: string[] = []
  fakeProvider(
    openAIRespond(() => {
      storedDuringRevocation = credentials.list()
      return new Response('')
    }),
  )
  const registry = new ModelRegistry(
    { openai: { oauth: openaiChatGPTLogin, createModel: () => 'test-model' } },
    credentials,
  )
  const notices: string[] = []
  expect(
    await registry.logout('openai', { onNotice: (text) => notices.push(text) }),
  ).toBe(true)
  expect(storedDuringRevocation).toEqual(['openai'])
  expect(registry.credentials.list()).toEqual([])
  expect(notices).toEqual([])
})

test('OpenRouter sign-in exchanges the code for an API key', async () => {
  const calls = fakeProvider(
    () => new Response(JSON.stringify({ key: 'sk-or-1' })),
  )
  const user = browserUser((url) => {
    const redirect = new URL(url.searchParams.get('callback_url') as string)
    redirect.search = 'code=or-code'
    return redirect
  })
  const credential = await openRouterLogin.login(user.interaction, {})
  expect(credential).toEqual({ type: 'api_key', key: 'sk-or-1' })
  expect(JSON.parse(calls[0]?.body as string)).toMatchObject({
    code: 'or-code',
    code_challenge_method: 'S256',
  })
})

test('a pasted redirect URL finishes the sign-in when the browser cannot reach this machine', async () => {
  fakeProvider(() => new Response(JSON.stringify({ key: 'sk-or-2' })))
  const interaction: AuthInteraction = {
    signal: new AbortController().signal,
    prompt: async () => 'https://example.invalid/whatever?code=pasted',
    notify: () => {},
  }
  expect(await openRouterLogin.login(interaction, {})).toEqual({
    type: 'api_key',
    key: 'sk-or-2',
  })
})
