import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import confirmDangerous from '../../examples/extensions/confirm-dangerous.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('confirmation example blocks headless deletion and sends its reason to the model', async () => {
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
  expect(t.lastAssistantText()).toContain('no UI for confirmation')
  expect(t.eventsOf('tool_execution_end')[0]).toMatchObject({ isError: true })
})

test.each([true, false])(
  'confirmation example uses the supplied UI and respects %s',
  async (approved) => {
    const asked: string[] = []
    const t = createTestVela({
      extensions: [confirmDangerous],
      files: { 'junk.txt': 'keep me' },
      session: {
        ui: {
          notify: () => {},
          select: async () => undefined,
          input: async () => undefined,
          confirm: async (title, message) => {
            asked.push(`${title}: ${message}`)
            return approved
          },
        },
      },
      responses: [
        fauxToolCall('bash', { command: 'rm junk.txt' }),
        (request) => fauxText(request.toolResults[0]!.output),
      ],
    })
    await t.run('Delete junk.txt')
    expect(asked).toEqual(['Delete files?: rm junk.txt'])
    expect(existsSync(t.path('junk.txt'))).toBe(!approved)
    expect(t.eventsOf('tool_execution_end')[0]?.isError).toBe(!approved)
    if (!approved)
      expect(t.lastAssistantText()).toContain('User did not allow the deletion')
  },
)
