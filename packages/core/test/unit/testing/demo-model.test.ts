import { afterEach, expect, test } from 'bun:test'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import {
  cleanupTestVelas,
  createTestVela,
} from '../../../../../test/support/vela.ts'
import { createMockModel } from '../../../src/testing/demo-model.ts'

afterEach(cleanupTestVelas)

test('demo model answers /compact with a summary that quotes the removed messages', async () => {
  const t = createTestVela({ model: createMockModel() })
  for (let i = 0; i < 5; i++) {
    t.session.append({ role: 'user', content: `question ${i}: hello` })
    t.session.append({
      role: 'assistant',
      content: [{ type: 'text', text: `answer ${i}` }],
    })
  }

  await t.session.compact()

  const [first] = t.session.messages
  expect(first?.role).toBe('user')
  expect(first?.content).toContain('[Summary of the earlier conversation]')
  expect(first?.content).toContain('question 0: hello')
})

test('demo model reads a local docs/ file instead of searching Notion', async () => {
  const model = createMockModel() as unknown as LanguageModelV3
  const { stream } = await model.doStream({
    prompt: [
      { role: 'user', content: [{ type: 'text', text: 'read docs/guide.md' }] },
    ],
  })
  const calls = []
  for await (const part of stream)
    if (part.type === 'tool-call') calls.push(part)
  expect(calls.map((c) => [c.toolName, JSON.parse(c.input)])).toEqual([
    ['read_file', { path: 'docs/guide.md' }],
  ])
})

/** The tools the demo model calls for one user message */
async function toolsOf(model: unknown, text: string) {
  const { content } = await (model as LanguageModelV3).doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text }] }],
  })
  return content.flatMap((c) => (c.type === 'tool-call' ? [c.toolName] : []))
}

test('demo model: test parallel only calls built-in tools', async () => {
  const model = createMockModel()
  const t = createTestVela({ model })
  const names = await toolsOf(model, 'test parallel')
  expect(names).toHaveLength(3)
  for (const name of names) expect(t.internals.registry.get(name)).toBeDefined()
})

test('demo model: "ls" only lists files as a whole word', async () => {
  const model = createMockModel()
  expect(await toolsOf(model, 'ls')).toEqual(['list_directory'])
  expect(await toolsOf(model, 'what tools do you have')).toEqual([])
})

test('demo model: cancelling a stream mid-answer does not throw later (Esc)', async () => {
  const model = createMockModel() as unknown as LanguageModelV3
  const { stream } = await model.doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  })
  const reader = stream.getReader()
  await reader.read()
  await reader.cancel()
  // The demo stream sends a chunk every 30ms; it used to throw "Controller is already closed" after a cancel
  await new Promise((resolve) => setTimeout(resolve, 100))
})
