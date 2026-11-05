import { expect, test } from 'bun:test'
import { latestTodoList } from '../../../../src/extensions/todo/list.ts'
import type { ModelMessage } from '../../../../src/messages.ts'

let calls = 0
function call(input: unknown): ModelMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: `call-${++calls}`,
        toolName: 'todo',
        input,
      },
    ],
  }
}

test('the last todo call is the current list', () => {
  expect(
    latestTodoList([
      call({
        items: [
          { text: 'first', status: 'done' },
          { text: 'second', status: 'in_progress' },
        ],
      }),
      { role: 'user', content: 'next' },
      call({ items: [{ text: 'second', status: 'done' }] }),
    ]),
  ).toEqual({ items: [{ text: 'second', status: 'done' }] })
})

test('an invalid todo call does not replace the last valid list', () => {
  expect(
    latestTodoList([
      call({ items: [{ text: 'keep me', status: 'pending' }] }),
      call({ items: [{ text: 'bad status', status: 'blocked' }] }),
    ]),
  ).toEqual({ items: [{ text: 'keep me', status: 'pending' }] })
})

test('an empty list clears the checklist', () => {
  expect(
    latestTodoList([
      call({ items: [{ text: 'done', status: 'done' }] }),
      call({ items: [] }),
    ]),
  ).toEqual({ items: [] })
})

test('a session without a todo call has no checklist', () => {
  expect(latestTodoList([{ role: 'user', content: 'hello' }])).toBeNull()
})
