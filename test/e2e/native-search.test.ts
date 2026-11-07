import { afterEach, expect, test } from 'bun:test'
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { ExtensionAPI } from '@glows777/vela-core'
import { createFauxModel, fauxText } from '@glows777/vela-core/testing'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('a provider-executed search completes in one turn and retains its answer', async () => {
  const faux = createFauxModel({ responses: [fauxText('The answer is 42.')] })
  const original = faux.doStream.bind(faux)
  faux.doStream = async (options) => {
    const result = await original(options)
    let injected = false
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            controller.enqueue(part)
            if (!injected && part.type === 'stream-start') {
              injected = true
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'search-1',
                toolName: 'web_search',
                input: '{"query":"answer"}',
                providerExecuted: true,
              })
              controller.enqueue({
                type: 'tool-result',
                toolCallId: 'search-1',
                toolName: 'web_search',
                result: { content: '42' },
              })
            }
          },
        }),
      ),
    }
  }
  const t = createTestVela({ model: faux })
  await t.run('Search for the answer')
  expect(faux.calls).toHaveLength(1)
  expect(JSON.stringify(t.messages)).toContain('The answer is 42.')
  expect(t.eventsOf('turn_end')[0]?.toolResults).toContainEqual(
    expect.objectContaining({
      type: 'tool-result',
      toolCallId: 'search-1',
      toolName: 'web_search',
    }),
  )
})

// Real SDK serialization with a fake transport: no provider request leaves the test.
test('supported OpenAI Responses requests expose hosted search without independent keys', async () => {
  const { loadModels, web } = await import('@glows777/vela-core')
  const { responsesReply } = await import('../support/responses.ts')
  const { tempDir } = await import('../support/vela.ts')
  const dir = tempDir('vela-native-search-')
  const originalFetch = globalThis.fetch
  const requests: Array<{ tools?: Array<{ type: string; name?: string }> }> = []
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    return responsesReply(body)
  }) as typeof fetch
  try {
    const providers = loadModels({
      agentDir: dir.path,
      env: { OPENAI_API_KEY: 'test' },
    })
    const t = createTestVela({
      model: 'openai/gpt-5.5',
      providers,
      extensions: [web()],
    })
    await t.run('Search for current information')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.tools).toContainEqual(
      expect.objectContaining({ type: 'web_search' }),
    )
    expect(
      requests[0]?.tools?.filter(
        (tool) => tool.type === 'function' && tool.name === 'web_search',
      ),
    ).toHaveLength(0)
  } finally {
    globalThis.fetch = originalFetch
    dir.cleanup()
  }
})

test('GPT-5 minimal reasoning keeps independent search; higher reasoning uses hosted search', async () => {
  const { loadModels, web } = await import('@glows777/vela-core')
  const { responsesReply } = await import('../support/responses.ts')
  const { tempDir } = await import('../support/vela.ts')
  const dir = tempDir('vela-gpt5-minimal-')
  const originalFetch = globalThis.fetch
  const requests: Array<{ tools?: Array<{ type: string; name?: string }> }> = []
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    return responsesReply(body)
  }) as typeof fetch
  try {
    const providers = loadModels({
      agentDir: dir.path,
      env: { OPENAI_API_KEY: 'test' },
    })
    const t = createTestVela({
      model: 'openai/gpt-5',
      providers,
      extensions: [web({ tavilyKey: 'test' })],
    })
    t.session.setThinkingLevel('minimal')
    await t.run('First request')
    t.session.setThinkingLevel('low')
    await t.run('Second request')
    expect(requests[0]?.tools).toContainEqual(
      expect.objectContaining({ type: 'function', name: 'web_search' }),
    )
    expect(requests[0]?.tools?.some((tool) => tool.type === 'web_search')).toBe(
      false,
    )
    expect(requests[1]?.tools).toContainEqual(
      expect.objectContaining({ type: 'web_search' }),
    )
  } finally {
    globalThis.fetch = originalFetch
    dir.cleanup()
  }
})

test('Responses model reasoning map to minimal keeps independent search', async () => {
  const { loadModels, web } = await import('@glows777/vela-core')
  const { responsesReply } = await import('../support/responses.ts')
  const { tempDir } = await import('../support/vela.ts')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dir = tempDir('vela-gpt5-map-')
  writeFileSync(
    join(dir.path, 'models.json'),
    JSON.stringify({
      providers: {
        openai: {
          models: [
            {
              id: 'gpt-5.1',
              reasoning: true,
              thinkingLevelMap: { low: 'minimal' },
            },
          ],
        },
      },
    }),
  )
  const originalFetch = globalThis.fetch
  const requests: Array<{ tools?: Array<{ type: string; name?: string }> }> = []
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    return responsesReply(body)
  }) as typeof fetch
  try {
    const t = createTestVela({
      model: 'openai/gpt-5.1',
      providers: loadModels({
        agentDir: dir.path,
        env: { OPENAI_API_KEY: 'test' },
      }),
      extensions: [web({ tavilyKey: 'test' })],
    })
    t.session.setThinkingLevel('low')
    await t.run('Search')
    expect(requests[0]?.tools).toContainEqual(
      expect.objectContaining({ type: 'function', name: 'web_search' }),
    )
    expect(requests[0]?.tools?.some((tool) => tool.type === 'web_search')).toBe(
      false,
    )
  } finally {
    globalThis.fetch = originalFetch
    dir.cleanup()
  }
})

test('a tool_search-scoped hook does not disable hosted web_search', async () => {
  const { web } = await import('@glows777/vela-core')
  const { openai } = await import('@ai-sdk/openai')
  const model = Object.assign(
    createFauxModel({ responses: [fauxText('OK')] }),
    {
      hostedTools: async () => ({ web_search: openai.tools.webSearch({}) }),
    },
  )
  let request: LanguageModelV4CallOptions | undefined
  const stream = model.doStream.bind(model)
  model.doStream = async (options) => {
    request = options
    return stream(options)
  }
  const extension = (vela: ExtensionAPI) => {
    vela.on('tool_call', 'tool_search', () => {})
  }
  const t = createTestVela({ model, extensions: [web(), extension] })
  await t.run('Search')
  expect(request?.tools).toContainEqual(
    expect.objectContaining({ type: 'provider', name: 'web_search' }),
  )
})

test('a web_search-scoped blocking hook prevents hosted search', async () => {
  const { web } = await import('@glows777/vela-core')
  const { openai } = await import('@ai-sdk/openai')
  const model = Object.assign(
    createFauxModel({ responses: [fauxText('OK')] }),
    {
      hostedTools: async () => ({ web_search: openai.tools.webSearch({}) }),
    },
  )
  let request: LanguageModelV4CallOptions | undefined
  const stream = model.doStream.bind(model)
  model.doStream = async (options) => {
    request = options
    return stream(options)
  }
  const extension = (vela: ExtensionAPI) => {
    vela.on('tool_call', 'web_search', () => ({ block: true }))
  }
  const t = createTestVela({ model, extensions: [web(), extension] })
  await t.run('Search')
  expect(
    request?.tools?.some(
      (tool) => tool.type === 'provider' && tool.name === 'web_search',
    ),
  ).toBe(false)
})

test('bash permission gate does not suppress hosted web search', async () => {
  const { web, permissionGate } = await import('@glows777/vela-core')
  const { openai } = await import('@ai-sdk/openai')
  const model = Object.assign(
    createFauxModel({ responses: [fauxText('OK')] }),
    {
      hostedTools: async () => ({ web_search: openai.tools.webSearch({}) }),
    },
  )
  let request: LanguageModelV4CallOptions | undefined
  const stream = model.doStream.bind(model)
  model.doStream = async (options) => {
    request = options
    return stream(options)
  }
  const t = createTestVela({ model, extensions: [web(), permissionGate()] })
  await t.run('Search')
  expect(request?.tools).toContainEqual(
    expect.objectContaining({ type: 'provider', name: 'web_search' }),
  )
})

test('default MCP extension does not suppress hosted search', async () => {
  const { web } = await import('@glows777/vela-core')
  const { mcp } = await import('@glows777/vela-mcp')
  const { openai } = await import('@ai-sdk/openai')
  const model = Object.assign(
    createFauxModel({ responses: [fauxText('OK')] }),
    {
      hostedTools: async () => ({ web_search: openai.tools.webSearch({}) }),
    },
  )
  const t = createTestVela({ model, extensions: [web(), mcp()] })
  await t.run('Search')
  expect(model.calls[0]?.tools).toContain('web_search')
})

test.each([
  { mode: 'allow', permission: 'allow', native: true },
  { mode: 'ask', permission: 'ask', native: false },
  { mode: 'deny', permission: 'deny', native: false },
] as const)(
  'search permission $mode selects only an allowed path',
  async ({ permission, native }) => {
    const { loadModels, web } = await import('@glows777/vela-core')
    const { responsesReply } = await import('../support/responses.ts')
    const { tempDir } = await import('../support/vela.ts')
    const dir = tempDir('vela-native-permission-')
    const originalFetch = globalThis.fetch
    const requests: Array<{ tools?: Array<{ type: string; name?: string }> }> =
      []
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      return responsesReply(body)
    }) as typeof fetch
    try {
      const providers = loadModels({
        agentDir: dir.path,
        env: { OPENAI_API_KEY: 'test' },
      })
      const t = createTestVela({
        model: 'openai/gpt-5.5',
        providers,
        extensions: [web({ tavilyKey: 'test-tavily' })],
        session: { permissions: { web_search: permission } },
      })
      await t.run('Answer OK')
      const tools = requests[0]?.tools ?? []
      expect(tools.some((tool) => tool.type === 'web_search')).toBe(native)
      expect(
        tools.some(
          (tool) => tool.type === 'function' && tool.name === 'web_search',
        ),
      ).toBe(permission === 'ask')
    } finally {
      globalThis.fetch = originalFetch
      dir.cleanup()
    }
  },
)

test('a hosted search does not prevent a local tool from completing its required next turn', async () => {
  const { fauxToolCall } = await import('@glows777/vela-core/testing')
  const faux = createFauxModel({
    responses: [
      fauxToolCall('read_file', { path: 'a.txt' }),
      fauxText('Finished.'),
    ],
  })
  const original = faux.doStream.bind(faux)
  let injected = false
  faux.doStream = async (options) => {
    const result = await original(options)
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            controller.enqueue(part)
            if (!injected && part.type === 'stream-start') {
              injected = true
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'search-1',
                toolName: 'web_search',
                input: '{}',
                providerExecuted: true,
              })
              controller.enqueue({
                type: 'tool-result',
                toolCallId: 'search-1',
                toolName: 'web_search',
                result: { content: 'found' },
              })
            }
          },
        }),
      ),
    }
  }
  const t = createTestVela({ model: faux, files: { 'a.txt': 'file content' } })
  await t.run('Search and read the file')
  expect(faux.calls).toHaveLength(2)
  expect(
    faux.calls[1]?.toolResults.some(
      (result) =>
        result.toolName === 'read_file' &&
        result.output.includes('file content'),
    ),
  ).toBe(true)
  expect(t.lastAssistantText()).toBe('Finished.')
})

test('supported Anthropic Messages requests expose hosted search without independent keys', async () => {
  const { loadModels, web } = await import('@glows777/vela-core')
  const { tempDir } = await import('../support/vela.ts')
  const dir = tempDir('vela-anthropic-search-')
  const originalFetch = globalThis.fetch
  const requests: Array<{ tools?: Array<{ type: string; name?: string }> }> = []
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)))
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'OK' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof fetch
  try {
    const providers = loadModels({
      agentDir: dir.path,
      env: { ANTHROPIC_API_KEY: 'test' },
    })
    const t = createTestVela({
      model: 'anthropic/claude-sonnet-4-5',
      providers,
      extensions: [web()],
    })
    await t.run('Search for current information')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.tools).toContainEqual(
      expect.objectContaining({
        type: 'web_search_20250305',
        name: 'web_search',
      }),
    )
  } finally {
    globalThis.fetch = originalFetch
    dir.cleanup()
  }
})

test('default Anthropic Opus supports hosted search', async () => {
  const { loadModels, web } = await import('@glows777/vela-core')
  const { tempDir } = await import('../support/vela.ts')
  const dir = tempDir('vela-anthropic-search-')
  const originalFetch = globalThis.fetch
  const requests: Array<{ tools?: Array<{ type: string; name?: string }> }> = []
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)))
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'OK' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof fetch
  try {
    const providers = loadModels({
      agentDir: dir.path,
      env: { ANTHROPIC_API_KEY: 'test' },
    })
    const t = createTestVela({
      model: 'anthropic/claude-opus-4-8',
      providers,
      extensions: [web()],
    })
    await t.run('Search for current information')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.tools).toContainEqual(
      expect.objectContaining({
        type: 'web_search_20250305',
        name: 'web_search',
      }),
    )
  } finally {
    globalThis.fetch = originalFetch
    dir.cleanup()
  }
})

test.each([
  {
    label: 'custom URL',
    overrides: { openai: { baseUrl: 'https://example.test/v1' } },
  },
  {
    label: 'chat completions',
    overrides: { openai: { api: 'openai-completions' as const } },
  },
])(
  'unsupported $label does not expose hosted search',
  async ({ overrides }) => {
    const { loadModels, web } = await import('@glows777/vela-core')
    const { responsesReply } = await import('../support/responses.ts')
    const { tempDir } = await import('../support/vela.ts')
    const dir = tempDir('vela-native-unsupported-')
    const originalFetch = globalThis.fetch
    const requests: Array<{ tools?: Array<{ type: string; name?: string }> }> =
      []
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      if ('messages' in body) {
        const payload = {
          id: 'chat_test',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [
            { index: 0, delta: { content: 'OK' }, finish_reason: 'stop' },
          ],
        }
        return new Response(
          `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return responsesReply(body)
    }) as typeof fetch
    try {
      const providers = loadModels({
        agentDir: dir.path,
        env: { OPENAI_API_KEY: 'test' },
        overrides,
      })
      const t = createTestVela({
        model: 'openai/gpt-5.5',
        providers,
        extensions: [web()],
      })
      await t.run('Answer OK')
      expect(requests).toHaveLength(1)
      expect(
        (requests[0]?.tools ?? []).some(
          (tool) => tool.type === 'web_search' || tool.name === 'web_search',
        ),
      ).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      dir.cleanup()
    }
  },
)

test.each([
  {
    label: 'ask without independent credentials',
    session: { permissions: { web_search: 'ask' as const } },
  },
  {
    label: 'search excluded from selection',
    session: { tools: ['read_file'] as string[] },
  },
])(
  '$label does not expose an unapproved hosted search',
  async ({ session }) => {
    const { loadModels, web } = await import('@glows777/vela-core')
    const { responsesReply } = await import('../support/responses.ts')
    const { tempDir } = await import('../support/vela.ts')
    const dir = tempDir('vela-native-unavailable-')
    const originalFetch = globalThis.fetch
    const requests: Array<{ tools?: Array<{ type: string; name?: string }> }> =
      []
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      return responsesReply(body)
    }) as typeof fetch
    try {
      const providers = loadModels({
        agentDir: dir.path,
        env: { OPENAI_API_KEY: 'test' },
      })
      const t = createTestVela({
        model: 'openai/gpt-5.5',
        providers,
        extensions: [web()],
        session,
      })
      await t.run('Answer OK')
      expect(
        (requests[0]?.tools ?? []).some(
          (tool) => tool.type === 'web_search' || tool.name === 'web_search',
        ),
      ).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      dir.cleanup()
    }
  },
)

test('ask without an independent backend explains that search is unavailable', async () => {
  const { loadModels, web } = await import('@glows777/vela-core')
  const { responsesReply } = await import('../support/responses.ts')
  const { tempDir } = await import('../support/vela.ts')
  const dir = tempDir('vela-native-ask-')
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input, init) =>
    responsesReply(JSON.parse(String(init?.body)))) as typeof fetch
  try {
    const providers = loadModels({
      agentDir: dir.path,
      env: { OPENAI_API_KEY: 'test' },
    })
    const t = createTestVela({
      model: 'openai/gpt-5.5',
      providers,
      extensions: [web()],
      session: { permissions: { web_search: 'ask' } },
    })
    await t.run('Find current information')
    const notices = t
      .eventsOf('notify')
      .map((event) => event.message)
      .join('\n')
      .toLowerCase()
    expect(notices).toContain('search')
    expect(notices).toContain('unavailable')
  } finally {
    globalThis.fetch = originalFetch
    dir.cleanup()
  }
})

test('provider search sources remain readable in the saved conversation', async () => {
  const faux = createFauxModel({ responses: [fauxText('Here is the answer.')] })
  const original = faux.doStream.bind(faux)
  faux.doStream = async (options) => {
    const result = await original(options)
    let injected = false
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            controller.enqueue(part)
            if (!injected && part.type === 'stream-start') {
              injected = true
              controller.enqueue({
                type: 'source',
                sourceType: 'url',
                id: 'source-1',
                url: 'https://example.com/source',
                title: 'Evidence',
              })
            }
          },
        }),
      ),
    }
  }
  const t = createTestVela({ model: faux })
  await t.run('Find the source')
  expect(JSON.stringify(t.eventsOf('message_update'))).toContain(
    'https://example.com/source',
  )
  expect(await t.readData('sessions/default/transcript.jsonl')).toContain(
    'https://example.com/source',
  )
})

test('OpenAI hosted search stream is processed once and its source is retained', async () => {
  const { loadModels, web } = await import('@glows777/vela-core')
  const { tempDir } = await import('../support/vela.ts')
  const dir = tempDir('vela-search-stream-')
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = (async (_input, init) => {
    requests++
    if (requests > 1) throw new Error('unexpected duplicate request')
    const body = JSON.parse(String(init?.body))
    const search = {
      type: 'web_search_call',
      id: 'ws_1',
      status: 'completed',
      action: {
        type: 'search',
        query: 'example',
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
  try {
    const providers = loadModels({
      agentDir: dir.path,
      env: { OPENAI_API_KEY: 'test' },
    })
    const t = createTestVela({
      model: 'openai/gpt-5.5',
      providers,
      extensions: [web()],
    })
    await t.run('Find example')
    expect(requests).toBe(1)
    expect(t.lastAssistantText()).toContain('Found it.')
    expect(await t.readData('sessions/default/transcript.jsonl')).toContain(
      'https://example.com/source',
    )
  } finally {
    globalThis.fetch = originalFetch
    dir.cleanup()
  }
})

test('hosted-only search cannot be executed as a local tool on unsupported models', async () => {
  const { web } = await import('@glows777/vela-core')
  const { fauxToolCall } = await import('@glows777/vela-core/testing')
  const t = createTestVela({
    extensions: [web()],
    responses: [
      fauxToolCall('web_search', { query: 'example' }),
      fauxText('Done'),
    ],
  })
  await t.run('Search example')
  expect(t.model.calls[0]?.tools).not.toContain('web_search')
  expect(JSON.stringify(t.model.calls[1]?.toolResults)).toContain('unavailable')
})

test('switching providers replays hosted search as readable text without provider-only tool calls', async () => {
  const first = createFauxModel({
    modelId: 'first',
    responses: [fauxText('Answer.')],
  })
  const original = first.doStream.bind(first)
  first.doStream = async (options) => {
    const result = await original(options)
    let injected = false
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            controller.enqueue(part)
            if (!injected && part.type === 'stream-start') {
              injected = true
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'search-1',
                toolName: 'web_search',
                input: '{"query":"example"}',
                providerExecuted: true,
                dynamic: true,
              })
              controller.enqueue({
                type: 'tool-result',
                toolCallId: 'search-1',
                toolName: 'web_search',
                result: { url: 'https://example.com/source' },
                dynamic: true,
              })
            }
          },
        }),
      ),
    }
  }
  const second = createFauxModel({
    modelId: 'second',
    responses: [fauxText('Continued.')],
  })
  const t = createTestVela({ model: first })
  await t.run('Search example')
  t.session.setModel(second)
  await t.run('Continue')
  const request = JSON.stringify(second.calls[0]?.prompt)
  expect(request).toContain('https://example.com/source')
  expect(request).not.toContain('providerExecuted')
  expect(request).not.toContain('search-1')
})

test('an interrupted hosted search does not leave an orphan result after switching providers', async () => {
  const { fauxStreamError } = await import('@glows777/vela-core/testing')
  const first = createFauxModel({
    modelId: 'first',
    responses: [fauxStreamError('ECONNRESET', 'partial')],
  })
  const original = first.doStream.bind(first)
  first.doStream = async (options) => {
    const result = await original(options)
    let injected = false
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            controller.enqueue(part)
            if (!injected && part.type === 'stream-start') {
              injected = true
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'search-1',
                toolName: 'web_search',
                input: '{"query":"example"}',
                providerExecuted: true,
                dynamic: true,
              })
              controller.enqueue({
                type: 'tool-result',
                toolCallId: 'search-1',
                toolName: 'web_search',
                result: { url: 'https://example.com/source' },
                dynamic: true,
              })
            }
          },
        }),
      ),
    }
  }
  const second = createFauxModel({
    modelId: 'second',
    responses: [fauxText('Continued.')],
  })
  const t = createTestVela({ model: first })
  await expect(t.run('Search example')).rejects.toThrow('ECONNRESET')
  expect(t.eventsOf('turn_end')[0]?.toolResults).toContainEqual(
    expect.objectContaining({
      type: 'tool-result',
      toolCallId: 'search-1',
      toolName: 'web_search',
    }),
  )
  t.session.setModel(second)
  await t.run('Continue')
  const prompt = JSON.stringify(second.calls[0]?.prompt)
  expect(prompt).toContain('https://example.com/source')
  expect(prompt).not.toContain('search-1')
})

test('a truncated hosted search does not duplicate the server result as a local tool message', async () => {
  const faux = createFauxModel({
    responses: [fauxText('Partial.', { finishReason: 'length' })],
  })
  const original = faux.doStream.bind(faux)
  faux.doStream = async (options) => {
    const result = await original(options)
    let injected = false
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            controller.enqueue(part)
            if (!injected && part.type === 'stream-start') {
              injected = true
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'search-1',
                toolName: 'web_search',
                input: '{}',
                providerExecuted: true,
                dynamic: true,
              })
              controller.enqueue({
                type: 'tool-result',
                toolCallId: 'search-1',
                toolName: 'web_search',
                result: { url: 'https://example.com/source' },
                dynamic: true,
              })
            }
          },
        }),
      ),
    }
  }
  const t = createTestVela({ model: faux })
  await t.run('Search')
  const toolMessages = t.messages.filter((message) => message.role === 'tool')
  expect(JSON.stringify(toolMessages)).not.toContain('search-1')
})

test('an interrupted hosted search resumes safely on the same provider', async () => {
  const { fauxStreamError } = await import('@glows777/vela-core/testing')
  const model = createFauxModel({
    responses: [
      fauxStreamError('ECONNRESET', 'partial'),
      fauxText('Continued.'),
    ],
  })
  const original = model.doStream.bind(model)
  let injected = false
  model.doStream = async (options) => {
    const result = await original(options)
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            controller.enqueue(part)
            if (!injected && part.type === 'stream-start') {
              injected = true
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'search-1',
                toolName: 'web_search',
                input: '{"query":"example"}',
                providerExecuted: true,
                dynamic: true,
              })
              controller.enqueue({
                type: 'tool-result',
                toolCallId: 'search-1',
                toolName: 'web_search',
                result: { url: 'https://example.com/source' },
                dynamic: true,
              })
            }
          },
        }),
      ),
    }
  }
  const t = createTestVela({ model })
  await expect(t.run('Search')).rejects.toThrow('ECONNRESET')
  await t.run('Continue')
  const prompt = JSON.stringify(model.calls[1]?.prompt)
  expect(prompt).toContain('https://example.com/source')
  expect(prompt).not.toContain('search-1')
})

test('a disconnected hosted search is not retried after the server starts it', async () => {
  const { fauxStreamError } = await import('@glows777/vela-core/testing')
  const model = createFauxModel({
    responses: [
      fauxStreamError('ECONNRESET', 'partial'),
      fauxText('Should not retry.'),
    ],
  })
  const original = model.doStream.bind(model)
  let injected = false
  model.doStream = async (options) => {
    const result = await original(options)
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            controller.enqueue(part)
            if (!injected && part.type === 'stream-start') {
              injected = true
              controller.enqueue({
                type: 'tool-input-start',
                id: 'search-1',
                toolName: 'web_search',
                providerExecuted: true,
                dynamic: true,
              })
            }
          },
        }),
      ),
    }
  }
  const t = createTestVela({ model, allowPendingResponses: true })
  await expect(t.run('Search')).rejects.toThrow('ECONNRESET')
  expect(model.calls).toHaveLength(1)
})

test('a failed request with hosted search enabled is not automatically resent', async () => {
  const { web } = await import('@glows777/vela-core')
  const { openai } = await import('@ai-sdk/openai')
  const { fauxError } = await import('@glows777/vela-core/testing')
  const model = createFauxModel({
    responses: [
      fauxError('429 Too Many Requests'),
      fauxText('Unexpected retry.'),
    ],
  })
  Object.assign(model, {
    hostedTools: async () => ({ web_search: openai.tools.webSearch({}) }),
  })
  const t = createTestVela({
    model,
    extensions: [web()],
    allowPendingResponses: true,
  })
  await expect(t.run('Search')).rejects.toThrow('429')
  expect(model.calls).toHaveLength(1)
})

test('a provider pause resumes the hosted search rather than reporting an empty completed answer', async () => {
  const model = createFauxModel({
    responses: [fauxText(''), fauxText('Search completed.')],
  })
  const original = model.doStream.bind(model)
  let first = true
  model.doStream = async (options) => {
    const result = await original(options)
    if (!first) return result
    first = false
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (part.type === 'stream-start') {
              controller.enqueue(part)
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'search-1',
                toolName: 'web_search',
                input: '{"query":"example"}',
                providerExecuted: true,
                dynamic: true,
              })
            } else if (part.type === 'finish') {
              controller.enqueue({
                ...part,
                finishReason: { unified: 'stop', raw: 'pause_turn' },
              })
            } else controller.enqueue(part)
          },
        }),
      ),
    }
  }
  const t = createTestVela({ model })
  await t.run('Search')
  expect(model.calls).toHaveLength(2)
  expect(t.lastAssistantText()).toBe('Search completed.')
})

test('a provider hosted-tool declaration keeps its model receiver', async () => {
  const { web } = await import('@glows777/vela-core')
  const { openai } = await import('@ai-sdk/openai')
  const model = Object.assign(
    createFauxModel({ responses: [fauxText('OK')] }),
    {
      searchEnabled: true,
      async hostedTools() {
        return this.searchEnabled
          ? { web_search: openai.tools.webSearch({}) }
          : {}
      },
    },
  )
  const t = createTestVela({ model, extensions: [web()] })
  await t.run('Search')
  expect(model.calls[0]?.tools).toContain('web_search')
})

test('a hosted search result arriving after provider pause remains portable across providers', async () => {
  const first = createFauxModel({
    modelId: 'first',
    responses: [fauxText(''), fauxText('Search completed.')],
  })
  const original = first.doStream.bind(first)
  let request = 0
  first.doStream = async (options) => {
    const result = await original(options)
    const current = ++request
    let injected = false
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (part.type === 'stream-start' && !injected) {
              injected = true
              controller.enqueue(part)
              if (current === 1)
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: 'search-1',
                  toolName: 'web_search',
                  input: '{"query":"example"}',
                  providerExecuted: true,
                  dynamic: true,
                })
              else
                controller.enqueue({
                  type: 'tool-result',
                  toolCallId: 'search-1',
                  toolName: 'web_search',
                  result: { url: 'https://example.com/source' },
                  dynamic: true,
                })
            } else if (current === 1 && part.type === 'finish')
              controller.enqueue({
                ...part,
                finishReason: { unified: 'stop', raw: 'pause_turn' },
              })
            else controller.enqueue(part)
          },
        }),
      ),
    }
  }
  const second = createFauxModel({
    modelId: 'second',
    responses: [fauxText('Continued.')],
  })
  const t = createTestVela({ model: first })
  await t.run('Search')
  expect(JSON.stringify(t.eventsOf('message_end'))).toContain(
    'Search completed.',
  )
  t.session.setModel(second)
  await t.run('Continue')
  const prompt = JSON.stringify(second.calls[0]?.prompt)
  expect(prompt).toContain('https://example.com/source')
  expect(prompt).not.toContain('search-1')
})

test('custom Responses provider opts in to hosted search and stateless requests', async () => {
  const { loadModels, web } = await import('@glows777/vela-core')
  const { responsesReply } = await import('../support/responses.ts')
  const { tempDir } = await import('../support/vela.ts')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dir = tempDir('vela-custom-native-')
  writeFileSync(
    join(dir.path, 'models.json'),
    JSON.stringify({
      providers: {
        gateway: {
          api: 'openai-responses',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'test',
          compat: {
            hostedTools: ['web_search'],
            store: false,
            includeWebSearchSources: false,
          },
          models: [{ id: 'openai/gpt-4.1-mini' }],
        },
      },
    }),
  )
  const originalFetch = globalThis.fetch
  const requests: Array<{
    tools?: Array<{ type: string }>
    store?: boolean
    include?: string[]
  }> = []
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    return responsesReply(body)
  }) as typeof fetch
  try {
    const t = createTestVela({
      model: 'gateway/openai/gpt-4.1-mini',
      providers: loadModels({ agentDir: dir.path }),
      extensions: [web()],
    })
    await t.run('Find current information')
    expect(requests[0]?.tools).toContainEqual(
      expect.objectContaining({ type: 'web_search' }),
    )
    expect(requests[0]?.store).toBe(false)
    expect(requests[0]?.include ?? []).not.toContain(
      'web_search_call.action.sources',
    )
  } finally {
    globalThis.fetch = originalFetch
    dir.cleanup()
  }
})

test('a model-level empty hostedTools list disables provider opt-in', async () => {
  const { loadModels, web } = await import('@glows777/vela-core')
  const { responsesReply } = await import('../support/responses.ts')
  const { tempDir } = await import('../support/vela.ts')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dir = tempDir('vela-model-native-')
  writeFileSync(
    join(dir.path, 'models.json'),
    JSON.stringify({
      providers: {
        gateway: {
          api: 'openai-responses',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'test',
          compat: { hostedTools: ['web_search'] },
          models: [{ id: 'custom-model', compat: { hostedTools: [] } }],
        },
      },
    }),
  )
  const originalFetch = globalThis.fetch
  const requests: Array<{ tools?: Array<{ type: string; name?: string }> }> = []
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    return responsesReply(body)
  }) as typeof fetch
  try {
    const t = createTestVela({
      model: 'gateway/custom-model',
      providers: loadModels({ agentDir: dir.path }),
      extensions: [web()],
    })
    await t.run('Answer OK')
    expect(
      (requests[0]?.tools ?? []).some(
        (tool) => tool.type === 'web_search' || tool.name === 'web_search',
      ),
    ).toBe(false)
  } finally {
    globalThis.fetch = originalFetch
    dir.cleanup()
  }
})

test('custom Anthropic Messages provider sends opt-in hosted search and configured bearer header', async () => {
  const { loadModels, web } = await import('@glows777/vela-core')
  const { tempDir } = await import('../support/vela.ts')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dir = tempDir('vela-custom-anthropic-')
  writeFileSync(
    join(dir.path, 'models.json'),
    JSON.stringify({
      providers: {
        gateway: {
          api: 'anthropic-messages',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: '$TEST_OR_KEY',
          headers: { Authorization: 'Bearer $TEST_OR_KEY' },
          compat: { hostedTools: ['web_search'] },
          models: [{ id: 'anthropic/claude-haiku-4.5' }],
        },
      },
    }),
  )
  const originalFetch = globalThis.fetch
  let request:
    | {
        url: string
        headers: Headers
        body: { tools?: Array<{ type: string; name?: string }> }
      }
    | undefined
  globalThis.fetch = (async (input, init) => {
    request = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    }
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4.5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'OK' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof fetch
  try {
    const providers = loadModels({
      agentDir: dir.path,
      env: { TEST_OR_KEY: 'test-gateway-key' },
    })
    const t = createTestVela({
      model: 'gateway/anthropic/claude-haiku-4.5',
      providers,
      extensions: [web()],
    })
    await t.run('Find current information')
    expect(request?.url).toBe('https://openrouter.ai/api/v1/messages')
    expect(request?.headers.get('authorization')).toBe(
      'Bearer test-gateway-key',
    )
    expect(request?.body.tools).toContainEqual(
      expect.objectContaining({
        type: 'web_search_20250305',
        name: 'web_search',
      }),
    )
  } finally {
    globalThis.fetch = originalFetch
    dir.cleanup()
  }
})

test('hosted-search opt-in rejects a Chat Completions provider', async () => {
  const { loadModels, web } = await import('@glows777/vela-core')
  const { tempDir } = await import('../support/vela.ts')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dir = tempDir('vela-native-invalid-')
  writeFileSync(
    join(dir.path, 'models.json'),
    JSON.stringify({
      providers: {
        gateway: {
          api: 'openai-completions',
          baseUrl: 'https://example.test/v1',
          apiKey: 'test',
          compat: { hostedTools: ['web_search'] },
          models: [{ id: 'model' }],
        },
      },
    }),
  )
  try {
    const t = createTestVela({
      model: 'gateway/model',
      providers: loadModels({ agentDir: dir.path }),
      extensions: [web()],
    })
    await expect(t.run('Search')).rejects.toThrow(
      /hosted.*search.*openai-completions/i,
    )
  } finally {
    dir.cleanup()
  }
})

test('malformed hosted-tools configuration is rejected instead of enabling search', async () => {
  const { loadModels } = await import('@glows777/vela-core')
  const { tempDir } = await import('../support/vela.ts')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dir = tempDir('vela-native-invalid-compat-')
  writeFileSync(
    join(dir.path, 'models.json'),
    JSON.stringify({
      providers: {
        gateway: {
          api: 'openai-responses',
          baseUrl: 'https://example.test/v1',
          apiKey: 'test',
          compat: { hostedTools: 'web_search' },
        },
      },
    }),
  )
  try {
    expect(() => loadModels({ agentDir: dir.path })).toThrow(/hostedTools/i)
  } finally {
    dir.cleanup()
  }
})

test('model-level hosted search opt-in works when its provider has none', async () => {
  const { loadModels, web } = await import('@glows777/vela-core')
  const { responsesReply } = await import('../support/responses.ts')
  const { tempDir } = await import('../support/vela.ts')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dir = tempDir('vela-model-native-optin-')
  writeFileSync(
    join(dir.path, 'models.json'),
    JSON.stringify({
      providers: {
        gateway: {
          api: 'openai-responses',
          baseUrl: 'https://example.test/v1',
          apiKey: 'test',
          models: [{ id: 'model', compat: { hostedTools: ['web_search'] } }],
        },
      },
    }),
  )
  const originalFetch = globalThis.fetch
  const requests: Array<{ tools?: Array<{ type: string }> }> = []
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    return responsesReply(body)
  }) as typeof fetch
  try {
    const t = createTestVela({
      model: 'gateway/model',
      providers: loadModels({ agentDir: dir.path }),
      extensions: [web()],
    })
    await t.run('Find current information')
    expect(requests[0]?.tools).toContainEqual(
      expect.objectContaining({ type: 'web_search' }),
    )
  } finally {
    globalThis.fetch = originalFetch
    dir.cleanup()
  }
})

test('SDK ambient base URL variables do not override Vela model configuration', async () => {
  const { loadModels, web } = await import('@glows777/vela-core')
  const { responsesReply } = await import('../support/responses.ts')
  const { tempDir } = await import('../support/vela.ts')
  const dir = tempDir('vela-ambient-gateway-')
  const originalFetch = globalThis.fetch
  const originalBase = process.env.OPENAI_BASE_URL
  process.env.OPENAI_BASE_URL = 'https://proxy.example.test/v1'
  let url = ''
  let body: {
    model?: unknown
    stream?: unknown
    tools?: Array<{ type: string; name?: string }>
  } = {}
  globalThis.fetch = (async (input, init) => {
    url = String(input)
    body = JSON.parse(String(init?.body))
    return responsesReply(body)
  }) as typeof fetch
  try {
    const providers = loadModels({
      agentDir: dir.path,
      env: {
        OPENAI_API_KEY: 'test',
        OPENAI_BASE_URL: 'https://proxy.example.test/v1',
      },
    })
    const t = createTestVela({
      model: 'openai/gpt-5.5',
      providers,
      extensions: [web()],
    })
    await t.run('Search')
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect((body.tools ?? []).some((tool) => tool.type === 'web_search')).toBe(
      true,
    )
  } finally {
    if (originalBase === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = originalBase
    globalThis.fetch = originalFetch
    dir.cleanup()
  }
})

test('compaction archives hosted search results for recovery', async () => {
  const { readFile } = await import('node:fs/promises')
  const model = createFauxModel({
    responses: [
      fauxText('Found shipping quote.'),
      fauxText('A'),
      fauxText('B'),
      fauxText('C'),
    ],
    generate: [
      fauxText(
        '## Goal\nResearch shipping.\n## Progress\nShipping quote found.\n## Next Steps\nContinue.',
      ),
    ],
  })
  const original = model.doStream.bind(model)
  let injected = false
  model.doStream = async (options) => {
    const result = await original(options)
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            controller.enqueue(part)
            if (!injected && part.type === 'stream-start') {
              injected = true
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'search-1',
                toolName: 'web_search',
                input: '{"query":"shipping quote"}',
                providerExecuted: true,
                dynamic: true,
              })
              controller.enqueue({
                type: 'tool-result',
                toolCallId: 'search-1',
                toolName: 'web_search',
                result: {
                  url: 'https://example.com/shipping',
                  snippet: 'The exact quote ID is QUOTE-8675309.',
                },
                dynamic: true,
              })
            }
          },
        }),
      ),
    }
  }
  const t = createTestVela({ model })
  for (const input of [
    'Search shipping',
    'Later question 1',
    'Later question 2',
    'Later question 3',
  ])
    await t.run(input)
  await t.session.compact()
  const compaction = t.eventsOf('compaction_end')[0]
  expect(compaction?.result?.messages).toBe(2)
  expect(JSON.stringify(t.messages)).not.toContain('QUOTE-8675309')
  expect(await t.readData('sessions/default/transcript.jsonl')).toContain(
    'QUOTE-8675309',
  )
  const snapshotPath = (compaction?.result?.summary ?? '').match(
    /Earlier tool output: (.+) \(through seq \d+\)\./,
  )?.[1]
  expect(snapshotPath).toBeDefined()
  const snapshot = await readFile(snapshotPath!, 'utf8')
  const records = snapshot
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const archived = records.find(
    (record) =>
      record.type === 'legacy_result' &&
      record.toolCallId === 'search-1' &&
      record.toolName === 'web_search',
  )
  expect(archived).toBeDefined()
  expect(await readFile(archived.outputPath, 'utf8')).toContain('QUOTE-8675309')
})
