import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { ChannelExtension as VelaExtension } from '@glows777/vela-channels'
import type { ImageContent, ModelMessage } from '@glows777/vela-core'
import { ToolExecutionResult } from '@glows777/vela-core'
import { simulateStreamingMiddleware, wrapLanguageModel } from 'ai'
import { z } from 'zod'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

const image: ImageContent = {
  type: 'image',
  data: readFileSync(
    new URL('../fixtures/images/blue.png', import.meta.url),
  ).toString('base64'),
  mimeType: 'image/png',
}
const dataUrl = `data:${image.mimeType};base64,${image.data}`

type Provider = 'anthropic' | 'responses' | 'chat'
interface WirePart {
  role?: string
  type?: string
  tool_call_id?: string
  tool_use_id?: string
  call_id?: string
  content?: string | WirePart[]
  output?: string | WirePart[]
  text?: string
  source?: { type: string; media_type: string; data: string }
  image_url?: string | { url: string }
}
interface WireRequest {
  messages?: WirePart[]
  input?: WirePart[]
}

/** Actual provider adapters serialize every request; all responses come from this offline fixture. */
function providerFixture(provider: Provider, variants = ['mixed']) {
  const requests: WireRequest[] = []
  const calls = variants.map((variant, index) => ({
    id: `call_${index + 1}`,
    name: 'pictures_render',
    input: { variant },
  }))
  const fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as WireRequest)
    if (requests.length > 2)
      throw new Error('Unexpected extra provider request')
    const first = requests.length === 1
    let response: unknown
    if (provider === 'anthropic') {
      response = {
        id: `message_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: first
          ? calls.map((call) => ({ type: 'tool_use', ...call }))
          : [{ type: 'text', text: 'Seen.' }],
        stop_reason: first ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }
    } else if (provider === 'responses') {
      response = {
        id: `response_${requests.length}`,
        model: 'gpt-4o',
        status: 'completed',
        output: first
          ? calls.map((call) => ({
              type: 'function_call',
              id: `function_${call.id}`,
              call_id: call.id,
              name: call.name,
              arguments: JSON.stringify(call.input),
            }))
          : [
              {
                type: 'message',
                role: 'assistant',
                id: 'message_2',
                content: [
                  { type: 'output_text', text: 'Seen.', annotations: [] },
                ],
              },
            ],
        usage: { input_tokens: 10, output_tokens: 5 },
      }
    } else {
      response = {
        id: `response_${requests.length}`,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: first
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: calls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: {
                      name: call.name,
                      arguments: JSON.stringify(call.input),
                    },
                  })),
                }
              : { role: 'assistant', content: 'Seen.' },
            finish_reason: first ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }
    }
    return Response.json(response)
  }) as typeof globalThis.fetch
  const settings = { apiKey: 'offline-fixture', fetch }
  const model =
    provider === 'anthropic'
      ? createAnthropic(settings)('claude-sonnet-4-5')
      : createOpenAI({ ...settings, name: 'image-test-gateway' })[provider](
          'gpt-4o',
        )
  return {
    requests,
    model: wrapLanguageModel({
      model,
      middleware: simulateStreamingMiddleware(),
    }),
  }
}

const pictures: VelaExtension = (vela) => {
  vela.registerTool({
    name: 'render',
    description: 'Return an image',
    inputSchema: z.object({ variant: z.enum(['mixed', 'image-only']) }),
    execute: async ({ variant }: { variant: string }) =>
      new ToolExecutionResult(
        { variant },
        variant === 'image-only'
          ? [image]
          : [{ type: 'text', text: 'Image from the picture tool.' }, image],
      ),
  })
}

function expectCanonicalHistory(messages: ModelMessage[], count = 1) {
  const results = messages.flatMap((message) =>
    message.role === 'tool' ? message.content : [],
  )
  expect(results).toHaveLength(count)
  for (const result of results) {
    expect(result).toMatchObject({
      type: 'tool-result',
      output: { type: 'content' },
    })
    if (result.type !== 'tool-result' || result.output.type !== 'content')
      throw new Error('Expected canonical tool content')
    expect(result.output.value).toContainEqual(image)
  }
  expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
}

test('Anthropic receives tool images inside its native tool_result content', async () => {
  const provider = providerFixture('anthropic')
  const t = createTestVela({ model: provider.model, extensions: [pictures] })
  await t.run('Show me a picture')
  expect(provider.requests).toHaveLength(2)
  const messages = provider.requests[1]?.messages ?? []
  const results = messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => part.type === 'tool_result')
      : [],
  )
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({
    tool_use_id: 'call_1',
    content: [
      { type: 'text', text: 'Image from the picture tool.' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mimeType,
          data: image.data,
        },
      },
    ],
  })
  expectCanonicalHistory(t.messages)
})

test('OpenAI Responses receives tool images inside native function_call_output', async () => {
  const provider = providerFixture('responses')
  const t = createTestVela({ model: provider.model, extensions: [pictures] })
  await t.run('Show me a picture')
  expect(provider.requests).toHaveLength(2)
  const results = (provider.requests[1]?.input ?? []).filter(
    (part) => part.type === 'function_call_output',
  )
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({
    call_id: 'call_1',
    output: [
      { type: 'input_text', text: 'Image from the picture tool.' },
      { type: 'input_image', image_url: dataUrl },
    ],
  })
  expectCanonicalHistory(t.messages)
})

test('aliased OpenAI Chat moves mixed and image-only tool images after every result in the request only', async () => {
  const provider = providerFixture('chat', ['mixed', 'image-only'])
  expect(provider.model.provider).toBe('image-test-gateway.chat')
  const t = createTestVela({ model: provider.model, extensions: [pictures] })
  await t.run('Show me both pictures')
  expect(provider.requests).toHaveLength(2)
  const messages = provider.requests[1]?.messages ?? []
  const resultIndexes = messages.flatMap((message, index) =>
    message.role === 'tool' ? [index] : [],
  )
  expect(resultIndexes).toHaveLength(2)
  const results = messages.filter((message) => message.role === 'tool')
  expect(results.map((result) => result.tool_call_id)).toEqual([
    'call_1',
    'call_2',
  ])
  for (const result of results) {
    expect(typeof result.content).toBe('string')
    expect(result.content?.length).toBeGreaterThan(0)
    expect(JSON.stringify(result)).not.toContain(image.data)
  }
  expect(results[0]?.content).toContain('Image from the picture tool.')
  const afterResults = messages[(resultIndexes.at(-1) ?? -1) + 1]
  expect(afterResults?.role).toBe('user')
  expect(Array.isArray(afterResults?.content)).toBe(true)
  if (!Array.isArray(afterResults?.content))
    throw new Error(
      'Expected a user image message immediately after tool results',
    )
  const images = afterResults.content.filter(
    (part) => part.type === 'image_url',
  )
  expect(images).toHaveLength(2)
  for (const part of images)
    expect(part.image_url).toMatchObject({ url: dataUrl })
  expectCanonicalHistory(t.messages, 2)
})

test.each([{ variants: ['mixed'] }, { variants: ['image-only', 'mixed'] }])(
  'Chat hook removal leaves an honestly empty result for %j',
  async ({ variants }) => {
    const provider = providerFixture('chat', [...variants])
    const t = createTestVela({
      model: provider.model,
      extensions: [
        pictures,
        function redact(v) {
          v.on('tool_result', (event) =>
            event.toolName === 'pictures_render' &&
            (event.input as { variant: string }).variant === 'mixed'
              ? { content: [] }
              : undefined,
          )
        },
      ],
    })
    await t.run('Read the tool result after removal')
    const messages = provider.requests[1]?.messages ?? []
    const results = messages.filter((message) => message.role === 'tool')
    expect(results).toHaveLength(variants.length)
    expect(results.at(-1)?.content).toBe('[]')
    const images = messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((part) => part.type === 'image_url')
        : [],
    )
    expect(images).toHaveLength(variants.length - 1)
    const saved = t.messages.flatMap((message) =>
      message.role === 'tool' ? message.content : [],
    )
    expect(saved.at(-1)).toMatchObject({
      type: 'tool-result',
      output: { type: 'content', value: [] },
    })
  },
)
