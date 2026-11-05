import { expect, test } from 'bun:test'
import { latestTodoList } from '../../../../src/extensions/todo/list.ts'
import type { SessionEntry } from '../../../../src/session/entries.ts'

let sequence = 0
/** A tool message as the session stores it: the display data is `details`, keyed by tool call id. */
function result(details: unknown, toolName = 'todo'): SessionEntry {
  const id = `entry-${++sequence}`
  const toolCallId = `${id}-call`
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-11-05T00:00:00.000Z',
    message: {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId,
          toolName,
          output: { type: 'text', value: 'ok' },
        },
      ],
    },
    details: { [toolCallId]: details },
  }
}

test('the last successful todo call is the current list', () => {
  expect(
    latestTodoList([
      result({
        items: [
          { text: 'first', status: 'done' },
          { text: 'second', status: 'in_progress' },
        ],
      }),
      result({ ok: true }, 'bash'),
      result({ items: [{ text: 'second', status: 'done' }] }),
    ]),
  ).toEqual({ items: [{ text: 'second', status: 'done' }] })
})

test('a call without todo display data does not replace the last list', () => {
  expect(
    latestTodoList([
      result({ items: [{ text: 'keep me', status: 'pending' }] }),
      result({ items: [{ text: 'bad status', status: 'blocked' }] }),
    ]),
  ).toEqual({ items: [{ text: 'keep me', status: 'pending' }] })
})

test('an empty list clears the checklist', () => {
  expect(
    latestTodoList([
      result({ items: [{ text: 'done', status: 'done' }] }),
      result({ items: [] }),
    ]),
  ).toEqual({ items: [] })
})

test('a session without a todo call has no checklist', () => {
  expect(latestTodoList([])).toBeNull()
})
