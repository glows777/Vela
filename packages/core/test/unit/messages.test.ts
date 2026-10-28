import { expect, test } from 'bun:test'
import type { ModelMessage } from '../../src/index.ts'
import { withoutForeignReasoning } from '../../src/messages.ts'

const parts = (message: ModelMessage) =>
  typeof message.content === 'string'
    ? []
    : message.content.map((part) => part.type)

test('withoutForeignReasoning keeps text and tool calls, dropping another model reasoning', () => {
  const own: ModelMessage = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'own thinking' },
      { type: 'text', text: 'own answer' },
    ],
  }
  const foreign: ModelMessage = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'other thinking' },
      { type: 'text', text: 'other answer' },
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'read_file',
        input: {},
      },
    ],
  }
  const unknown: ModelMessage = {
    role: 'assistant',
    content: [{ type: 'reasoning', text: 'no recorded producer' }],
  }
  const onlyReasoning: ModelMessage = {
    role: 'assistant',
    content: [{ type: 'reasoning', text: 'nothing else' }],
  }
  const messages = [own, foreign, unknown, onlyReasoning]
  const producedBy = new Map<ModelMessage, string>([
    [own, 'fake/a'],
    [foreign, 'fake/b'],
    [onlyReasoning, 'fake/b'],
  ])

  const result = withoutForeignReasoning(messages, 'fake/a', producedBy)

  // The other model's reasoning goes, its answer and tool call stay; a message left with nothing goes too
  expect(result.map(parts)).toEqual([
    ['reasoning', 'text'],
    ['text', 'tool-call'],
    ['reasoning'],
  ])
  // Without a recorded producer there is nothing that says the reasoning is foreign
  expect(result[2]).toBe(unknown)
  // The history keeps what was passed in
  expect(parts(foreign)).toEqual(['reasoning', 'text', 'tool-call'])
})
