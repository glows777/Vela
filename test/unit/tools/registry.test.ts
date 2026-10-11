import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod'
import { ToolResultStore } from '../../../src/session/tool-results.ts'
import {
  type ToolDefinition,
  ToolRegistry,
} from '../../../src/tools/registry.ts'
import { registerToolSearchTool } from '../../../src/tools/tool-search.ts'

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

test('registering a tool with the removed isConcurrencySafe or an unknown executionMode throws', () => {
  const registry = makeRegistry()
  expect(() =>
    registry.register({
      ...tool('old'),
      isConcurrencySafe: true,
    } as ToolDefinition),
  ).toThrow(/isConcurrencySafe was removed/)
  expect(() =>
    registry.register(
      tool('typo', {
        executionMode: 'serial' as ToolDefinition['executionMode'],
      }),
    ),
  ).toThrow(/executionMode must be 'parallel' or 'sequential'/)
  expect(registry.get('old')).toBeUndefined()
  expect(registry.get('typo')).toBeUndefined()
})

test('registering a tool with the removed isReadOnly or an unknown exposure throws', () => {
  const registry = makeRegistry()
  expect(() =>
    registry.register({ ...tool('old'), isReadOnly: true } as ToolDefinition),
  ).toThrow(/isReadOnly was removed. Use annotations/)
  expect(() =>
    registry.register(
      tool('typo', { exposure: 'lazy' as ToolDefinition['exposure'] }),
    ),
  ).toThrow(/exposure/)
  registry.register(tool('ok', { annotations: { readOnlyHint: true } }))
  expect(registry.get('ok')?.annotations).toEqual({ readOnlyHint: true })
})

test('exposure decides what the model sees, what tool_search finds and what executeTool can call (like pi)', async () => {
  const registry = makeRegistry()
  for (const exposure of [
    'direct',
    'model-only',
    'codemode',
    'deferred',
    'hidden',
  ] as const)
    registry.register(tool(exposure, { exposure }))
  const active = () => registry.getActiveTools().map((t) => t.name)
  expect(active()).toEqual(['direct', 'model-only'])
  expect(
    ['direct', 'model-only', 'codemode', 'deferred', 'hidden'].filter((n) =>
      registry.isCallable(n),
    ),
  ).toEqual(['direct', 'codemode', 'deferred'])
  expect(
    (await registry.searchTools('codemode,hidden,deferred')).map((t) => t.name),
  ).toEqual(['deferred'])
  expect(active()).toEqual(['direct', 'model-only', 'deferred'])
  registry.setPermissions({ direct: 'deny' })
  expect(registry.isCallable('direct')).toBe(false)
})

test('the deferred tool summary lists each namespace once, not its tools (like pi)', () => {
  const registry = makeRegistry()
  const docs = {
    name: 'mcp__docs',
    description: 'Project documentation',
    instructions: 'Search before reading.',
  }
  registry.register(
    tool('mcp__docs__read', { exposure: 'deferred', namespace: docs }),
    tool('plain', { exposure: 'deferred' }),
    tool('mcp__git__log', {
      exposure: 'deferred',
      namespace: { name: 'mcp__git' },
    }),
    tool('mcp__docs__search', {
      exposure: 'deferred',
      namespace: docs,
      searchHint: 'full text',
    }),
  )
  expect(registry.getDeferredToolSummary()).toBe(
    [
      'These tools are available but not loaded. Call tool_search with keywords or tool names to load the ones you need:',
      '- plain',
      '- mcp__docs (2 tools) — Project documentation',
      '- mcp__git (1 tool)',
    ].join('\n'),
  )
})

test('deferred tools stay hidden until searchTools finds them', async () => {
  const registry = makeRegistry()
  registry.register(
    tool('deferred', { exposure: 'deferred', searchHint: 'xxx tool hint' }),
  )
  expect(registry.getActiveTools().map((t) => t.name)).toEqual([])

  await registry.searchTools('deferred')
  expect(registry.getActiveTools().map((t) => t.name)).toEqual(['deferred'])
  expect(registry.getDeferredToolSummary()).toBe('')
})

test('the deferred tool summary is a heading plus one evenly indented line per tool', () => {
  const registry = makeRegistry()
  registry.register(tool('a', { exposure: 'deferred', searchHint: 'hint a' }))
  registry.register(tool('b', { exposure: 'deferred' }))
  expect(registry.getDeferredToolSummary()).toBe(
    [
      'These tools are available but not loaded. Call tool_search with keywords or tool names to load the ones you need:',
      '- a — hint a',
      '- b',
    ].join('\n'),
  )
})

test('searchTools loads exact names, and only deferred tools other than tool_search', async () => {
  const registry = makeRegistry()
  registry.register(tool('tool_search', { exposure: 'deferred' }))
  registry.register(tool('present', { exposure: 'deferred' }))
  registry.register(tool('direct'))
  const hits = await registry.searchTools('present')
  expect(hits.map((t) => t.name)).toEqual(['present'])
  // Asking again for a loaded tool returns it again
  expect((await registry.searchTools('present')).map((t) => t.name)).toEqual([
    'present',
  ])
  expect(await registry.searchTools('tool_search')).toHaveLength(0)
  expect(await registry.searchTools('direct')).toHaveLength(0)
})

test('searchTools ranks deferred tools by keywords (BM25, like pi) and loads at most `limit`', async () => {
  const registry = makeRegistry()
  const github = { name: 'mcp__github', description: 'GitHub repositories' }
  registry.register(
    tool('mcp__github__list_issues', {
      exposure: 'deferred',
      namespace: github,
      description: 'List issues in a repository',
    }),
    tool('mcp__github__create_issue', {
      exposure: 'deferred',
      namespace: github,
      description: 'Create a new issue',
    }),
    tool('mcp__github__get_file', {
      exposure: 'deferred',
      namespace: github,
      description: 'Read a file from a repository',
    }),
    tool('mcp__slack__post', {
      exposure: 'deferred',
      description: 'Post a message to a channel',
    }),
  )
  const hits = await registry.searchTools('github issues', 2)
  expect(hits.map((t) => t.name).sort()).toEqual([
    'mcp__github__create_issue',
    'mcp__github__list_issues',
  ])
  expect(
    registry
      .getActiveTools()
      .map((t) => t.name)
      .sort(),
  ).toEqual(['mcp__github__create_issue', 'mcp__github__list_issues'])
  // Loaded tools are not found again by keywords; unrelated words find nothing
  expect((await registry.searchTools('issue')).map((t) => t.name)).toEqual([])
  expect(await registry.searchTools('weather forecast')).toHaveLength(0)
  registry.setPermissions({ mcp__slack__post: 'deny' })
  expect(await registry.searchTools('post message channel')).toHaveLength(0)
})

test('toAISDKFormat includes only available tools', () => {
  const registry = makeRegistry()
  registry.register(tool('active-a'))
  registry.register(tool('lazy-b', { exposure: 'deferred' }))
  expect(Object.keys(registry.toAISDKFormat())).toEqual(['active-a'])
})

/** Waits until cond() holds; timing-free under a loaded test runner */
async function waitFor(cond: () => boolean) {
  for (let i = 0; i < 500 && !cond(); i++) await Bun.sleep(5)
  expect(cond()).toBe(true)
}

test('sequential tools run one at a time within a session', async () => {
  const registry = makeRegistry()
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  registry.register(
    tool('exclusive', {
      executionMode: 'sequential',
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
  await waitFor(() => order.includes('a-start'))
  const second = execute({ id: 'b' }, options('b'))
  await Bun.sleep(20)
  expect(order).toEqual(['a-start'])

  release()
  await Promise.all([first, second])
  expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
})

/** A tool whose calls wait until released; records start/end order */
function blockingTool(
  name: string,
  order: string[],
  overrides: Partial<ToolDefinition> = {},
) {
  const releases = new Map<string, () => void>()
  const waiting = new Map<string, Promise<void>>()
  const hold = (id: string) => {
    if (!waiting.has(id))
      waiting.set(id, new Promise<void>((resolve) => releases.set(id, resolve)))
    return waiting.get(id)!
  }
  const definition = tool(name, {
    execute: async (input: { id: string }) => {
      order.push(`${input.id}-start`)
      await hold(input.id)
      order.push(`${input.id}-end`)
      return input.id
    },
    ...overrides,
  })
  return {
    definition,
    release: (id: string) => {
      hold(id)
      releases.get(id)!()
    },
  }
}

const callOptions = (toolCallId: string) => ({
  toolCallId,
  messages: [],
  context: {},
})

test('parallel tools run together; a sequential call waits for earlier calls and holds back later ones', async () => {
  const registry = makeRegistry()
  const order: string[] = []
  const par = blockingTool('par', order)
  const seq = blockingTool('seq', order, { executionMode: 'sequential' })
  registry.register(par.definition, seq.definition)
  const tools = registry.toAISDKFormat()
  const run = (name: 'par' | 'seq', id: string) =>
    tools[name]!.execute!({ id }, callOptions(id))

  const a = run('par', 'a')
  const b = run('par', 'b')
  // Calls that run together may start in either order
  const started = () => [...order].sort()
  await waitFor(() => order.length === 2)
  expect(started()).toEqual(['a-start', 'b-start'])

  const s = run('seq', 's')
  const c = run('par', 'c')
  await Bun.sleep(20)
  expect(started()).toEqual(['a-start', 'b-start'])

  par.release('a')
  par.release('b')
  await waitFor(() => order.includes('s-start'))
  expect(order.slice(0, 4).sort()).toEqual([
    'a-end',
    'a-start',
    'b-end',
    'b-start',
  ])
  expect(order.slice(4)).toEqual(['s-start'])

  seq.release('s')
  par.release('c')
  await Promise.all([a, b, s, c])
  expect(order.slice(4)).toEqual(['s-start', 's-end', 'c-start', 'c-end'])
})

test('a sequential call in one session does not hold back another session', async () => {
  const base = makeRegistry()
  const order: string[] = []
  const seq = blockingTool('seq', order, { executionMode: 'sequential' })
  base.register(seq.definition)
  const one = base.fork(new ToolResultStore(join(root, 'one')))
  const two = base.fork(new ToolResultStore(join(root, 'two')))

  const first = one.toAISDKFormat().seq!.execute!({ id: 'a' }, callOptions('a'))
  const second = two.toAISDKFormat().seq!.execute!(
    { id: 'b' },
    callOptions('b'),
  )
  await waitFor(() => order.length === 2)
  expect([...order].sort()).toEqual(['a-start', 'b-start'])

  seq.release('b')
  await second
  seq.release('a')
  await first
})

test("tool_search is model-only and lists the loaded tools with each namespace's instructions once", async () => {
  const registry = makeRegistry()
  registerToolSearchTool(registry)
  const namespace = {
    name: 'mcp__docs',
    description: 'Project documentation',
    instructions: 'Search before reading.',
  }
  registry.register(
    tool('mcp__docs__read', {
      exposure: 'deferred',
      namespace,
      description: 'Read a page\nMore details',
    }),
    tool('mcp__docs__search', { exposure: 'deferred', namespace }),
  )
  expect(registry.get('tool_search')?.exposure).toBe('model-only')
  const run = (query: string) =>
    registry.toAISDKFormat().tool_search!.execute!(
      { query },
      { toolCallId: 'search', messages: [], context: {} },
    )
  expect(await run('mcp__docs__read, mcp__docs__search')).toBe(
    [
      'Loaded 2 tools. They are available from your next call:',
      '- mcp__docs__read: Read a page',
      '- mcp__docs__search: tool mcp__docs__search',
      '',
      '<instructions namespace="mcp__docs">',
      'Search before reading.',
      '</instructions>',
    ].join('\n'),
  )
  expect(await run('unrelated words')).toBe('No matching tools found.')
})
