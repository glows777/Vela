import { expect, test } from 'bun:test'
import * as adapter from '../../packages/vela/src/lark/index.ts'

test('canonical Lark adapter, config, and tools use the v0.9 Lark naming scheme', () => {
  expect(Object.keys(adapter)).toContain('createLarkChannelAdapter')
  expect(Object.keys(adapter)).toContain('larkConfig')
  expect(Object.keys(adapter)).not.toContain('lark')
  expect(Object.keys(adapter)).not.toContain('feishu')
  expect(adapter.larkConfig.name).toBe('lark')

  const larkAdapter = adapter.createLarkChannelAdapter({ owners: ['ou_alice'] })
  expect(larkAdapter.name).toBe('lark')
  const tools =
    larkAdapter.getTools?.({
      id: 'binding-1',
      channel: 'lark',
      externalId: 'oc_group',
      kind: 'group',
      projectId: 'proj-1',
      sessionId: null,
      enabled: true,
    }) ?? []
  const names = tools.map((tool) => tool.name)
  expect(names).toEqual(['lark_search_history'])
  expect(names.some((name) => name.startsWith('feishu_'))).toBe(false)
})
