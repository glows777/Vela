import { afterEach, expect, test } from 'bun:test'
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
