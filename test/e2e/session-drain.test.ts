import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import { createLocalExecutionEnv } from '@glows777/vela-core'
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
