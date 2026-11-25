import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'
import z from 'zod'
import { summarize } from '../../../../src/driver/context/compressor.ts'
import { createRequestSnapshot } from '../../../../src/driver/context/request.ts'
import type { ModelMessage } from '../../../../src/driver/messages.ts'
import {
  preamble,
  SystemPromptBuilder,
} from '../../../../src/driver/prompt/index.ts'
import { SessionStore } from '../../../../src/driver/session/index.ts'
import { ToolRegistry } from '../../../../src/driver/tools/registry.ts'
import { TokenTracker } from '../../../../src/driver/usage/tracker.ts'
import {
  resolveProviderTools,
  toAiModelMessages,
} from '../../../../src/providers/index.ts'

const dir = mkdtempSync(join(tmpdir(), 'vela-prefix-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('summary sends only the dropped messages as text, without tool definitions', async () => {
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
                content:
                  '## Goal\nContinue the old task.\n\n## Progress\n### Done\n- response\n\n## Next Steps\n1. Continue.',
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
  const store = new SessionStore('prefix', join(dir, 'vela.db'))
  const registry = new ToolRegistry(join(dir, 'results'))
  registry.register(
    {
      name: 'read',
      description: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => 'unused',
    },
    {
      name: 'later',
      description: 'deferred',
      inputSchema: z.object({}),
      execute: async () => 'unused',
      exposure: 'deferred',
    },
  )
  const builder = new SystemPromptBuilder({
    sections: [{ name: 'preamble', render: preamble() }],
  })
  const system = () =>
    builder.build({ deferredToolSummary: '', sessionId: 'prefix' })
  const first: ModelMessage[] = [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'response' },
  ]
  const initialTools = await resolveProviderTools(
    model,
    registry.toProviderTools(),
  )
  await generateText({
    model,
    instructions: system(),
    tools: initialTools.sdkTools,
    messages: toAiModelMessages(first),
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
  for (const message of history) store.appendMessage(message)
  await store.flush()
  const restored = (await store.loadSaved())?.messages ?? []
  await generateText({
    model,
    instructions: system(),
    tools: initialTools.sdkTools,
    messages: toAiModelMessages(restored),
  })
  const snapshot = createRequestSnapshot(
    model,
    system(),
    initialTools,
    restored,
  )
  await summarize(snapshot, store, new TokenTracker())
  expect(requests[1]!.messages.slice(0, requests[0]!.messages.length)).toEqual(
    requests[0]!.messages,
  )
  const summaryReq = requests[2]!
  expect(summaryReq.messages).toHaveLength(2)
  expect(summaryReq.tools).toBeUndefined()
  expect(summaryReq.tool_choice).toBeUndefined()
  expect(JSON.stringify(summaryReq.messages[0])).not.toContain('preamble')
  const conversation = JSON.stringify(summaryReq.messages[1])
  expect(conversation).toContain('old')
  expect(conversation).toContain('response')
  expect(requests[1]!.response_format).toBeUndefined()
  expect(summaryReq.response_format).toBeUndefined()
  await registry.searchTools('later')
  const discoveredTools = await resolveProviderTools(
    model,
    registry.toProviderTools(),
  )
  const discovered = createRequestSnapshot(
    model,
    system(),
    discoveredTools,
    restored,
  )
  expect(Object.keys(snapshot.tools.sdkTools)).toEqual(['read'])
  expect(Object.keys(discovered.tools.sdkTools)).toEqual(['read', 'later'])
})
