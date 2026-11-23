import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import { createLocalExecutionEnv } from '../../packages/vela/src/driver/index.ts'
import {
  fauxSummary,
  fauxText,
} from '../../packages/vela/src/testing/core/index.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('drain refuses an admitted user shell still preparing its environment without starting a process', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const t = createTestVela({ responses: [] }, (options) =>
    createVela({
      ...options,
      env: async ({ location }) => {
        entered.resolve()
        await release.promise
        return createLocalExecutionEnv({ cwd: location.cwd })
      },
    }),
  )
  const command = t.session
    .executeBash('printf forbidden > forbidden.txt')
    .then(
      () => 'ran',
      (error: Error) => error.message,
    )
  await entered.promise
  const drain = t.session.drain()
  release.resolve()
  expect(await command).toContain('was not executed')
  await drain
  expect(existsSync(join(t.cwd, 'forbidden.txt'))).toBe(false)
})

for (const operation of ['compact', 'summarized tree'] as const)
  test(`drain rejects ${operation} without another model request or branch change`, async () => {
    const t = createTestVela({
      responses: Array.from({ length: 4 }, (_, i) => fauxText(`answer ${i}`)),
      generate: [fauxSummary()],
      allowPendingResponses: true,
    })
    for (let i = 0; i < 4; i++) await t.run(`question ${i}`)
    const target = t.session
      .getEntries()
      .find(
        (entry) => entry.type === 'message' && entry.message.role === 'user',
      )!
    const leaf = t.session.getLeafId()
    const calls = t.model.calls.length
    await t.session.drain()
    await expect(
      operation === 'compact'
        ? t.session.compact()
        : t.session.navigateTree(target.id, { summarize: true }),
    ).rejects.toThrow('draining')
    expect(t.model.calls).toHaveLength(calls)
    expect(t.session.getLeafId()).toBe(leaf)
  })
