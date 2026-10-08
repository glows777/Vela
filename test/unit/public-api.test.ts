import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { apiReport } from '../../scripts/api-report.ts'

/**
 * Public API snapshot (G): the names and types exported by `vela` and `vela/testing`.
 * When the public surface changes, run `bun run api:update` and commit the api/public-api.txt diff so reviewers can see exactly what changed.
 */
test('the public API matches api/public-api.txt', async () => {
  const expected = await Bun.file(
    join(import.meta.dir, '../../api/public-api.txt'),
  ).text()
  expect(apiReport()).toBe(expected)
}, 30_000)
