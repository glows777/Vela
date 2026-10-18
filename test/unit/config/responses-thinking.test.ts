import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createOpenAI } from '@ai-sdk/openai'
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from '@ai-sdk/provider'
import { memoryCredentialStore } from '../../../src/auth/store.ts'
import type { Credential } from '../../../src/auth/types.ts'
import { loadModels, type ProviderConfig } from '../../../src/config/models.ts'
import { ModelRegistry, type ModelSpec } from '../../../src/models/index.ts'
import { responsesReply } from '../../support/responses.ts'
import { tempDir } from '../../support/vela.ts'

const realFetch = globalThis.fetch
const dirs: { cleanup(): void }[] = []
afterEach(() => {
  globalThis.fetch = realFetch
  for (const dir of dirs.splice(0)) dir.cleanup()
})

function fixture({
  id = 'custom-thinker',
  name = 'compat',
  baseUrl = 'https://example.test/v1',
  spec = { reasoning: true },
  api = 'openai-responses',
  credential,
  reasoning,
}: {
  id?: string
  name?: string
  baseUrl?: string
  spec?: Omit<ModelSpec, 'id'>
  api?: ProviderConfig['api']
  credential?: Credential
  reasoning?: 'text' | 'summary'
} = {}) {
  const dir = tempDir('vela-response-options-')
  dirs.push(dir)
  writeFileSync(
    join(dir.path, 'models.json'),
    JSON.stringify({
      providers: {
        [name]: { api, baseUrl, apiKey: 'test', models: [{ id, ...spec }] },
      },
    }),
  )
  const requests: Record<string, unknown>[] = []
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    if (api !== 'openai-responses') throw new Error('wire captured')
    return responsesReply(body, reasoning)
  }) as typeof fetch
  const registry = new ModelRegistry(
    loadModels({ agentDir: dir.path }),
    memoryCredentialStore(credential ? { [name]: credential } : {}),
  )
  return {
    model: registry.resolve(`${name}/${id}`).model as LanguageModelV4,
    requests,
  }
}

const options = (): LanguageModelV4CallOptions => ({
  prompt: [
    { role: 'system', content: 'Follow instructions.' },
    { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
  ],
  reasoning: 'high',
})

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

for (const method of ['doGenerate', 'doStream'] as const) {
  test(`${method}: positive metadata enables reasoning on an arbitrary model ID`, async () => {
    const { model, requests } = fixture()
    const result = await model[method](options())
    if ('stream' in result)
      for await (const _ of result.stream) {
        /* consume SDK stream */
      }
    expect(requests[0]).toMatchObject({
      reasoning: { effort: 'high' },
      input: [
        { role: 'developer', content: 'Follow instructions.' },
        { role: 'user' },
      ],
    })
    expect(requests[0]?.store).toBeUndefined()
  })
}

test.each([false, undefined])(
  'reasoning %s leaves unknown-model SDK inference unchanged',
  async (reasoning) => {
    const { model, requests } = fixture({ spec: { reasoning } })
    await model.doGenerate(options())
    expect(requests[0]?.reasoning).toBeUndefined()
    expect(requests[0]?.input).toMatchObject([
      { role: 'system' },
      { role: 'user' },
    ])
  },
)

test.each([false, undefined])(
  'reasoning %s does not disable known-model SDK inference',
  async (reasoning) => {
    const { model, requests } = fixture({ id: 'gpt-5.5', spec: { reasoning } })
    await model.doGenerate(options())
    expect(requests[0]?.reasoning).toMatchObject({ effort: 'high' })
  },
)

test.each([true, false])(
  'explicit forceReasoning %s wins over metadata',
  async (forceReasoning) => {
    const { model, requests } = fixture({
      spec: { reasoning: !forceReasoning },
    })
    await model.doGenerate({
      ...options(),
      providerOptions: { openai: { forceReasoning } },
    })
    expect(requests[0]?.reasoning).toEqual(
      forceReasoning ? { effort: 'high', summary: 'detailed' } : undefined,
    )
  },
)

test.each([
  ['high', 'low'],
  ['max', 'xhigh'],
  ['none', 'minimal'],
  ['medium', 'medium'],
] as const)(
  'maps %s to %s, retaining unmapped effort',
  async (reasoning, expected) => {
    const { model, requests } = fixture({
      spec: {
        reasoning: true,
        thinkingLevelMap: { high: 'low', max: 'xhigh', off: 'minimal' },
      },
    })
    await model.doGenerate({ ...options(), reasoning })
    expect(requests[0]?.reasoning).toMatchObject({ effort: expected })
  },
)

test('explicit reasoningEffort wins over the metadata map and generic reasoning', async () => {
  const { model, requests } = fixture({
    spec: { reasoning: true, thinkingLevelMap: { high: 'low' } },
  })
  await model.doGenerate({
    ...options(),
    providerOptions: { openai: { reasoningEffort: 'max' } },
  })
  expect(requests[0]?.reasoning).toMatchObject({ effort: 'max' })
})

test('absent and provider-default reasoning do not invent an effort', async () => {
  const { model, requests } = fixture()
  await model.doGenerate({ ...options(), reasoning: undefined })
  await model.doGenerate({ ...options(), reasoning: 'provider-default' })
  expect(requests.map((r) => r.reasoning)).toEqual([undefined, undefined])
})

test.each([
  ['https://api.deepseek.com', 'system'],
  ['https://api.deepseek.com/v1', 'system'],
  ['https://api.deepseek.com.evil.test/v1', 'developer'],
  ['https://example.test/api.deepseek.com', 'developer'],
  ['https://example.test/v1', 'developer'],
])('Responses system role on %s is %s', async (baseUrl, role) => {
  const { model, requests } = fixture({ baseUrl, id: 'deepseek-flash' })
  await model.doGenerate(options())
  expect(requests[0]?.input).toMatchObject([{ role }, { role: 'user' }])
})

test('official hostname system default is independent of positive capability', async () => {
  const { model, requests } = fixture({
    baseUrl: 'https://api.deepseek.com',
    id: 'gpt-5.5',
    spec: { reasoning: false },
  })
  await model.doGenerate(options())
  expect(requests[0]?.input).toMatchObject([
    { role: 'system' },
    { role: 'user' },
  ])
})

test.each(['developer', 'system', 'remove'])(
  'explicit systemMessageMode %s wins on DeepSeek',
  async (systemMessageMode) => {
    const { model, requests } = fixture({ baseUrl: 'https://api.deepseek.com' })
    await model.doGenerate({
      ...options(),
      providerOptions: { openai: { systemMessageMode } },
    })
    const input = requests[0]?.input as { role: string }[]
    expect(input[0]?.role).toBe(
      systemMessageMode === 'remove' ? 'user' : systemMessageMode,
    )
    expect(input).toHaveLength(systemMessageMode === 'remove' ? 1 : 2)
  },
)

test('frozen caller options, inline text/phase and tool pairing survive', async () => {
  const { model, requests } = fixture({ baseUrl: 'https://api.deepseek.com' })
  const params: LanguageModelV4CallOptions = {
    ...options(),
    maxOutputTokens: 123,
    providerOptions: {
      unrelated: { keep: 'yes' },
      openai: {
        store: false,
        user: 'test-user',
        parallelToolCalls: false,
        include: ['message.output_text.logprobs'],
      },
    },
    prompt: [
      ...options().prompt,
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Earlier answer',
            providerOptions: {
              openai: { itemId: 'msg_old', phase: 'commentary' },
            },
          },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'lookup',
            input: {},
            providerOptions: { openai: { itemId: 'fc_old' } },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'lookup',
            output: { type: 'text', value: 'Result' },
          },
        ],
      },
    ],
  }
  const before = structuredClone(params)
  await model.doGenerate(freeze(params))
  expect(params).toEqual(before)
  expect(requests[0]).toMatchObject({
    user: 'test-user',
    max_output_tokens: 123,
    parallel_tool_calls: false,
    store: false,
    input: [
      { role: 'system' },
      { role: 'user' },
      { role: 'assistant', content: 'Earlier answer', phase: 'commentary' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'Result' },
    ],
  })
})

test.each(['high', 'none'] as const)(
  'SDK filters sampling and requests encrypted reasoning even at %s',
  async (reasoning) => {
    const { model, requests } = fixture()
    const result = await model.doGenerate({
      ...options(),
      reasoning,
      temperature: 0.7,
      topP: 0.95,
      providerOptions: { openai: { store: false } },
    })
    expect(requests[0]?.reasoning).toMatchObject({ effort: reasoning })
    expect(requests[0]?.temperature).toBeUndefined()
    expect(requests[0]?.top_p).toBeUndefined()
    expect(requests[0]?.include).toContain('reasoning.encrypted_content')
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feature: 'temperature' }),
        expect.objectContaining({ feature: 'topP' }),
      ]),
    )
  },
)

test('native OpenAI retains SDK inference, mapping and early model-specific validation', async () => {
  for (const id of ['gpt-5.5', 'gpt-6']) {
    const { model, requests } = fixture({
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      id,
    })
    const params = { ...options(), reasoning: 'none' as const }
    const result = await model.doGenerate(params)
    const direct = await createOpenAI({ apiKey: 'test' })
      .responses(id)
      .doGenerate(params)
    expect(requests[0]).toEqual(requests[1])
    expect(result.warnings).toEqual(direct.warnings)
    if (id === 'gpt-6') expect(requests[0]?.reasoning).toBeUndefined()
  }
})

test.each(['openai-completions', 'anthropic-messages'] as const)(
  '%s does not receive Responses policy',
  async (api) => {
    const { model, requests } = fixture({
      api,
      baseUrl: 'https://api.deepseek.com',
      spec: { reasoning: true, thinkingLevelMap: { high: 'low' } },
    })
    await expect(model.doGenerate(options())).rejects.toThrow('wire captured')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.reasoning).toBeUndefined()
    if (api === 'openai-completions') {
      expect(requests[0]?.reasoning_effort).toBe('high')
      expect(requests[0]?.messages).toMatchObject([
        { role: 'system' },
        { role: 'user' },
      ])
    } else {
      expect(requests[0]?.system).toMatchObject([
        { type: 'text', text: 'Follow instructions.' },
      ])
    }
  },
)

test('OAuth remains authoritative over explicit role, storage and sampling options', async () => {
  const { model, requests } = fixture({
    name: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    credential: {
      type: 'oauth',
      access: 'fake-access',
      refresh: 'fake-refresh',
      expires: Date.now() + 3_600_000,
      clientId: 'fake-client',
    },
  })
  const params = freeze({
    ...options(),
    temperature: 0.7,
    topP: 0.9,
    maxOutputTokens: 100,
    providerOptions: {
      openai: {
        systemMessageMode: 'system',
        store: true,
        forceReasoning: false,
        reasoningEffort: 'low',
      },
    },
  })
  await model.doGenerate(params)
  expect(requests[0]).toMatchObject({
    store: false,
    stream: true,
    input: [{ role: 'developer' }, { role: 'user' }],
  })
  expect(requests[0]?.reasoning).toBeUndefined()
  expect(requests[0]?.temperature).toBeUndefined()
  expect(requests[0]?.top_p).toBeUndefined()
  expect(requests[0]?.max_output_tokens).toBeUndefined()
  expect(requests[0]?.include).toContain('reasoning.encrypted_content')
  expect(params.providerOptions.openai.store).toBe(true)
})

test.each([false, true])(
  'DeepSeek plaintext reasoning preserves lifecycle, metadata and raw opt-in %s',
  async (includeRawChunks) => {
    const { model } = fixture({
      baseUrl: 'https://api.deepseek.com/v1',
      reasoning: 'text',
    })
    const params = freeze({ ...options(), includeRawChunks })
    const { stream } = await model.doStream(params)
    const parts = await Array.fromAsync(stream)
    const reasoning = parts.filter((p) => p.type.startsWith('reasoning-'))
    expect(reasoning).toMatchObject([
      { type: 'reasoning-start', id: 'rs_test:0' },
      { type: 'reasoning-delta', id: 'rs_test:0', delta: 'Check ' },
      { type: 'reasoning-delta', id: 'rs_test:0', delta: 'the result.' },
      {
        type: 'reasoning-end',
        id: 'rs_test:0',
        providerMetadata: {
          openai: { reasoningEncryptedContent: 'encrypted-test' },
        },
      },
    ])
    expect(parts.filter((p) => p.type === 'raw')).toHaveLength(
      includeRawChunks ? 9 : 0,
    )
    expect(parts.some((p) => p.type === 'error')).toBe(false)
    expect(parts.at(-1)?.type).toBe('finish')
    expect(params.includeRawChunks).toBe(includeRawChunks)
  },
)

test.each([
  'https://api.openai.com/v1',
  'https://api.deepseek.com.evil.test/v1',
  'https://example.test/api.deepseek.com',
])('Responses stream behavior stays unchanged at %s', async (baseUrl) => {
  for (const reasoning of ['summary', 'text'] as const) {
    const { model } = fixture({ baseUrl, reasoning })
    const { stream } = await model.doStream(options())
    const parts = await Array.fromAsync(stream)
    expect(
      parts
        .filter((p) => p.type === 'reasoning-delta')
        .map((p) => p.delta)
        .join(''),
    ).toBe(reasoning === 'summary' ? 'Check the result.' : '')
    expect(parts.some((p) => p.type === 'raw')).toBe(false)
    expect(parts.some((p) => p.type === 'error')).toBe(false)
  }
})
