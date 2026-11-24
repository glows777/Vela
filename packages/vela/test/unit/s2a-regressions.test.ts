import { afterAll, afterEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenAI } from '@ai-sdk/openai'
import { APICallError, type LanguageModelV4 } from '@ai-sdk/provider'
import { type ModelMessage as AIModelMessage, jsonSchema, tool } from 'ai'
import z from 'zod'
import { isRetryable, retryDelayMs } from '../../src/driver/agent/retry.ts'
import { StepMessage } from '../../src/driver/agent/step.ts'
import { summarize } from '../../src/driver/context/compressor.ts'
import { createRequestSnapshot } from '../../src/driver/context/request.ts'
import { loadModels, memoryCredentialStore } from '../../src/driver/index.ts'
import {
  estimateMessagesTokens,
  estimateTextTokens,
  type ModelMessage,
  stripOpaqueFields,
  withoutForeignReasoning,
} from '../../src/driver/messages.ts'
import { preamble, SystemPromptBuilder } from '../../src/driver/prompt/index.ts'
import { SessionStore } from '../../src/driver/session/index.ts'
import { ToolResultStore } from '../../src/driver/session/tool-results.ts'
import { applyEditsToNormalizedContent } from '../../src/driver/tools/edit-diff.ts'
import {
  createListDirectoryTool,
  createReadFileTool,
} from '../../src/driver/tools/file.ts'
import { ToolRegistry } from '../../src/driver/tools/registry.ts'
import { createGrepTool } from '../../src/driver/tools/search.ts'
import { TokenTracker } from '../../src/driver/usage/tracker.ts'
import { withPromptCache } from '../../src/providers/cache.ts'
import { toAiModelMessages } from '../../src/providers/messages.ts'
import { ModelRegistry } from '../../src/providers/models/index.ts'

const dir = mkdtempSync(join(tmpdir(), 'vela-s2a-unit-'))
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('weighted token estimation uses 0.25 ASCII, 1.2 CJK, 0.5 non-ASCII and strips opaque fields', () => {
  expect(estimateTextTokens('abcd')).toBe(1)
  expect(estimateTextTokens('你好世界')).toBe(5) // ceil(4 * 1.2) = 5
  expect(estimateTextTokens('éé')).toBe(1) // ceil(2 * 0.5) = 1

  const input: ModelMessage[] = [
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'ok',
          providerOptions: {
            openai: { itemId: 'msg_1', opaque: 'x'.repeat(2000) },
          },
        },
        {
          type: 'tool_result',
          toolCallId: 'c1',
          toolName: 'web_search',
          output: {
            type: 'json',
            value: {
              nested: {
                encrypted_content: 'E'.repeat(4000),
                encryptedContent: 'F'.repeat(4000),
                title: 'kept',
              },
            },
          },
        },
      ],
    },
  ]
  const stripped = stripOpaqueFields(input)
  expect(JSON.stringify(stripped)).not.toContain('encrypted_content')
  expect(JSON.stringify(stripped)).not.toContain('encryptedContent')
  // Original object stays intact while estimate stays tiny
  expect(JSON.stringify(input)).toContain('encrypted_content')
  expect(estimateMessagesTokens(input)).toBeLessThan(100)
})

test('TokenTracker calibrates from input + output tokens and includes tool/hook deltas', () => {
  const tracker = new TokenTracker()
  tracker.updateFromAPI(1000, 250, 100)
  expect(tracker.estimatedTokens).toBe(1250)

  tracker.syncToolTokens(160)
  tracker.setContextDelta(40)
  tracker.addMessage({ role: 'user', content: 'x'.repeat(40) }) // +10 ASCII tokens
  expect(tracker.estimatedTokens).toBe(1250 + 60 + 40 + 10)
  expect(tracker.reportedContextTokens).toBe(1360)

  tracker.updateFromAPI(2000, 100, 160)
  expect(tracker.estimatedTokens).toBe(2100)
})

test('summarize bounds oversized tool inputs and outputs in sourceText()', async () => {
  const requests: string[] = []
  const model = createOpenAI({
    apiKey: 'synthetic-key',
    baseURL: 'https://example.test/v1',
    fetch: (async (_url, init) => {
      const body = String(init?.body)
      requests.push(body)
      return new Response(
        JSON.stringify({
          id: 'sum',
          object: 'chat.completion',
          created: 0,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content:
                  '## Goal\nDone.\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- [x] ok\n\n## Key Decisions\n- (none)\n\n## Next Steps\n1. Continue.\n\n## Critical Context\n- (none)',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch,
  }).chat('test-model')

  const storeDir = join(dir, 'sum-store')
  mkdirSync(storeDir, { recursive: true })
  const store = new SessionStore('sum', storeDir)
  const history: ModelMessage[] = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_call',
          toolCallId: 'c1',
          toolName: 'bash',
          input: { command: 'A'.repeat(20_000) },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolCallId: 'c1',
          toolName: 'bash',
          output: { type: 'text', value: 'B'.repeat(40_000) },
        },
      ],
    },
    ...Array.from({ length: 6 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `recent-${i}`,
    })),
  ]
  const builder = new SystemPromptBuilder({
    sections: [{ name: 'preamble', render: preamble() }],
  })
  const snapshot = createRequestSnapshot(
    model,
    builder.build({ deferredToolSummary: '', sessionId: 'sum' }),
    { sdkTools: {}, toolDefinitions: [], hasHostedTools: false },
    history,
  )
  await summarize(snapshot, store, new TokenTracker())
  expect(requests).toHaveLength(1)
  expect(requests[0]!).toContain('truncated ')
  expect(requests[0]!.length).toBeLessThan(20_000)
})

test('StepMessage deep-merges nested providerMetadata and throttles incremental tool JSON parsing', async () => {
  const events: unknown[] = []
  const step = new StepMessage((e) => events.push(e))
  step.textStart('t1', {
    openai: { phase: 'commentary', nested: { a: 1 } },
  })
  step.textDelta('t1', 'hi', {
    openai: { itemId: 'msg_1', nested: { b: 2 } },
  })
  step.textEnd('t1', { anthropic: { cacheControl: { type: 'ephemeral' } } })

  expect(step.snapshot().content[0]).toEqual({
    type: 'text',
    text: 'hi',
    providerOptions: {
      openai: { phase: 'commentary', itemId: 'msg_1', nested: { a: 1, b: 2 } },
      anthropic: { cacheControl: { type: 'ephemeral' } },
    },
  })

  step.toolCallStart('tc1', 'read')
  await step.toolCallDelta('tc1', '{"a":1')
  expect((step.snapshot().content[1] as { input: unknown }).input).toEqual({
    a: 1,
  })
  // Immediate second delta within 50ms skips re-parsing partial JSON
  await step.toolCallDelta('tc1', ',"b":2}')
  expect((step.snapshot().content[1] as { input: unknown }).input).toEqual({
    a: 1,
  })
  const toolDeltaUpdates = events.filter(
    (e) =>
      (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent
        ?.type === 'toolcall_delta',
  )
  expect(toolDeltaUpdates).toHaveLength(2)
  step.toolCallEnd({
    toolCallId: 'tc1',
    toolName: 'read',
    input: { a: 1, b: 2 },
  })
  expect(step.toolCalls[0]?.input).toEqual({ a: 1, b: 2 })
})

test('withoutForeignReasoning strips foreign providerOptions from kept parts', () => {
  const own: ModelMessage = {
    role: 'assistant',
    providerOptions: { openai: { responseId: 'r_own' } },
    content: [
      {
        type: 'text',
        text: 'own',
        providerOptions: { openai: { itemId: 'msg_own' } },
      },
    ],
  }
  const foreign: ModelMessage = {
    role: 'assistant',
    providerOptions: { anthropic: { msgId: 'a_foreign' } },
    content: [
      {
        type: 'thinking',
        text: 'secret',
        providerOptions: { anthropic: { signature: 'sig' } },
      },
      {
        type: 'text',
        text: 'foreign',
        providerOptions: { anthropic: { blockId: 'b1' } },
      },
      {
        type: 'tool_call',
        toolCallId: 'c1',
        toolName: 'read',
        input: { path: 'a' },
        providerOptions: { anthropic: { signature: 'tc_sig' } },
      },
    ],
  }
  const producedBy = new Map<ModelMessage, string>([
    [own, 'openai/gpt-5'],
    [foreign, 'anthropic/claude'],
  ])
  const filtered = withoutForeignReasoning(
    [own, foreign],
    'openai/gpt-5',
    producedBy,
  )
  expect(filtered[0]).toBe(own)
  expect(filtered[1]).toEqual({
    role: 'assistant',
    content: [
      { type: 'text', text: 'foreign' },
      {
        type: 'tool_call',
        toolCallId: 'c1',
        toolName: 'read',
        input: { path: 'a' },
      },
    ],
  })
})

test('models-config strips unencrypted rs_ itemIds under store:false and applies supportsDeveloperRole on openai-completions', async () => {
  const cfgDir = join(dir, 'models-cfg')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      providers: {
        stateless: {
          api: 'openai-responses',
          baseUrl: 'https://example.test/v1',
          apiKey: 'test',
          compat: { store: false },
          models: [{ id: 'r1', reasoning: true }],
        },
        legacyChat: {
          api: 'openai-completions',
          baseUrl: 'https://example.test/v1',
          apiKey: 'test',
          compat: { supportsDeveloperRole: false },
          models: [
            {
              id: 'chat1',
              reasoning: true,
              thinkingLevelMap: { high: 'high' },
            },
          ],
        },
      },
    }),
  )
  const requests: Record<string, unknown>[] = []
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return new Response(
      JSON.stringify({
        id: 'ok',
        object: 'chat.completion',
        created: 0,
        model: 'chat1',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch

  const registry = new ModelRegistry(
    loadModels({ agentDir: cfgDir }),
    memoryCredentialStore({}),
  )
  const statelessModel = registry.resolve('stateless/r1')
    .model as LanguageModelV4
  await Promise.resolve(
    statelessModel.doGenerate({
      prompt: [
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'unencrypted',
              providerOptions: { openai: { itemId: 'rs_unencrypted' } },
            },
            {
              type: 'reasoning',
              text: 'encrypted',
              providerOptions: {
                openai: {
                  itemId: 'rs_encrypted',
                  reasoningEncryptedContent: 'enc',
                },
              },
            },
          ],
        },
      ],
    }),
  ).catch(() => {})
  const items = (requests[0]?.input as Array<Record<string, unknown>>) ?? []
  expect(items.some((item) => item.id === 'rs_unencrypted')).toBe(false)

  const chatModel = registry.resolve('legacyChat/chat1')
    .model as LanguageModelV4
  await chatModel.doGenerate({
    prompt: [
      { role: 'system', content: 'Stay concise.' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
  })
  const chatMessages = requests[1]?.messages as Array<{ role: string }>
  expect(chatMessages[0]?.role).toBe('system')
  expect(requests[1]?.reasoning_effort).toBeUndefined()
})

test('toAiModelMessages normalizes Anthropic toolCallIds with collision safety and merges consecutive assistants', () => {
  const longA = 'x'.repeat(70) + '|1'
  const longB = 'x'.repeat(70) + '|2'
  const messages: ModelMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_call', toolCallId: longA, toolName: 'read', input: {} },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'tool_call', toolCallId: longB, toolName: 'ls', input: {} },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolCallId: longA,
          toolName: 'read',
          output: { type: 'text', value: 'a' },
        },
        {
          type: 'tool_result',
          toolCallId: longB,
          toolName: 'ls',
          output: { type: 'text', value: 'b' },
        },
      ],
    },
  ]
  const converted = toAiModelMessages(messages, true, false, {
    normalizeToolCallIds: true,
  }) as AIModelMessage[]
  // Adjacent assistant messages merged into one
  expect(converted).toHaveLength(2)
  expect(converted[0]?.role).toBe('assistant')
  const assistantParts = converted[0]?.content as Array<{
    type: string
    toolCallId?: string
  }>
  expect(assistantParts).toHaveLength(2)
  const idA = assistantParts[0]!.toolCallId!
  const idB = assistantParts[1]!.toolCallId!
  expect(idA).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  expect(idB).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  expect(idA).not.toBe(idB)

  const toolParts = converted[1]?.content as Array<{ toolCallId: string }>
  expect(toolParts.map((p) => p.toolCallId)).toEqual([idA, idB])
})

test('retry classifies billing before 429, ignores unrelated status digits, walks cause chain, and honors Retry-After', () => {
  const billing429 = new APICallError({
    statusCode: 429,
    responseBody: '{"error":{"code":"insufficient_quota"}}',
    message: 'Too many requests',
    url: 'https://example.test',
    requestBodyValues: {},
  })
  expect(isRetryable(billing429)).toBe(false)

  expect(isRetryable(new Error('Failure at line 503'))).toBe(false)
  expect(isRetryable(new Error('HTTP 503 Service unavailable'))).toBe(true)

  const wrappedCause = new Error('outer failure', {
    cause: Object.assign(new Error('socket hung up'), { code: 'ETIMEDOUT' }),
  })
  expect(isRetryable(wrappedCause)).toBe(true)

  const afterError = new Error('rate limited', {
    cause: new APICallError({
      statusCode: 429,
      responseHeaders: { 'retry-after': '12' },
      responseBody: '',
      message: '429',
      url: 'https://example.test',
      requestBodyValues: {},
    }),
  })
  expect(retryDelayMs(afterError, 1, 500, 30_000)).toBe(12_000)

  const msError = new APICallError({
    statusCode: 429,
    responseHeaders: { 'retry-after-ms': '2400' },
    responseBody: '',
    message: '429',
    url: 'https://example.test',
    requestBodyValues: {},
  })
  expect(retryDelayMs(msError, 1, 500, 30_000)).toBe(2_400)
})

test('withPromptCache omits empty system and skips hosted provider tools for cache breakpoints', () => {
  const tools = {
    read: tool({ inputSchema: jsonSchema({ type: 'object' }) }),
    web_search: tool({
      type: 'provider',
      id: 'openai.web_search',
      args: {},
    } as unknown as Parameters<typeof tool>[0]),
  }
  const result = withPromptCache({
    system: '   ',
    tools,
    messages: [{ role: 'user', content: 'hi' }],
  })
  expect(result.instructions).toBeUndefined()
  expect(result.tools.read?.providerOptions?.anthropic?.cacheControl).toEqual({
    type: 'ephemeral',
  })
  expect(
    result.tools.web_search?.providerOptions?.anthropic?.cacheControl,
  ).toBeUndefined()
})

test('edit-diff rejects duplicate exact occurrences and avoids NFKC pollution on untouched same-line tokens', () => {
  expect(() =>
    applyEditsToNormalizedContent(
      'foo\nbar\nfoo\n',
      [{ oldText: 'foo', newText: 'baz' }],
      'dup.txt',
    ),
  ).toThrow('Found 2 occurrences')

  // Untouched "①" on the same line stays intact when fuzzy matching smart quotes next to it
  const out = applyEditsToNormalizedContent(
    '① say “hi”\n',
    [{ oldText: 'say "hi"', newText: 'say "bye"' }],
    'nfkc.txt',
  )
  expect(out.newContent).toBe('① say "bye"\n')
})

test('read scanLines, ls sorting with symlink dir, and grep exact limit detection work accurately', async () => {
  const fsDir = join(dir, 'tools-dir')
  const subDir = join(fsDir, 'target-sub')
  mkdirSync(subDir, { recursive: true })
  writeFileSync(join(fsDir, 'alpha.txt'), 'L1\nL2\nL3\nL4\n')
  writeFileSync(join(fsDir, 'z-file.txt'), 'needle\nneedle\n')
  writeFileSync(join(subDir, 'inside.txt'), 'hi')
  symlinkSync(subDir, join(fsDir, 'B-link'))

  const read = createReadFileTool(fsDir)
  expect(
    await read.execute({ path: 'alpha.txt', offset: 3, limit: 1 }),
  ).toContain('L3\n')

  const ls = createListDirectoryTool(fsDir)
  const listed = String(await ls.execute({})).split('\n')
  expect(listed).toEqual([
    '[FILE] alpha.txt',
    '[DIR] B-link',
    '[DIR] target-sub',
    '[FILE] z-file.txt',
  ])

  const grep = createGrepTool(fsDir)
  const exactLimit = String(
    await grep.execute({ pattern: 'needle', path: 'z-file.txt', limit: 2 }),
  )
  expect(exactLimit).not.toContain('limit reached')
  const exceeded = String(
    await grep.execute({ pattern: 'needle', path: 'z-file.txt', limit: 1 }),
  )
  expect(exceeded).toContain('limit reached')
})

test('ToolRegistry resolves ExecutionEnv lazily via ctx.requireEnv() only when requested', async () => {
  const regDir = join(dir, 'lazy-registry')
  mkdirSync(regDir, { recursive: true })
  let resolves = 0
  let sameEnv = false
  const { createLocalExecutionEnv } = await import(
    '../../src/driver/execution/local.ts'
  )
  const sharedEnv = createLocalExecutionEnv({ cwd: regDir })
  const registry = new ToolRegistry(
    new ToolResultStore(join(regDir, 'results')),
    {
      tools: new Map(),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      interception: {
        resolveEnv: async () => {
          resolves++
          return sharedEnv
        },
      },
    },
  )
  registry.register(
    {
      name: 'pure',
      description: 'no env',
      inputSchema: z.object({}),
      execute: async () => 'ok',
    },
    {
      name: 'env_user',
      description: 'needs env',
      inputSchema: z.object({}),
      execute: async (_input, ctx) => {
        const a = await ctx?.requireEnv?.()
        const b = await ctx?.requireEnv?.()
        sameEnv = Boolean(a && a === b)
        return 'done'
      },
    },
  )
  const tools = Object.fromEntries(
    registry.toProviderTools().map((t) => [t.name, t]),
  )
  await tools.pure!.execute!({}, { toolCallId: 'c1' })
  expect(resolves).toBe(0)
  await tools.env_user!.execute!({}, { toolCallId: 'c2' })
  expect(resolves).toBe(1)
  expect(sameEnv).toBe(true)
})
