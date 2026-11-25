import { expect, test } from 'bun:test'
import type { ModelMessage } from '../../../src/driver/index.ts'
import { withoutForeignReasoning } from '../../../src/driver/messages.ts'

const parts = (message: ModelMessage) =>
  typeof message.content === 'string'
    ? []
    : message.content.map((part) => part.type)

test('withoutForeignReasoning keeps text and tool calls, dropping another model thinking', () => {
  const own: ModelMessage = {
    role: 'assistant',
    content: [
      { type: 'thinking', text: 'own thinking' },
      { type: 'text', text: 'own answer' },
    ],
  }
  const foreign: ModelMessage = {
    role: 'assistant',
    content: [
      { type: 'thinking', text: 'other thinking' },
      { type: 'text', text: 'other answer' },
      {
        type: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'read',
        input: {},
      },
    ],
  }
  const unknown: ModelMessage = {
    role: 'assistant',
    content: [{ type: 'thinking', text: 'no recorded producer' }],
  }
  const onlyReasoning: ModelMessage = {
    role: 'assistant',
    content: [{ type: 'thinking', text: 'nothing else' }],
  }
  const messages = [own, foreign, unknown, onlyReasoning]
  const producedBy = new Map<ModelMessage, string>([
    [own, 'fake/a'],
    [foreign, 'fake/b'],
    [onlyReasoning, 'fake/b'],
  ])

  const result = withoutForeignReasoning(messages, 'fake/a', producedBy)

  // The other model's thinking goes, its answer and tool call stay; a message left with nothing goes too
  expect(result.map(parts)).toEqual([
    ['thinking', 'text'],
    ['text', 'tool_call'],
    ['thinking'],
  ])
  // Without a recorded producer there is nothing that says the thinking is foreign
  expect(result[2]).toBe(unknown)
  // The history keeps what was passed in
  expect(parts(foreign)).toEqual(['thinking', 'text', 'tool_call'])
})
