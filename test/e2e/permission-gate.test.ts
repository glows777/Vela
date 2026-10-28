import { afterEach, expect, test } from 'bun:test'
import type { SessionUI } from '@glows777/vela'
import { permissionGate } from '@glows777/vela-core'
import { fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

/** Test UI: select answers with `answer` and records what was asked */
function uiSelecting(answer: string) {
  const asked: string[] = []
  const ui: SessionUI = {
    notify: () => {},
    confirm: async () => false,
    select: async (title, options) => {
      asked.push(`${title} ${options.join('/')}`)
      return answer
    },
    input: async () => undefined,
  }
  return { ui, asked }
}

test('permission-gate blocks a dangerous bash command when no UI can confirm it', async () => {
  const t = createTestVela({
    extensions: [permissionGate()],
    files: { 'junk.txt': 'x' },
    responses: [
      fauxToolCall('bash', { command: 'rm -rf junk.txt' }),
      (req) => fauxText(req.toolResults[0]!.output),
    ],
  })

  await t.run('Delete junk.txt')

  expect(await Bun.file(t.path('junk.txt')).exists()).toBe(true)
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain(
    'no UI for confirmation',
  )
})

test('permission-gate asks with a UI and runs the command when the user allows it', async () => {
  const { ui, asked } = uiSelecting('Yes')
  const t = createTestVela({
    extensions: [permissionGate()],
    session: { ui },
    files: { 'junk.txt': 'x' },
    responses: [
      fauxToolCall('bash', { command: 'rm -rf junk.txt' }),
      fauxText('Deleted junk.txt'),
    ],
  })

  await t.run('Delete junk.txt')

  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('rm -rf junk.txt')
  expect(await Bun.file(t.path('junk.txt')).exists()).toBe(false)
})

test('permission-gate blocks the command when the user says No', async () => {
  const { ui } = uiSelecting('No')
  const t = createTestVela({
    extensions: [permissionGate()],
    session: { ui },
    files: { 'junk.txt': 'x' },
    responses: [
      fauxToolCall('bash', { command: 'rm -rf junk.txt' }),
      (req) => fauxText(req.toolResults[0]!.output),
    ],
  })

  await t.run('Delete junk.txt')

  expect(await Bun.file(t.path('junk.txt')).exists()).toBe(true)
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain('Blocked by user')
})
