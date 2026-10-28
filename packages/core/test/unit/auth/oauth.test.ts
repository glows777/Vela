import { afterEach, expect, test } from 'bun:test'
import {
  chatGPTRequests,
  openaiChatGPTLogin,
} from '../../../src/auth/oauth/openai-chatgpt.ts'
import { openRouterLogin } from '../../../src/auth/oauth/openrouter.ts'
import type { AuthInteraction, AuthPrompt } from '../../../src/index.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
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
      if (event.type !== 'auth_url') return
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
  return { interaction, prompts, pages, browserPage }
}

test('Sign in with ChatGPT registers with dynamic_agent_client, then keeps the issued client id', async () => {
  const calls = fakeProvider(
    () =>
      new Response(
        JSON.stringify({
          access_token: 'at',
          refresh_token: 'rt',
          id_token: 'idt',
          expires_in: 3600,
          scope:
            'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        }),
      ),
  )
  let authorize: URL | undefined
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
  expect(credential).toMatchObject({
    type: 'oauth',
    access: 'at',
    refresh: 'rt',
    clientId: 'oaiapp_issued',
  })
  expect(authorize?.searchParams.get('client_id')).toBe('dynamic_agent_client')
  expect(authorize?.searchParams.get('agent_name_hint')).toBe('Vela')
  expect(authorize?.searchParams.get('ext_agent_host_id')).toBe(
    `urn:uuid:${DEVICE}`,
  )
  expect(authorize?.searchParams.get('redirect_uri')).toBe(
    'http://127.0.0.1:1455/auth/callback',
  )
  const exchange = new URLSearchParams(calls[0]?.body)
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
})

test('a ChatGPT grant without plan usage is refused', async () => {
  fakeProvider(
    () =>
      new Response(
        JSON.stringify({
          access_token: 'at',
          refresh_token: 'rt',
          id_token: 'idt',
          expires_in: 3600,
          scope: 'openid profile email',
        }),
      ),
  )
  const user = browserUser((url) => {
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
    },
    AbortSignal.timeout(5000),
  )
  expect(refreshed).toMatchObject({
    access: 'new',
    refresh: 'rt2',
    clientId: 'oaiapp_1',
  })
  const body = new URLSearchParams(calls[0]?.body)
  expect(body.get('grant_type')).toBe('refresh_token')
  expect(body.get('refresh_token')).toBe('rt1')
  expect(body.get('client_id')).toBe('oaiapp_1')
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
