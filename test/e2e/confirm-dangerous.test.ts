import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import confirmDangerous from '../../examples/extensions/confirm-dangerous.ts'
import {
  fauxText,
  fauxToolCall,
} from '../../packages/vela/src/testing/core/index.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('confirmation example blocks deletion, emits a warning notification, and sends its reason to the model', async () => {
  const t = createTestVela({
    extensions: [confirmDangerous],
    files: { 'junk.txt': 'keep me' },
    responses: [
      fauxToolCall('bash', { command: 'rm junk.txt' }),
      (request) => fauxText(request.toolResults[0]!.output),
    ],
  })
  await t.run('Delete junk.txt')
  expect(existsSync(t.path('junk.txt'))).toBe(true)
  expect(t.lastAssistantText()).toContain(
    'Deletion blocked by confirm-dangerous extension',
  )
  expect(t.eventsOf('tool_execution_end')[0]).toMatchObject({ isError: true })
  expect(t.eventsOf('notify')).toContainEqual({
    type: 'notify',
    message: 'Blocked dangerous command: rm junk.txt',
    level: 'warning',
  })
})
