import { expect, test } from 'bun:test'
import { generateText, streamText } from 'ai'
import {
  createFauxModel,
  fauxError,
  fauxText,
  fauxToolCall,
  loadFauxScenario,
} from '../../../src/testing/faux.ts'

async function streamParts(
  model: ReturnType<typeof createFauxModel>,
  prompt = 'hi',
) {
  const result = streamText({ model, prompt, maxRetries: 0, onError: () => {} })
  const parts: string[] = []
  for await (const part of result.stream) parts.push(part.type)
  return { parts, result }
}

test('replays responses in order and records each request', async () => {
  const model = createFauxModel({
    responses: [fauxText('one'), fauxText('two')],
  })
  expect((await generateText({ model, prompt: 'first' })).text).toBe('one')
  expect(
    (await generateText({ model, system: 'sys', prompt: 'second' })).text,
  ).toBe('two')
  expect(model.calls.map((c) => [c.index, c.kind, c.lastUserText])).toEqual([
    [1, 'generate', 'first'],
    [2, 'generate', 'second'],
  ])
  expect(model.calls[1]!.system).toBe('sys')
  expect(model.pending()).toBe(0)
})

test('streams text in chunks of chunkSize code points', async () => {
  const model = createFauxModel({
    responses: [fauxText('你好世界😀abc')],
    chunkSize: 2,
  })
  const result = streamText({ model, prompt: 'hi' })
  const deltas: string[] = []
  for await (const part of result.stream)
    if (part.type === 'text-delta') deltas.push(part.text)
  expect(deltas).toEqual(['你好', '世界', '😀a', 'bc'])
  expect(await result.text).toBe('你好世界😀abc')
})

test('tool calls get stable ids and the right finish reason', async () => {
  const model = createFauxModel({
    responses: [
      [fauxToolCall('a', { x: 1 }), fauxToolCall('b', {}, { id: 'custom' })],
    ],
  })
  const result = await generateText({ model, prompt: 'go' })
  expect(
    result.toolCalls.map((c) => [c.toolCallId, c.toolName, c.input]),
  ).toEqual([
    ['faux-call-1-1', 'a', { x: 1 }],
    ['custom', 'b', {}],
  ])
  expect(result.finishReason).toBe('tool-calls')
})

test('dynamic responses see the request', async () => {
  const model = createFauxModel({
    responses: [
      (req) =>
        fauxText(`echo: ${req.lastUserText} (${req.tools.length} tools)`),
    ],
  })
  expect((await generateText({ model, prompt: 'ping' })).text).toBe(
    'echo: ping (0 tools)',
  )
})

test('usage is deterministic and can be overridden', async () => {
  const model = createFauxModel({
    responses: [
      fauxText('abcd'),
      fauxText('x', { usage: { input: 7, output: 3, cacheRead: 2 } }),
    ],
  })
  const first = await generateText({ model, prompt: 'hello' })
  expect(first.usage.outputTokens).toBe(1)
  const second = await generateText({ model, prompt: 'hello' })
  expect(second.usage.inputTokens).toBe(7)
  expect(second.usage.outputTokens).toBe(3)
  expect(second.usage.inputTokenDetails.cacheReadTokens).toBe(2)
})

test('an error response rejects the request; a stream error arrives after partial text', async () => {
  const failing = createFauxModel({
    responses: [fauxError('429 Too Many Requests')],
  })
  const { parts } = await streamParts(failing)
  expect(parts).toContain('error')

  const broken = createFauxModel({
    responses: [{ text: 'partial', streamError: 'ECONNRESET' }],
  })
  const { parts: brokenParts } = await streamParts(broken)
  expect(brokenParts).toContain('text-delta')
  expect(brokenParts).toContain('error')
  expect(brokenParts).not.toContain('text-end')
})

test('a hanging response ends only when the request is aborted', async () => {
  const model = createFauxModel({
    responses: [{ text: 'thinking', hang: true }],
  })
  const controller = new AbortController()
  const result = streamText({
    model,
    prompt: 'hi',
    abortSignal: controller.signal,
    onError: () => {},
  })
  const seen: string[] = []
  const reading = (async () => {
    for await (const part of result.stream) {
      seen.push(part.type)
      if (part.type === 'text-delta') controller.abort(new Error('stop'))
    }
  })()
  await reading.catch(() => {})
  expect(seen).toContain('text-delta')
  expect(seen).not.toContain('finish')
})

test('running out of script fails loudly', async () => {
  const model = createFauxModel()
  await expect(generateText({ model, prompt: 'x' })).rejects.toThrow(
    'faux: no scripted response for request #1',
  )
})

test('a separate generate queue serves generateText while the main queue serves streams', async () => {
  const model = createFauxModel({
    responses: [fauxText('stream')],
    generate: [fauxText('generate')],
  })
  expect((await generateText({ model, prompt: 'g' })).text).toBe('generate')
  const result = streamText({ model, prompt: 's' })
  expect(await result.text).toBe('stream')
  model.push(fauxText('later'))
  expect(model.pending()).toBe(1)
})

test('prompt cache simulation reads the unchanged system prefix from cache', async () => {
  const model = createFauxModel({
    cache: true,
    responses: [fauxText('a'), fauxText('b'), fauxText('c')],
  })
  const system = 'stable system '.repeat(50)
  const a = await generateText({ model, system, prompt: '1' })
  const b = await generateText({ model, system, prompt: '2' })
  const c = await generateText({
    model,
    system: `${system}changed`,
    prompt: '3',
  })
  expect(a.usage.inputTokenDetails.cacheWriteTokens).toBeGreaterThan(0)
  expect(b.usage.inputTokenDetails.cacheReadTokens).toBe(
    a.usage.inputTokenDetails.cacheWriteTokens,
  )
  expect(c.usage.inputTokenDetails.cacheReadTokens).toBe(0)
})

test('loads a JSON scenario file', async () => {
  const model = await loadFauxScenario(
    `${import.meta.dir}/../../fixtures/scenarios/hello.json`,
  )
  expect((await generateText({ model, prompt: 'hi' })).text).toContain(
    'faux 回放',
  )
})
