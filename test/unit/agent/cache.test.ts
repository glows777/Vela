import { expect, test } from 'bun:test'
import { createAnthropic } from '@ai-sdk/anthropic'
import { jsonSchema, type ModelMessage, streamText, tool } from 'ai'
import { withPromptCache } from '../../../src/agent/cache.ts'

const tools = {
  read_file: tool({ inputSchema: jsonSchema({ type: 'object' }) }),
  bash: tool({ inputSchema: jsonSchema({ type: 'object' }) }),
}

test('the Anthropic request carries cache breakpoints on the system prompt, the last tool and the last message (like pi)', async () => {
  let body: Record<string, unknown> | undefined
  const anthropic = createAnthropic({
    apiKey: 'test',
    fetch: (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response(
        '{"type":"error","error":{"type":"invalid_request_error","message":"stop"}}',
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      )
    }) as typeof fetch,
  })
  const messages: ModelMessage[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second' },
  ]
  const result = streamText({
    model: anthropic('claude-sonnet-4-5'),
    maxRetries: 0,
    onError: () => {},
    ...withPromptCache({ system: 'You are Vela.', tools, messages }),
  })
  for await (const _ of result.stream) {
  }

  const ephemeral = { type: 'ephemeral' }
  expect(body?.system).toEqual([
    { type: 'text', text: 'You are Vela.', cache_control: ephemeral },
  ])
  const sentTools = body?.tools as { name: string; cache_control?: unknown }[]
  expect(sentTools.map((t) => [t.name, t.cache_control])).toEqual([
    ['read_file', undefined],
    ['bash', ephemeral],
  ])
  const sent = body?.messages as {
    content: { text: string; cache_control?: unknown }[]
  }[]
  expect(sent.at(-1)!.content.at(-1)).toMatchObject({
    text: 'second',
    cache_control: ephemeral,
  })
  expect(sent[0]!.content.at(-1)!.cache_control).toBeUndefined()
  // History is not changed
  expect(messages[2]).toEqual({ role: 'user', content: 'second' })
})
