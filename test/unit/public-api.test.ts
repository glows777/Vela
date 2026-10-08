import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { apiReport } from '../../scripts/api-report.ts'

/**
 * 公开 API 快照（G）：`vela` 和 `vela/testing` 导出的名字和类型。
 * 改了公开面就运行 `bun run api:update`，把 api/public-api.txt 的变化一起提交，评审时能直接看到 API 改了什么。
 */
test('the public API matches api/public-api.txt', async () => {
  const expected = await Bun.file(
    join(import.meta.dir, '../../api/public-api.txt'),
  ).text()
  expect(apiReport()).toBe(expected)
}, 30_000)
