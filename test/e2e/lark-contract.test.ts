import { afterEach, expect, test } from 'bun:test'
import * as adapter from '@glows777/vela-lark'
import { fakeLark } from '../support/lark.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('canonical Lark factory, config, channel and tools have one public naming scheme', async () => {
  expect(Object.keys(adapter)).toContain('lark')
  expect(Object.keys(adapter)).not.toContain('feishu')
  expect(adapter.larkConfig.name).toBe('lark')
  const lark = (adapter as unknown as { lark: typeof adapter.lark }).lark
  const fake = fakeLark()
  const t = createTestVela({
    responses: [],
    extensions: [lark({ transport: fake.transport, owners: ['ou_alice'] })],
  })
  await t.vela.ready()
  expect(t.vela.channels().map((ch) => ch.name)).toEqual(['lark'])
  const names = t.internals.registry.getAllTools().map((tool) => tool.name)
  expect(names).toContain('channel_start_topic')
  expect(names.filter((name) => name.startsWith('lark_'))).toEqual([
    'lark_search_history',
  ])
  expect(names.some((name) => name.startsWith('feishu_'))).toBe(false)
})
