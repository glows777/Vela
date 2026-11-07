import { afterEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createVela,
  loadModels,
  memoryCredentialStore,
  web,
} from '@glows777/vela-core'
import { responsesReply } from '../support/responses.ts'
import { cleanupTestVelas, createTestVela, tempDir } from '../support/vela.ts'

interface RequestBody {
  model?: string
  stream?: boolean
  store?: boolean
  input: { role?: string; type?: string }[]
  tools?: { type: string; name?: string }[]
}

const realFetch = globalThis.fetch
const dirs: { cleanup(): void }[] = []
afterEach(async () => {
  await cleanupTestVelas()
  globalThis.fetch = realFetch
  for (const dir of dirs.splice(0)) dir.cleanup()
})

function fixture(providers?: Record<string, unknown>) {
  const dir = tempDir('vela-deepseek-compat-')
  dirs.push(dir)
  if (providers)
    writeFileSync(join(dir.path, 'models.json'), JSON.stringify({ providers }))
  const requests: RequestBody[] = []
  const urls: string[] = []
  const keys: (string | null)[] = []
  globalThis.fetch = (async (input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    urls.push(String(input))
    keys.push(new Headers(init?.headers).get('authorization'))
    return responsesReply(body, 'text')
  }) as typeof fetch
  return {
    cwd: dir.path,
    providers: loadModels({
      agentDir: dir.path,
      env: { DEEPSEEK_API_KEY: 'fake-env' },
    }),
    requests,
    urls,
    keys,
  }
}

const deepseekCompat = {
  store: false,
  supportsDeveloperRole: false,
  deepseekReasoningStream: true,
}

test('built-in DeepSeek resolves the environment key and current default model', async () => {
  const f = fixture()
  expect(f.providers.deepseek?.defaultModel).toBe('deepseek-flash')
  expect(f.providers.deepseek?.apiKeyLogin).toBe(true)
  expect(f.providers.deepseek?.authSource?.(undefined)).toBe('DEEPSEEK_API_KEY')
  expect(f.providers.deepseek?.models?.map((m) => m.id)).toEqual([
    'deepseek-flash',
    'deepseek-v4-pro',
  ])
  const t = createTestVela({ ...f, model: 'deepseek/deepseek-flash' })
  await t.run('Answer OK')
  expect(f.urls).toEqual(['https://api.deepseek.com/responses'])
  expect(f.keys).toEqual(['Bearer fake-env'])
  expect(f.requests[0]).toMatchObject({
    model: 'deepseek-flash',
    store: false,
  })
  expect(f.requests[0]?.input[0]?.role).toBe('system')
  expect(t.lastAssistantText()).toBe('OK')
})

test('explicit gateway flags preserve reasoning, system role and inline tool history', async () => {
  const f = fixture({
    gateway: {
      api: 'openai-responses',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'fake-gateway',
      compat: deepseekCompat,
      models: [{ id: 'custom-deepseek', reasoning: true }],
    },
  })
  globalThis.fetch = (async (input, init) => {
    const body = JSON.parse(String(init?.body))
    f.requests.push(body)
    f.urls.push(String(input))
    return responsesReply(
      body,
      'text',
      f.requests.length === 1
        ? { name: 'read_file', arguments: '{"path":"a.txt"}' }
        : undefined,
    )
  }) as typeof fetch
  const t = createTestVela({
    ...f,
    model: 'gateway/custom-deepseek',
    files: { 'a.txt': 'gateway fixture' },
  })
  await t.run('Read a.txt then answer OK')
  expect(f.requests).toHaveLength(2)
  expect(
    f.urls.every((url) => url === 'https://gateway.example/v1/responses'),
  ).toBe(true)
  for (const request of f.requests) {
    expect(request.store).toBe(false)
    expect(request.input[0]?.role).toBe('system')
  }
  const thinking = t
    .eventsOf('message_update')
    .flatMap((e) =>
      e.assistantMessageEvent.type === 'thinking_delta'
        ? [e.assistantMessageEvent.delta]
        : [],
    )
    .join('')
  expect(thinking).toBe('Check the result.Check the result.')
  expect(f.requests[1]?.input).toContainEqual(
    expect.objectContaining({
      type: 'function_call_output',
      call_id: 'call_test',
      output: expect.stringContaining('gateway fixture'),
    }),
  )
  expect(
    f.requests[1]?.input.some(
      (item: { type?: string }) => item.type === 'item_reference',
    ),
  ).toBe(false)
  expect(t.eventsOf('tool_execution_end')[0]?.isError).toBe(false)
  expect(t.lastAssistantText()).toBe('OK')
  expect(await t.readData('sessions/default/transcript.jsonl')).toContain(
    'Check the result.',
  )
})

test.each(['deepseek-flash', 'deepseek-v4-pro'])(
  'built-in %s declares hosted search only when the model supports it',
  async (id) => {
    const f = fixture()
    const t = createTestVela({
      ...f,
      model: `deepseek/${id}`,
      extensions: [web()],
    })
    await t.run('Answer OK')
    const hosted = (f.requests[0]?.tools ?? []).filter(
      (tool: { type: string }) => tool.type === 'web_search',
    )
    expect(hosted).toHaveLength(id === 'deepseek-v4-pro' ? 1 : 0)
    expect(
      f.providers.deepseek?.models?.find((m) => m.id === id)?.compat
        ?.hostedTools,
    ).toEqual(id === 'deepseek-v4-pro' ? ['web_search'] : undefined)
  },
)

test('v4-pro search response keeps its source link in the saved conversation', async () => {
  const f = fixture()
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    f.requests.push(body)
    const search = {
      type: 'web_search_call',
      id: 'ws_1',
      status: 'completed',
      action: {
        type: 'search',
        query: 'DeepSeek',
        sources: [{ type: 'url', url: 'https://example.com/source' }],
      },
    }
    const message = {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Found it.', annotations: [] }],
    }
    const response = {
      id: 'resp_1',
      created_at: 1,
      model: body.model,
      status: 'completed',
      output: [search, message],
      usage: { input_tokens: 10, output_tokens: 2 },
    }
    const events = [
      { type: 'response.created', response },
      { type: 'response.output_item.added', output_index: 0, item: search },
      { type: 'response.output_item.done', output_index: 0, item: search },
      { type: 'response.output_item.added', output_index: 1, item: message },
      {
        type: 'response.output_text.delta',
        output_index: 1,
        item_id: 'msg_1',
        delta: 'Found it.',
      },
      { type: 'response.output_item.done', output_index: 1, item: message },
      { type: 'response.completed', response },
    ]
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof fetch
  const t = createTestVela({
    ...f,
    model: 'deepseek/deepseek-v4-pro',
    extensions: [web()],
  })
  await t.run('Find a source')
  expect(f.requests).toHaveLength(1)
  expect(t.lastAssistantText()).toContain('Found it.')
  expect(await t.readData('sessions/default/transcript.jsonl')).toContain(
    'https://example.com/source',
  )
})

test('partial DeepSeek overrides retain defaults and model-level false/empty values win', async () => {
  const f = fixture({
    deepseek: {
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'fake-config',
      compat: { includeWebSearchSources: false },
      models: [
        {
          id: 'deepseek-v4-pro',
          compat: {
            hostedTools: [],
            store: true,
            supportsDeveloperRole: true,
            deepseekReasoningStream: false,
          },
        },
      ],
    },
  })
  const before = readFileSync(join(f.cwd, 'models.json'), 'utf8')
  const t = createTestVela({
    ...f,
    model: 'deepseek/deepseek-flash',
    extensions: [web()],
  })
  await t.run('First question')
  t.session.setModel('deepseek/deepseek-v4-pro')
  await t.run('Second question')
  expect(f.requests[0]).toMatchObject({
    store: false,
  })
  expect(f.requests[0]?.input[0]?.role).toBe('system')
  expect(f.requests[1]?.store).toBe(true)
  expect(f.requests[1]?.input[0]?.role).toBe('developer')
  expect(
    (f.requests[1]?.tools ?? []).some(
      (tool: { type: string }) => tool.type === 'web_search',
    ),
  ).toBe(false)
  expect(f.keys).toEqual(['Bearer fake-config', 'Bearer fake-config'])
  expect(readFileSync(join(f.cwd, 'models.json'), 'utf8')).toBe(before)
})

test.each(['supportsDeveloperRole', 'deepseekReasoningStream'])(
  'invalid %s flags fail with the models.json field path',
  (key) => {
    expect(() => {
      fixture({
        gateway: { api: 'openai-responses', compat: { [key]: 'yes' } },
      })
    }).toThrow(`providers.gateway.compat.${key}`)
  },
)

test('DeepSeek API-key login overrides config and environment keys on the next request', async () => {
  const f = fixture({ deepseek: { apiKey: 'fake-config' } })
  const credentials = memoryCredentialStore({
    deepseek: { type: 'api_key', key: 'fake-stored' },
  })
  const vela = createVela({
    cwd: f.cwd,
    providers: f.providers,
    credentials,
    model: 'deepseek/deepseek-flash',
  })
  try {
    const session = vela.session('auth')
    await session.prompt('First question')
    await vela.login('deepseek', 'api_key', {
      signal: new AbortController().signal,
      prompt: async (question) => {
        expect(question.type).toBe('secret')
        return 'fake-login'
      },
      notify() {},
    })
    await session.prompt('Second question')
    expect(f.keys).toEqual(['Bearer fake-stored', 'Bearer fake-login'])
    expect(credentials.get('deepseek')).toEqual({
      type: 'api_key',
      key: 'fake-login',
    })
  } finally {
    await vela.dispose()
  }
})

test('a legacy DeepSeek completions override keeps its protocol and has no inherited hosted tool', async () => {
  const f = fixture({
    deepseek: { api: 'openai-completions', apiKey: 'fake-old' },
  })
  globalThis.fetch = (async (input, init) => {
    f.urls.push(String(input))
    const body = JSON.parse(String(init?.body))
    const payload = {
      id: 'chat_test',
      object: 'chat.completion.chunk',
      created: 1,
      model: body.model,
      choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }],
    }
    return new Response(
      `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof fetch
  const t = createTestVela({
    ...f,
    model: 'deepseek/deepseek-v4-pro',
    extensions: [web()],
  })
  await t.run('Answer OK')
  expect(t.lastAssistantText()).toBe('OK')
  expect(f.urls).toEqual(['https://api.deepseek.com/chat/completions'])
})

test('partial model compat retains the built-in v4-pro search declaration', () => {
  const f = fixture({
    deepseek: { models: [{ id: 'deepseek-v4-pro', compat: { store: true } }] },
  })
  expect(
    f.providers.deepseek?.models?.find((m) => m.id === 'deepseek-v4-pro')
      ?.compat,
  ).toEqual({ hostedTools: ['web_search'], store: true })
})
