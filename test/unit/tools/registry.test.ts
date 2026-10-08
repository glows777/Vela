import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod'
import { ToolResultStore } from '../../../src/session/tool-results.ts'
import { ToolRegistry, type ToolDefinition } from '../../../src/tools/registry.ts'

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

test('registering a tool name twice throws', () => {
  const registry = makeRegistry()
  registry.register(tool('dup'))
  expect(() => registry.register(tool('dup'))).toThrow(/already registered/)
})

test('deferred tools stay hidden until searchTools finds them', () => {
  const registry = makeRegistry()
  registry.register(
    tool('deferred', { exposure: 'deferred', searchHint: 'xxx tool hint' }),
  )
  expect(registry.getActiveTools().map((t) => t.name)).toEqual([])

  registry.searchTools('deferred')
  expect(registry.getActiveTools().map((t) => t.name)).toEqual(['deferred'])
  expect(registry.getDeferredToolSummary()).toBe('')
})

test('the deferred tool summary is a heading plus one evenly indented line per tool', () => {
  const registry = makeRegistry()
  registry.register(tool('a', { exposure: 'deferred', searchHint: 'hint a' }))
  registry.register(tool('b', { exposure: 'deferred' }))
  expect(registry.getDeferredToolSummary()).toBe(
    [
      'The tools below are available, but before calling one you must call tool_search to get its full schema:',
      '- a — hint a',
      '- b',
    ].join('\n'),
  )
})

test('searchTools matches exactly and skips tool_search itself', () => {
  const registry = makeRegistry()
  registry.register(tool('tool_search'))
  registry.register(tool('present'))
  const hits = registry.searchTools('present')
  expect(hits.map((t) => t.name)).toEqual(['present'])
  expect(registry.searchTools('tool_search')).toHaveLength(0)
})

test('toAISDKFormat includes only available tools', () => {
  const registry = makeRegistry()
  registry.register(tool('active-a'))
  registry.register(tool('lazy-b', { exposure: 'deferred' }))
  expect(Object.keys(registry.toAISDKFormat())).toEqual(['active-a'])
})

test('tools that are not concurrency-safe run serially under a mutex', async () => {
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
