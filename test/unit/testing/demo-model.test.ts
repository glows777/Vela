import { afterEach, expect, test } from 'bun:test'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { createMockModel } from '../../../src/testing/demo-model.ts'
import { cleanupTestVelas, createTestVela } from '../../support/vela.ts'

afterEach(cleanupTestVelas)

test('demo model answers /compact with a summary that quotes the removed messages', async () => {
  const t = createTestVela({ model: createMockModel() })
  for (let i = 0; i < 5; i++)
    t.session.messages.push(
      { role: 'user', content: `question ${i}: hello` },
      { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] },
    )

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
