import { afterEach, expect, test } from 'bun:test'
import { todo } from '@glows777/vela-core'
import { fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import { latestTodoList } from '../../packages/core/src/extensions/todo/list.ts'
import type { TodoList } from '../../packages/core/src/extensions/todo/tool.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('the last todo call is the checklist, and a resume keeps it', async () => {
  const t = createTestVela({
    extensions: [todo()],
    responses: [
      fauxToolCall('todo', {
        items: [
          { text: 'Read the issue', status: 'done' },
          { text: 'Write the extension', status: 'in_progress' },
          { text: 'Run the tests', status: 'pending' },
        ],
      }),
      fauxText('Plan saved'),
      fauxToolCall('todo', {
        items: [
          { text: 'Read the issue', status: 'done' },
          { text: 'Write the extension', status: 'done' },
          { text: 'Run the tests', status: 'in_progress' },
        ],
      }),
      fauxText('First step done'),
    ],
  })
  await t.run('plan the work')
  await t.run('start the first item')

  // Registered under the extension's own name, not todo_todo
  expect(t.model.calls[0]!.tools).toContain('todo')
  expect(t.model.calls[0]!.tools).not.toContain('todo_todo')
  const latest: TodoList = {
    items: [
      { text: 'Read the issue', status: 'done' },
      { text: 'Write the extension', status: 'done' },
      { text: 'Run the tests', status: 'in_progress' },
    ],
  }
  expect(latestTodoList(t.session.messages)).toEqual(latest)
  expect(
    t.eventsOf('tool_execution_end').map((event) => event.details),
  ).toEqual([
    {
      items: [
        { text: 'Read the issue', status: 'done' },
        { text: 'Write the extension', status: 'in_progress' },
        { text: 'Run the tests', status: 'pending' },
      ],
    },
    latest,
  ])

  const again = createTestVela({ cwd: t.cwd, extensions: [todo()] })
  expect(await again.session.resume()).toBe(true)
  expect(latestTodoList(again.session.messages)).toEqual(latest)
})
