import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { Credential } from '@glows777/vela-core'
import { memoryCredentialStore } from '@glows777/vela-core'
import { tempDir } from '../../../../../test/support/vela.ts'
import { ModelRegistry } from '../../../../core/src/models/index.ts'
import { loadModels } from '../../../src/config/index.ts'

const dirs: { cleanup(): void }[] = []
const realFetch = globalThis.fetch
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
  globalThis.fetch = realFetch
})

function agentDir(models?: unknown) {
  const dir = tempDir('vela-models-')
  dirs.push(dir)
  if (models !== undefined)
    writeFileSync(join(dir.path, 'models.json'), JSON.stringify(models))
  return dir.path
}

const registryOf = (
  providers: ReturnType<typeof loadModels>,
  credentials: Record<string, Credential> = {},
) => new ModelRegistry(providers, memoryCredentialStore(credentials))

/** Captures serialized requests, then returns a non-retryable stub error. */
function captureRequests() {
  const requests: {
    url: string
    headers: Headers
    body: Record<string, unknown>
  }[] = []
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    })
    return new Response('{"error":{"message":"stub"}}', { status: 400 })
  }) as typeof fetch
  return requests
}

const call = (model: unknown) =>
  (
    model as {
      doGenerate(options: unknown): Promise<unknown>
    }
  )
    .doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoning: 'high',
    })
    .catch(() => {})

test.each([
  ['https://api.deepseek.com', false],
  ['https://api.deepseek.com/v1', false],
  ['https://api.openai.com/v1', true],
  [undefined, true],
  ['https://api.deepseek.com.example/v1', true],
] as const)(
  'Responses history at %s preserves earlier answers',
  async (baseURL, references) => {
    const requests = captureRequests()
    const registry = registryOf(
      loadModels({
        agentDir: agentDir(),
        env: { OPENAI_API_KEY: 'test-key', OPENAI_API_BASE_URL: baseURL },
      }),
    )
    const model = registry.resolve('openai/deepseek-flash').model
    if (typeof model === 'string' || model.specificationVersion !== 'v4')
      throw new Error('Expected a v4 provider model')
    const priorAnswer = {
      type: 'text' as const,
      text: 'The completed report is cobalt.',
      providerOptions: {
        openai: { itemId: 'msg_report', phase: 'final_answer' },
      },
    }
    const options: LanguageModelV4CallOptions = {
      prompt: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Summarize the file.' }],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_read',
              toolName: 'read_file',
              input: { path: 'a.txt' },
              providerOptions: { openai: { itemId: 'fc_read' } },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_read',
              toolName: 'read_file',
              output: { type: 'text', value: 'cobalt' },
            },
          ],
        },
        { role: 'assistant', content: [priorAnswer] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    }
    const original = structuredClone(options)
    await Promise.resolve(model.doGenerate(options)).catch(() => {})
    expect(requests.at(-1)?.body.input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'Summarize the file.' }],
      },
      {
        type: 'function_call',
        call_id: 'call_read',
        name: 'read_file',
        arguments: '{"path":"a.txt"}',
      },
      { type: 'function_call_output', call_id: 'call_read', output: 'cobalt' },
      references
        ? { type: 'item_reference', id: 'msg_report' }
        : {
            role: 'assistant',
            content: priorAnswer.text,
            phase: 'final_answer',
          },
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ])
    expect(options).toEqual(original)
    if (references) expect(requests.at(-1)?.body).not.toHaveProperty('store')
    else expect(requests.at(-1)?.body.store).toBe(false)
  },
)

test.each([
  ['openai-responses', 'https://api.deepseek.com', false],
  ['openai-responses', 'https://api.openai.com/v1', true],
  ['openai-completions', 'https://api.deepseek.com', true],
] as const)(
  '%s at %s scopes the effective store option without mutating caller options',
  async (api, baseUrl, expectedStore) => {
    const requests = captureRequests()
    const registry = registryOf(
      loadModels({
        agentDir: agentDir({
          providers: { local: { api, baseUrl, apiKey: 'test-key' } },
        }),
        env: {},
      }),
    )
    const model = registry.resolve('local/deepseek-flash').model
    if (typeof model === 'string' || model.specificationVersion !== 'v4')
      throw new Error('Expected a v4 provider model')
    const options: LanguageModelV4CallOptions = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: {
        openai: { store: true, parallelToolCalls: false },
        other: { flag: 'keep' },
      },
    }
    const original = structuredClone(options)
    await Promise.resolve(model.doGenerate(options)).catch(() => {})
    expect(requests.at(-1)?.body).toMatchObject({
      store: expectedStore,
      parallel_tool_calls: false,
    })
    expect(options).toEqual(original)
  },
)

test('anthropic, openai and openrouter are built in, with models and defaults from the catalog', () => {
  const providers = loadModels({ agentDir: agentDir(), env: {} })
  expect(Object.keys(providers)).toEqual(['anthropic', 'openai', 'openrouter'])
  const registry = registryOf(providers)
  const all = registry.list()
  for (const provider of ['anthropic', 'openai', 'openrouter'])
    expect(all.some((m) => m.provider === provider)).toBe(true)
  // Like pi: openai speaks the Responses API
  expect(registry.resolve('openai/gpt-5.5').model).toMatchObject({
    provider: 'openai.responses',
  })
  expect(registry.resolve('openai/gpt-5.5').info).toMatchObject({
    contextWindow: expect.any(Number),
    reasoning: true,
  })
  // No credential anywhere: nothing is available and there is no default
  expect(registry.available()).toEqual([])
  expect(registry.defaultRef()).toBeUndefined()
})

test('a provider becomes available with a key, and the first one in pi order supplies the default model', () => {
  const env = { OPENROUTER_API_KEY: 'r', OPENAI_API_KEY: 'o' }
  const registry = registryOf(loadModels({ agentDir: agentDir(), env }))
  expect(new Set(registry.available().map((m) => m.provider))).toEqual(
    new Set(['openai', 'openrouter']),
  )
  expect(registry.defaultRef()).toBe('openai/gpt-5.5')
  expect(registry.authSource('openai')).toBe('OPENAI_API_KEY')
  expect(registry.authSource('anthropic')).toBeUndefined()
})

test('requests use auth.json first, then models.json, then the environment variable (like pi)', async () => {
  const requests = captureRequests()
  const dir = agentDir({
    providers: { anthropic: { apiKey: 'from-models-json' } },
  })
  const providers = loadModels({
    agentDir: dir,
    env: { ANTHROPIC_API_KEY: 'from-env' },
  })

  await call(registryOf(providers).resolve('anthropic/claude-opus-4-8').model)
  expect(requests.at(-1)?.headers.get('x-api-key')).toBe('from-models-json')

  const stored = registryOf(providers, {
    anthropic: { type: 'api_key', key: 'stored' },
  })
  await call(stored.resolve('anthropic/claude-opus-4-8').model)
  expect(requests.at(-1)?.headers.get('x-api-key')).toBe('stored')

  const envOnly = loadModels({
    agentDir: agentDir(),
    env: { OPENAI_API_KEY: 'from-env' },
  })
  await call(registryOf(envOnly).resolve('openai/gpt-5.5').model)
  expect(requests.at(-1)?.headers.get('authorization')).toBe('Bearer from-env')
})

test('the key is read per request, so /login takes effect without recreating the model', async () => {
  const requests = captureRequests()
  const registry = registryOf(loadModels({ agentDir: agentDir(), env: {} }))
  const model = registry.resolve('openai/gpt-5.5').model
  await registry.credentials.modify('openai', async () => ({
    type: 'api_key',
    key: 'one',
  }))
  await call(model)
  await registry.credentials.modify('openai', async () => ({
    type: 'api_key',
    key: 'two',
  }))
  await call(model)
  expect(requests.map((r) => r.headers.get('authorization'))).toEqual([
    'Bearer one',
    'Bearer two',
  ])
})

test('a missing API key fails the request, naming /login and the variable', async () => {
  const registry = registryOf(loadModels({ agentDir: agentDir(), env: {} }))
  const model = registry.resolve('anthropic/claude-opus-4-8')
    .model as unknown as {
    doGenerate(options: unknown): Promise<unknown>
  }
  const error = await model
    .doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    .catch((e: unknown) => e)
  expect(String(error)).toContain('run /login anthropic')
  expect(String(error)).toContain('ANTHROPIC_API_KEY')
})

test('openrouter gets reasoning as { effort } (pi thinkingFormat openrouter)', async () => {
  const requests = captureRequests()
  const providers = loadModels({
    agentDir: agentDir(),
    env: { OPENROUTER_API_KEY: 'r' },
  })
  await call(registryOf(providers).resolve('openrouter/openai/gpt-5').model)
  const body = requests.at(-1)?.body as Record<string, unknown>
  expect(requests.at(-1)?.url).toBe(
    'https://openrouter.ai/api/v1/chat/completions',
  )
  expect(body.reasoning).toEqual({ effort: 'high' })
  expect(body.reasoning_effort).toBeUndefined()
})

test('an OAuth credential for a provider without an OAuth sign-in is an error, not ignored', async () => {
  const registry = registryOf(
    loadModels({ agentDir: agentDir(), env: { ANTHROPIC_API_KEY: 'k' } }),
    {
      anthropic: {
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: Date.now() + 3_600_000,
      },
    },
  )
  const model = registry.resolve('anthropic/claude-opus-4-8')
    .model as unknown as {
    doGenerate(options: unknown): Promise<unknown>
  }
  const error = await model
    .doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    .catch((e: unknown) => e)
  expect(String(error)).toContain('run /logout anthropic')
})

test('models.json adds providers and merges into built-in ones', () => {
  const dir = agentDir({
    providers: {
      // Only models given: adds a model; api / key still come from the built-in provider
      openai: { models: [{ id: 'gpt-x', contextWindow: 400_000 }] },
      local: {
        api: 'openai-responses',
        baseUrl: 'http://localhost:1234/v1',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: ${LOCAL_KEY} is settings interpolation syntax, kept literal here
        apiKey: '${LOCAL_KEY}',
        models: [
          { id: 'm', name: 'Local M', reasoning: false },
          // A well-known id gets the catalog's metadata
          { id: 'claude-opus-4-8' },
        ],
      },
    },
  })
  const providers = loadModels({
    agentDir: dir,
    env: { OPENAI_API_KEY: 'k', LOCAL_KEY: 'l' },
  })
  const registry = registryOf(providers)
  const refs = registry.list().map((m) => m.ref)
  expect(refs).toContain('openai/gpt-x')
  expect(refs.filter((ref) => ref.startsWith('local/'))).toEqual([
    'local/m',
    'local/claude-opus-4-8',
  ])
  expect(registry.resolve('openai/gpt-x').info.contextWindow).toBe(400_000)
  const local = registry.resolve('local/m')
  expect(local.model).toMatchObject({ provider: 'local.responses' })
  expect(local.info).toMatchObject({ name: 'Local M', reasoning: false })
  expect(registry.resolve('local/claude-opus-4-8').info.cost).toBeDefined()
  expect(registry.authSource('local')).toBe('LOCAL_KEY')
})

test('mistakes in models.json are reported with the file name', () => {
  const notJson = agentDir()
  writeFileSync(join(notJson, 'models.json'), '{')
  expect(() => loadModels({ agentDir: notJson })).toThrow('is not valid JSON')
  expect(() =>
    loadModels({ agentDir: agentDir({ providers: { x: { api: 'grpc' } } }) }),
  ).toThrow('providers.x.api must be one of')
  expect(() =>
    loadModels({
      agentDir: agentDir({ providers: { x: { models: [{ name: 'no id' }] } } }),
    }),
  ).toThrow('providers.x.models must be an array of objects with an id')
  // A new provider without api: fails only when used
  const noApi = loadModels({
    agentDir: agentDir({ providers: { x: { apiKey: 'k' } } }),
  })
  expect(() => registryOf(noApi).resolve('x/m')).toThrow(
    'providers.x is missing api',
  )
})

test('a ChatGPT sign-in is used by local sessions but refused in channel sessions', async () => {
  const requests = captureRequests()
  const registry = registryOf(loadModels({ agentDir: agentDir(), env: {} }), {
    openai: {
      type: 'oauth',
      access: 'chatgpt-token',
      refresh: 'r',
      expires: Date.now() + 3_600_000,
      clientId: 'oaiapp_1',
    },
  })
  const doGenerate = (model: unknown) =>
    (model as { doGenerate(options: unknown): Promise<unknown> })
      .doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })
      .catch((e: unknown) => e)

  await doGenerate(registry.resolve('openai/gpt-5.5').model)
  expect(requests.at(-1)?.url).toBe('https://api.openai.com/v1/responses')
  expect(requests.at(-1)?.headers.get('authorization')).toBe(
    'Bearer chatgpt-token',
  )

  const error = await doGenerate(
    registry.resolve('openai/gpt-5.5', { channel: () => 'lark' }).model,
  )
  expect(String(error)).toContain('only for the local terminal, not for lark')
  expect(requests).toHaveLength(1)
})
