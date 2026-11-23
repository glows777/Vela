import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cliVersion } from '../../../src/cli/version.ts'

test('cliVersion() is the CLI package.json version', () => {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dir, '../../../../../package.json'), 'utf8'),
  )
  expect(cliVersion()).toBe(pkg.version)
})
