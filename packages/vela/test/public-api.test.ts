import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { apiReport } from '../../../scripts/api-report.ts'

test('vela public entries match the API snapshot', async () => {
  const expected = await Bun.file(
    join(import.meta.dir, '../api/public-api.txt'),
  ).text()
  const report = apiReport('vela')
  expect(report).toBe(expected)
}, 60000)
