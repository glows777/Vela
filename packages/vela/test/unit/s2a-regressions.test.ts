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
import {
  type ModelMessage as AIModelMessage,
  jsonSchema,
  type ToolSet,
  tool,
} from 'ai'
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

test('streamProviderStep preserves split reasoning/text metadata in both checkpoints and finalStep', async () => {
  const { streamProviderStep } = await import('../../src/providers/runtime.ts')
  const { createFauxModel } = await import('../../src/testing/core/index.ts')
  const faux = createFauxModel({
    responses: [
      {
        reasoning: 'plan',
        toolCalls: [{ name: 'ping', input: {} }],
      },
    ],
  })
  const orig = faux.doStream.bind(faux)
  faux.doStream = async (opts) => {
    const res = await orig(opts)
    return {
      ...res,
      stream: res.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (part.type === 'reasoning-start') {
              controller.enqueue({
                ...part,
                providerMetadata: {
                  openai: { reasoningEncryptedContent: 'enc-secret' },
                },
              })
              return
            }
            if (part.type === 'reasoning-end') {
              controller.enqueue({
                ...part,
                providerMetadata: { openai: { itemId: 'rs_split' } },
              })
              return
            }
            controller.enqueue(part)
          },
        }),
      ),
    }
  }
  let checkpointContent: unknown[] = []
  const { stream, getFinalStep } = streamProviderStep({
    model: faux,
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
    tools: {
      sdkTools: {
        ping: tool({ inputSchema: jsonSchema({ type: 'object' }) }),
      },
      toolDefinitions: [],
      hasHostedTools: false,
    },
    onModelCallEnd: async ({ buildCheckpoint }) => {
      checkpointContent = (await buildCheckpoint()).content as unknown[]
    },
  })
  for await (const _ of stream) {
  }
  const finalStep = await getFinalStep()
  const finalAssistant = finalStep.messages[0]
  expect(finalAssistant?.role).toBe('assistant')
  if (!finalAssistant) throw new Error('expected finalAssistant')
  const finalThinking = (
    finalAssistant.content as Array<{
      type: string
      providerOptions?: unknown
    }>
  ).find((p) => p.type === 'thinking')
  expect(finalThinking?.providerOptions).toEqual({
    openai: { reasoningEncryptedContent: 'enc-secret', itemId: 'rs_split' },
  })
  const ckptThinking = (
    checkpointContent as Array<{ type: string; providerOptions?: unknown }>
  ).find((p) => p.type === 'thinking')
  expect(ckptThinking?.providerOptions).toEqual({
    openai: { reasoningEncryptedContent: 'enc-secret', itemId: 'rs_split' },
  })
})

test('store:false Responses output strips itemIds so later API-key store:true replay emits no item_reference', async () => {
  const { streamProviderStep } = await import('../../src/providers/runtime.ts')
  const cfgDir = join(dir, 'stateless-to-stored')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      providers: {
        oauthStateless: {
          api: 'openai-responses',
          baseUrl: 'https://example.test/v1',
          apiKey: 'test',
          compat: { store: false },
          models: [{ id: 'r1', reasoning: true }],
        },
        apiStored: {
          api: 'openai-responses',
          baseUrl: 'https://example.test/v1',
          apiKey: 'test',
          compat: { store: true },
          models: [{ id: 'r1', reasoning: true }],
        },
      },
    }),
  )
  const requests: Record<string, unknown>[] = []
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    if (requests.length === 1) {
      const reasoningItem = {
        id: 'rs_stateless',
        type: 'reasoning',
        encrypted_content: 'enc-stateless',
        summary: [{ type: 'summary_text', text: 'thought' }],
      }
      const messageItem = {
        id: 'msg_stateless',
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'answer', annotations: [] }],
      }
      const response = {
        id: 'resp_1',
        created_at: 1,
        model: body.model,
        status: 'completed',
        output: [reasoningItem, messageItem],
        usage: { input_tokens: 5, output_tokens: 5 },
      }
      const events = [
        { type: 'response.created', response },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...reasoningItem, summary: [] },
        },
        {
          type: 'response.reasoning_summary_text.delta',
          output_index: 0,
          item_id: 'rs_stateless',
          summary_index: 0,
          delta: 'thought',
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: reasoningItem,
        },
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: messageItem,
        },
        {
          type: 'response.output_text.delta',
          output_index: 1,
          item_id: 'msg_stateless',
          delta: 'answer',
        },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: messageItem,
        },
        { type: 'response.completed', response },
      ]
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    const doneMsg = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }],
    }
    const doneResponse = {
      id: 'resp_2',
      created_at: 2,
      model: body.model,
      status: 'completed',
      output: [doneMsg],
      usage: { input_tokens: 5, output_tokens: 2 },
    }
    return new Response(
      [
        { type: 'response.created', response: doneResponse },
        { type: 'response.output_item.added', output_index: 0, item: doneMsg },
        {
          type: 'response.output_text.delta',
          output_index: 0,
          item_id: 'msg_2',
          delta: 'ok',
        },
        { type: 'response.output_item.done', output_index: 0, item: doneMsg },
        { type: 'response.completed', response: doneResponse },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof fetch

  const registry = new ModelRegistry(
    loadModels({ agentDir: cfgDir }),
    memoryCredentialStore({}),
  )
  const stateless = registry.resolve('oauthStateless/r1').model
  const { stream, getFinalStep } = streamProviderStep({
    model: stateless,
    system: 's',
    messages: [{ role: 'user', content: 'q1' }],
    tools: { sdkTools: {}, toolDefinitions: [], hasHostedTools: false },
  })
  for await (const _ of stream) {
  }
  const saved = (await getFinalStep()).messages
  const stored = registry.resolve('apiStored/r1').model
  const next = streamProviderStep({
    model: stored,
    system: 's',
    messages: [
      { role: 'user', content: 'q1' },
      ...saved,
      { role: 'user', content: 'q2' },
    ],
    tools: { sdkTools: {}, toolDefinitions: [], hasHostedTools: false },
  })
  for await (const _ of next.stream) {
  }
  await next.getFinalStep()
  const serialized = JSON.stringify(requests[1]?.input ?? [])
  expect(serialized).not.toContain('item_reference')
  expect(serialized).not.toContain('rs_stateless')
  expect(serialized).not.toContain('msg_stateless')
  expect(serialized).toContain('enc-stateless')
})

test('custom-named anthropic-messages provider normalizes tool IDs and deduplicates a:b vs a_b in any order', async () => {
  const { streamProviderStep } = await import('../../src/providers/runtime.ts')
  for (const pair of [
    ['a:b', 'a_b'],
    ['a_b', 'a:b'],
  ] as const) {
    const converted = toAiModelMessages(
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              toolCallId: pair[0],
              toolName: 'read',
              input: {},
            },
            {
              type: 'tool_call',
              toolCallId: pair[1],
              toolName: 'ls',
              input: {},
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: pair[0],
              toolName: 'read',
              output: { type: 'text', value: '1' },
            },
            {
              type: 'tool_result',
              toolCallId: pair[1],
              toolName: 'ls',
              output: { type: 'text', value: '2' },
            },
          ],
        },
      ],
      true,
      false,
      { normalizeToolCallIds: true },
    )
    const [first, second] = converted
    if (!first || !second) throw new Error('expected two converted messages')
    const callIds = (first.content as Array<{ toolCallId: string }>).map(
      (p) => p.toolCallId,
    )
    expect(new Set(callIds).size).toBe(2)
    expect(
      (second.content as Array<{ toolCallId: string }>).map(
        (p) => p.toolCallId,
      ),
    ).toEqual(callIds)
  }

  const cfgDir = join(dir, 'custom-anthropic')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      providers: {
        company: {
          api: 'anthropic-messages',
          baseUrl: 'https://example.test/v1',
          apiKey: 'test',
          models: [{ id: 'claude-custom' }],
        },
      },
    }),
  )
  let capturedBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ error: { message: 'stop' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const reg = new ModelRegistry(
    loadModels({ agentDir: cfgDir }),
    memoryCredentialStore({}),
  )
  const { stream } = streamProviderStep({
    model: reg.resolve('company/claude-custom').model,
    system: 's',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', toolCallId: 'a:b', toolName: 'read', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'a:b',
            toolName: 'read',
            output: { type: 'text', value: 'ok' },
          },
        ],
      },
    ],
    tools: { sdkTools: {}, toolDefinitions: [], hasHostedTools: false },
  })
  for await (const _ of stream) {
  }
  const wire = JSON.stringify(capturedBody?.messages ?? [])
  expect(wire).not.toContain('"a:b"')
  expect(wire).toContain('"a_b"')
})

test('concurrent requireEnv() calls share one resolver promise and estimateMessagesTokens strips message/nested providerOptions', async () => {
  const regDir = join(dir, 'concurrent-env')
  mkdirSync(regDir, { recursive: true })
  let resolves = 0
  let bothSame = false
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
          await Bun.sleep(10)
          return sharedEnv
        },
      },
    },
  )
  registry.register({
    name: 'concurrent',
    description: 'parallel requireEnv',
    inputSchema: z.object({}),
    execute: async (_input, ctx) => {
      const [e1, e2] = await Promise.all([
        ctx?.requireEnv?.(),
        ctx?.requireEnv?.(),
      ])
      bothSame = Boolean(e1 && e1 === e2)
      return 'ok'
    },
  })
  const tools = Object.fromEntries(
    registry.toProviderTools().map((t) => [t.name, t]),
  )
  await tools.concurrent!.execute!({}, { toolCallId: 'c1' })
  expect(resolves).toBe(1)
  expect(bothSame).toBe(true)

  const bloated: ModelMessage[] = [
    {
      role: 'user',
      content: 'x',
      providerOptions: { custom: { big: 'O'.repeat(20_000) } },
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolCallId: 'c1',
          toolName: 't',
          output: {
            type: 'content',
            value: [
              {
                type: 'text',
                text: 'y',
                providerOptions: { custom: { big2: 'P'.repeat(20_000) } },
              } as never,
            ],
          },
        },
      ],
    },
  ]
  expect(estimateMessagesTokens(bloated)).toBeLessThan(100)
})

test('retired tool lookup ignores prototype keys and config parser rejects retired tools', async () => {
  const { parseConfig } = await import('../../src/config/index.ts')
  const { getRetiredToolError } = await import(
    '../../src/shared/tool-selection.ts'
  )
  expect(getRetiredToolError(['constructor', 'toString'])).toBeUndefined()
  expect(() =>
    parseConfig(JSON.stringify({ tools: ['-read_file'] }), 'config.json'),
  ).toThrow('tool "read_file" was renamed to "read"')
})

test('streamProviderStep aligns start and end metadata when preceded by empty text blocks', async () => {
  const { streamProviderStep } = await import('../../src/providers/runtime.ts')
  const { createFauxModel } = await import('../../src/testing/core/index.ts')
  const faux = createFauxModel({
    responses: [{ text: 'ok', toolCalls: [{ name: 'ping', input: {} }] }],
  })
  const orig = faux.doStream.bind(faux)
  faux.doStream = async (opts) => {
    const res = await orig(opts)
    return {
      ...res,
      stream: res.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (part.type === 'text-start') {
              controller.enqueue({ type: 'text-start', id: 'empty-text' })
              controller.enqueue({ type: 'text-end', id: 'empty-text' })
              controller.enqueue({
                ...part,
                providerMetadata: { openai: { phase: 'commentary' } },
              })
              return
            }
            if (part.type === 'text-end') {
              controller.enqueue({
                ...part,
                providerMetadata: { openai: { itemId: 'msg_real' } },
              })
              return
            }
            controller.enqueue(part)
          },
        }),
      ),
    }
  }
  let checkpointContent: unknown
  const { stream, getFinalStep } = streamProviderStep({
    model: faux,
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
    tools: {
      sdkTools: {
        ping: tool({
          description: 'ping',
          inputSchema: jsonSchema({ type: 'object', properties: {} }),
        }),
      },
      toolDefinitions: [],
      hasHostedTools: false,
    },
    onModelCallEnd: async (event) => {
      checkpointContent = (await event.buildCheckpoint()).content
    },
  })
  for await (const _ of stream) {
  }
  const finalStep = await getFinalStep()
  const finalAssistant = finalStep.messages[0]
  if (!finalAssistant) throw new Error('expected finalAssistant')
  const finalText = (
    finalAssistant.content as Array<{ type: string; providerOptions?: unknown }>
  ).find((p) => p.type === 'text')
  expect(finalText?.providerOptions).toEqual({
    openai: { phase: 'commentary', itemId: 'msg_real' },
  })
  const ckptText = (
    checkpointContent as Array<{ type: string; providerOptions?: unknown }>
  ).find((p) => p.type === 'text')
  expect(ckptText?.providerOptions).toEqual({
    openai: { phase: 'commentary', itemId: 'msg_real' },
  })
})

test('azure store:false strips azure.itemId and replays stateless hosted web_search without item_reference', async () => {
  const cfgDir = join(dir, 'azure-stateless')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      providers: {
        azure: {
          api: 'openai-responses',
          baseUrl: 'https://example.test/v1',
          apiKey: 'test',
          compat: { store: false, hostedTools: ['web_search'] },
          models: [{ id: 'gpt-5' }],
        },
        azureStored: {
          api: 'openai-responses',
          baseUrl: 'https://example.test/v1',
          apiKey: 'test',
          compat: { store: true, hostedTools: ['web_search'] },
          models: [{ id: 'gpt-5' }],
        },
      },
    }),
  )
  const requests: Record<string, unknown>[] = []
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push(body)
    if (requests.length === 1) {
      return Response.json({
        id: 'resp_az_1',
        created_at: 1,
        model: 'gpt-5',
        status: 'completed',
        output: [
          {
            id: 'ws_stateless',
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'search', query: 'vela release' },
          },
          {
            id: 'msg_unstored',
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            content: [
              { type: 'output_text', text: 'searched', annotations: [] },
            ],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 4 },
      })
    }
    return Response.json({
      id: 'resp_az_2',
      created_at: 2,
      model: 'gpt-5',
      status: 'completed',
      output: [
        {
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok', annotations: [] }],
        },
      ],
      usage: { input_tokens: 6, output_tokens: 2 },
    })
  }) as typeof fetch
  const reg = new ModelRegistry(
    loadModels({ agentDir: cfgDir }),
    memoryCredentialStore({}),
  )
  const { generateText } = await import('ai')
  const { fromAiResponseMessage, toAiModelMessages } = await import(
    '../../src/providers/messages.ts'
  )
  const stateless = reg.resolve('azure/gpt-5').model as LanguageModelV4
  const hosted = await (
    stateless as unknown as {
      hostedTools: () => Promise<ToolSet>
    }
  ).hostedTools()
  const first = await generateText({
    model: stateless,
    prompt: 'search vela',
    tools: hosted,
    maxRetries: 0,
  })
  const saved = first.response.messages.map((m) =>
    fromAiResponseMessage(m as never),
  )
  const stored = reg.resolve('azureStored/gpt-5').model as LanguageModelV4
  await generateText({
    model: stored,
    messages: toAiModelMessages([
      { role: 'user', content: 'search vela' },
      ...saved,
      { role: 'user', content: 'follow up' },
    ]) as never,
    maxRetries: 0,
  })
  const wire = JSON.stringify(requests[1]?.input ?? [])
  expect(wire).not.toContain('item_reference')
  expect(wire).not.toContain('msg_unstored')
  expect(wire).not.toContain('ws_stateless')
  expect(wire).not.toContain('"vela"')
  expect(wire).toContain('Provider web_search')
})

test('withProviderHooks preserves custom anthropic protocol classification and edit-diff catches ligatures & overlaps', async () => {
  const { withProviderHooks } = await import('../../src/providers/hooks.ts')
  const { isAnthropicMessagesModel } = await import(
    '../../src/providers/models-config.ts'
  )
  const { streamProviderStep } = await import('../../src/providers/runtime.ts')
  const cfgDir = join(dir, 'hooked-anthropic')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      providers: {
        company: {
          api: 'anthropic-messages',
          baseUrl: 'https://example.test/v1',
          apiKey: 'test',
          models: [{ id: 'claude-custom' }],
        },
      },
    }),
  )
  let bodyMessages: unknown
  globalThis.fetch = (async (_url, init) => {
    bodyMessages = JSON.parse(String(init?.body)).messages
    return new Response(JSON.stringify({ error: { message: 'stop' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const reg = new ModelRegistry(
    loadModels({ agentDir: cfgDir }),
    memoryCredentialStore({}),
  )
  const hooked = withProviderHooks(reg.resolve('company/claude-custom').model, {
    has: () => false,
    beforeRequest: async (p) => p,
    afterResponse: async () => {},
    streamEvent: () => {},
  })
  expect(isAnthropicMessagesModel(hooked)).toBe(true)
  const { stream } = streamProviderStep({
    model: hooked,
    system: 's',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', toolCallId: 'a:b', toolName: 'read', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'a:b',
            toolName: 'read',
            output: { type: 'text', value: 'ok' },
          },
        ],
      },
    ],
    tools: { sdkTools: {}, toolDefinitions: [], hasHostedTools: false },
  })
  for await (const _ of stream) {
  }
  const wire = JSON.stringify(bodyMessages ?? [])
  expect(wire).not.toContain('"a:b"')
  expect(wire).toContain('"a_b"')

  expect(() =>
    applyEditsToNormalizedContent(
      'o\uFB03ce',
      [{ oldText: 'ic', newText: 'X' }],
      'ligature.txt',
    ),
  ).toThrow('Could not find')
  expect(() =>
    applyEditsToNormalizedContent(
      'aaa',
      [{ oldText: 'aa', newText: 'X' }],
      'overlap.txt',
    ),
  ).toThrow('Found 2 occurrences')
  expect(() =>
    applyEditsToNormalizedContent(
      'a\u2014a\u2014a',
      [{ oldText: 'a-a', newText: 'X' }],
      'overlap-fuzzy.txt',
    ),
  ).toThrow('Found 2 occurrences')
})

test('ToolRegistry binds lazy requireEnv location and rejects cross-workspace replay; TokenTracker avoids hook double-count; read offset=1 skips scanLines', async () => {
  const { createLocalExecutionEnv } = await import(
    '../../src/driver/execution/local.ts'
  )
  const wsA = join(dir, 'ws-a')
  const wsB = join(dir, 'ws-b')
  mkdirSync(wsA, { recursive: true })
  mkdirSync(wsB, { recursive: true })
  let activeCwd = wsA
  const results = new ToolResultStore(join(dir, 'lazy-loc', 'results'))
  const registry = new ToolRegistry(results, {
    tools: new Map(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    interception: {
      resolveEnv: async () => createLocalExecutionEnv({ cwd: activeCwd }),
    },
  })
  let ranIn = ''
  let notifyLocated!: () => void
  const located = new Promise<void>((resolve) => {
    notifyLocated = resolve
  })
  registry.register({
    name: 'lazy_reader',
    replay: 'safe',
    description: 'lazy env read',
    inputSchema: z.object({}),
    execute: async (_input, ctx) => {
      const env = await ctx!.requireEnv!()
      ranIn = env.cwd
      notifyLocated()
      // Simulate process interruption after env resolves (before tool_result is written)
      return await new Promise<string>(() => {})
    },
  })
  const tools = Object.fromEntries(
    registry.toProviderTools().map((t) => [t.name, t]),
  )
  void tools.lazy_reader!.execute!({}, { toolCallId: 'c-loc' })
  await located
  expect(ranIn).toBe(wsA)

  activeCwd = wsB
  ranIn = ''
  const results2 = new ToolResultStore(join(dir, 'lazy-loc', 'results'))
  await results2.resumeHistory(results.historyId)
  const registry2 = new ToolRegistry(results2, {
    tools: new Map(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    interception: {
      resolveEnv: async () => createLocalExecutionEnv({ cwd: activeCwd }),
    },
  })
  registry2.register({
    name: 'lazy_reader',
    replay: 'safe',
    description: 'lazy env read',
    inputSchema: z.object({}),
    execute: async (_input, ctx) => {
      const env = await ctx!.requireEnv!()
      ranIn = env.cwd
      return 'should not run'
    },
  })
  const recovered = await registry2.recoverToolCall('lazy_reader', 'c-loc', {})
  expect(recovered).toEqual({
    type: 'error-text',
    value: expect.stringContaining('location or input changed'),
  })
  expect(ranIn).toBe('')

  const tracker = new TokenTracker()
  tracker.setContextDelta(300)
  tracker.updateFromAPI(500, 10)
  tracker.setContextDelta(300)
  expect(tracker.estimatedTokens).toBe(510)
  tracker.setContextDelta(450)
  expect(tracker.estimatedTokens).toBe(660)

  const logPath = join(dir, 'sample.log')
  writeFileSync(logPath, 'line1\nline2\nline3\n')
  const localEnv = createLocalExecutionEnv({ cwd: dir })
  let scanCalls = 0
  const wrappedEnv = Object.assign(Object.create(localEnv), {
    openBinaryReader: async (p: string, o?: undefined, s?: AbortSignal) => {
      const res = await localEnv.openBinaryReader(p, o, s)
      if (!res.ok) return res
      const inner = res.value
      return {
        ok: true as const,
        value: Object.assign(Object.create(inner), {
          scanLines: async (
            opts: { startLine: number; endLine?: number },
            sig?: AbortSignal,
          ) => {
            scanCalls++
            return inner.scanLines(opts, sig)
          },
        }),
      }
    },
  })
  const readOut = await createReadFileTool().execute(
    { path: logPath, offset: 1, limit: 2 },
    { execution: wrappedEnv as never, results },
  )
  expect(readOut).toContain('line1')
  expect(scanCalls).toBe(0)
})
