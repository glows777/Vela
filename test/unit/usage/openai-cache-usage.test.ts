import { expect, test } from 'bun:test'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'

test('preserves OpenAI chat cache write usage', async () => {
  const model = createOpenAI({
    apiKey: 'test-key',
    baseURL: 'https://example.test/v1',
    fetch: (async () =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl-cache-test',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-5.6',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 4,
            total_tokens: 104,
            prompt_tokens_details: {
              cached_tokens: 20,
              cache_write_tokens: 30,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch,
  }).chat('gpt-5.6')

  const result = await generateText({ model, prompt: 'hello' })

  expect(result.usage.inputTokenDetails).toEqual({
    noCacheTokens: 50,
    cacheReadTokens: 20,
    cacheWriteTokens: 30,
  })
})
