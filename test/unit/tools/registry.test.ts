import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod'
import { ToolResultStore } from '../../../src/session/tool-results'
import { ToolRegistry, type ToolDefinition } from '../../../src/tools/registry'

const root = mkdtempSync(join(tmpdir(), 'vela-registry-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
function makeRegistry() {
  return new ToolRegistry(
    new ToolResultStore(join(root, crypto.randomUUID(), 'outputs')),
  )
}

function tool(
  name: string,
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: z.object({}).passthrough(),
    execute: async () => 'ok',
    ...overrides,
  }
}

test('重复注册同名工具抛错', () => {
  const registry = makeRegistry()
  registry.register(tool('dup'))
  expect(() => registry.register(tool('dup'))).toThrow(/already registered/)
})

test('延迟工具在 searchTools 发现前不可见', () => {
  const registry = makeRegistry()
  registry.register(
    tool('deferred', { shouldDefer: true, searchHint: 'xxx 工具 hint' }),
  )
  expect(registry.getActiveTools().map((t) => t.name)).toEqual([])

  registry.searchTools('deferred')
  expect(registry.getActiveTools().map((t) => t.name)).toEqual(['deferred'])
  expect(registry.getDeferredToolSummary()).toBe('')
})

test('searchTools 精确匹配并跳过 tool_search 自身', () => {
  const registry = makeRegistry()
  registry.register(tool('tool_search'))
  registry.register(tool('present'))
  const hits = registry.searchTools('present')
  expect(hits.map((t) => t.name)).toEqual(['present'])
  expect(registry.searchTools('tool_search')).toHaveLength(0)
})

test('toAISDKFormat 只包含可用工具', () => {
  const registry = makeRegistry()
  registry.register(tool('active-a'))
  registry.register(tool('lazy-b', { shouldDefer: true }))
  expect(Object.keys(registry.toAISDKFormat())).toEqual(['active-a'])
})

test('非并发安全的工具由互斥锁串行执行', async () => {
  const registry = makeRegistry()
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  registry.register(
    tool('exclusive', {
      isConcurrencySafe: false,
      execute: async (input: { id: string }) => {
        order.push(`${input.id}-start`)
        if (input.id === 'a') await gate
        order.push(`${input.id}-end`)
        return `${input.id}-done`
      },
    }),
  )
  const wrapped = registry.toAISDKFormat()
  const body = wrapped['exclusive']
  if (!body) throw new Error('exclusive tool expected in tool set')

  const execute = body.execute!
  const options = (toolCallId: string) => ({
    toolCallId,
    messages: [],
    context: {},
  })
  const first = execute({ id: 'a' }, options('a'))
  await Bun.sleep(20)
  const second = execute({ id: 'b' }, options('b'))
  await Bun.sleep(20)
  expect(order).toEqual(['a-start'])

  release()
  await Promise.all([first, second])
  expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
})
