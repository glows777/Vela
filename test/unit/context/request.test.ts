import { afterAll, expect, test } from 'bun:test'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, type ModelMessage } from 'ai'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod'
import { ToolRegistry } from '../../../src/tools/registry'
import { SessionStore } from '../../../src/session'
import { TokenTracker } from '../../../src/usage/tracker'
import { coreRules, sessionContext, PromptPipeline } from '../../../src/prompt'
import { createRequestSnapshot } from '../../../src/context/request'
import { summarize } from '../../../src/context/compressor'
const dir = mkdtempSync(join(tmpdir(), 'vela-prefix-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('summary preserves the exact serialized main prefix and tool schemas, appending only its control message', async () => {
  const requests: {
    messages: unknown[]
    tools: unknown[]
    tool_choice?: unknown
    response_format?: unknown
  }[] = []
  const model = createOpenAI({
    apiKey: 'synthetic-test-key',
    baseURL: 'https://example.test/v1',
    fetch: (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return new Response(
        JSON.stringify({
          id: 'test',
          object: 'chat.completion',
          created: 0,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  sourceMessageCount: 2,
                  goal: {
                    sourceMessageIndex: 0,
                    quote: 'old',
                  },
                  completed: [
                    {
                      sourceMessageIndex: 1,
                      quote: 'response',
                    },
                  ],
                  pending: [],
                  constraints: [],
                  details: [],
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 5,
            total_tokens: 105,
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch,
  }).chat('test-model')
  const store = new SessionStore('prefix', dir)
  const registry = new ToolRegistry(store.results)
  registry.register(
    {
      name: 'read_file',
      description: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => 'unused',
    },
    {
      name: 'later',
      description: 'deferred',
      inputSchema: z.object({}),
      execute: async () => 'unused',
      shouldDefer: true,
    },
  )
  const builder = new PromptPipeline()
    .pipe('core', coreRules())
    .pipe('session', sessionContext())
  const system = (n: number) =>
    builder.build({
      toolCount: 1,
      deferredToolSummary: '',
      sessionMessageCount: n,
      sessionId: 'prefix',
    })
  const first: ModelMessage[] = [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'response' },
  ]
  await generateText({
    model,
    instructions: system(2),
    tools: registry.toAISDKFormat(),
    messages: first,
  })
  const history: ModelMessage[] = [
    ...first,
    ...Array.from(
      { length: 6 },
      (_, i): ModelMessage => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `next-${i}`,
      }),
    ),
  ]
  await store.replace(history, new Map(), '')
  const restored = (await store.loadState()).messages
  await generateText({
    model,
    instructions: system(8),
    tools: registry.toAISDKFormat(),
    messages: restored,
  })
  const snapshot = await createRequestSnapshot(
    model,
    system(8),
    registry.toAISDKFormat(),
    restored,
  )
  await summarize(snapshot, store.results, new TokenTracker())
  expect(requests[1]!.messages.slice(0, requests[0]!.messages.length)).toEqual(
    requests[0]!.messages,
  )
  expect(
    JSON.stringify(
      requests[2]!.messages.slice(0, requests[1]!.messages.length),
    ),
  ).toBe(JSON.stringify(requests[1]!.messages))
  expect(requests[2]!.messages).toHaveLength(requests[1]!.messages.length + 1)
  expect(JSON.stringify(requests[2]!.tools)).toBe(
    JSON.stringify(requests[1]!.tools),
  )
  expect(requests[2]!.tool_choice).toEqual(requests[1]!.tool_choice)
  expect(requests[1]!.response_format).toBeUndefined()
  expect(requests[2]!.response_format).toEqual({ type: 'json_object' })
  registry.searchTools('later')
  const discovered = await createRequestSnapshot(
    model,
    system(8),
    registry.toAISDKFormat(),
    restored,
  )
  expect(Object.keys(snapshot.tools)).toEqual(['read_file'])
  expect(Object.keys(discovered.tools)).toEqual(['read_file', 'later'])
})
