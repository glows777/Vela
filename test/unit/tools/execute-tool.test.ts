import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod'
import type { VelaEvent } from '../../../src/agent/events.ts'
import { HookPipeline } from '../../../src/security/hooks.ts'
import { ToolResultStore } from '../../../src/session/tool-results.ts'
import {
  type ToolCallOutcome,
  type ToolContext,
  type ToolDefinition,
  ToolRegistry,
} from '../../../src/tools/registry.ts'
import { createBashTool } from '../../../src/tools/shell.ts'

const root = mkdtempSync(join(tmpdir(), 'vela-execute-tool-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A session registry whose events are collected */
function makeSession(...tools: ToolDefinition[]) {
  const events: VelaEvent[] = []
  const base = new ToolRegistry()
  base.register(...tools)
  const registry = base.fork(
    new ToolResultStore(join(root, crypto.randomUUID(), 'outputs')),
    { onEvent: (event) => events.push(event) },
  )
  return { base, registry, events }
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

/** A tool that runs `calls` through ctx.executeTool() and returns the outcomes */
function caller(
  calls: Array<[string, unknown]>,
  onContext?: (context: ToolContext) => void,
): ToolDefinition {
  return tool('caller', {
    execute: async (_input, context) => {
      onContext?.(context!)
      const outcomes: ToolCallOutcome[] = []
      for (const [name, args] of calls)
        outcomes.push(await context!.executeTool!(name, args))
      return outcomes
    },
  })
}

async function callModelTool(
  registry: ToolRegistry,
  name: string,
  input: unknown = {},
  toolCallId = 'call-1',
) {
  return registry.toAISDKFormat()[name]!.execute!(input, {
    toolCallId,
    messages: [],
    context: {},
  })
}

/** The caller tool's outcomes (a non-string result reaches the model as JSON text) */
async function callCaller(registry: ToolRegistry): Promise<ToolCallOutcome[]> {
  return JSON.parse(String(await callModelTool(registry, 'caller')))
}

test('executeTool runs callable tools with nested ids and parentToolCallId on events', async () => {
  const echo = tool('echo', {
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }: { text: string }) => `echo ${text}`,
  })
  const { registry, events } = makeSession(
    caller([
      ['echo', { text: 'a' }],
      ['hidden_helper', {}],
      ['deferred_one', {}],
    ]),
    echo,
    tool('hidden_helper', { exposure: 'codemode', execute: async () => 'cm' }),
    tool('deferred_one', { exposure: 'deferred', execute: async () => 'df' }),
  )
  const outcomes = await callCaller(registry)
  expect(outcomes.map(({ durationMs: _, ...rest }) => rest)).toEqual([
    {
      toolCallId: 'call-1/1',
      toolName: 'echo',
      result: 'echo a',
      isError: false,
    },
    {
      toolCallId: 'call-1/2',
      toolName: 'hidden_helper',
      result: 'cm',
      isError: false,
    },
    {
      toolCallId: 'call-1/3',
      toolName: 'deferred_one',
      result: 'df',
      isError: false,
    },
  ])
  expect(outcomes.every((o) => typeof o.durationMs === 'number')).toBe(true)
  const nested = events.filter(
    (e) => e.type === 'tool_execution_start' || e.type === 'tool_execution_end',
  )
  expect(nested.map((e) => [e.type, e.toolCallId, e.parentToolCallId])).toEqual(
    [
      ['tool_execution_start', 'call-1/1', 'call-1'],
      ['tool_execution_end', 'call-1/1', 'call-1'],
      ['tool_execution_start', 'call-1/2', 'call-1'],
      ['tool_execution_end', 'call-1/2', 'call-1'],
      ['tool_execution_start', 'call-1/3', 'call-1'],
      ['tool_execution_end', 'call-1/3', 'call-1'],
    ],
  )
})

test('executeTool never throws: unknown, uncallable, invalid, denied and failing calls are isError results', async () => {
  const { registry } = makeSession(
    caller([
      ['missing', {}],
      ['model_only', {}],
      ['secret', {}],
      ['strict', { n: 'not a number' }],
      ['denied', {}],
      ['boom', {}],
    ]),
    tool('model_only', { exposure: 'model-only' }),
    tool('secret', { exposure: 'hidden' }),
    tool('strict', { inputSchema: z.object({ n: z.number() }) }),
    tool('denied'),
    tool('boom', {
      execute: async () => {
        throw new Error('kaboom')
      },
    }),
  )
  registry.setPermissions({ denied: 'deny' })
  const outcomes = await callCaller(registry)
  expect(outcomes.every((o) => o.isError)).toBe(true)
  const results = outcomes.map((o) => String(o.result))
  expect(results[0]).toBe('Tool missing not found')
  expect(results[1]).toContain('model_only cannot be called from a tool')
  expect(results[2]).toContain('secret cannot be called from a tool')
  expect(results[3]).toStartWith('Invalid arguments for strict:')
  expect(results[4]).toContain('denied cannot be called from a tool')
  expect(results[5]).toBe('kaboom')
  // Only the call that ran has a duration
  expect(outcomes.map((o) => o.durationMs !== undefined)).toEqual([
    false,
    false,
    false,
    false,
    false,
    true,
  ])
})

test('executeTool goes through hooks and ask like a model call', async () => {
  const seen: Array<[string, string | undefined]> = []
  let asked = 0
  const { base, registry } = makeSession(
    caller([
      ['guarded', {}],
      ['rewritten', { value: 1 }],
      ['asking', {}],
    ]),
    tool('guarded'),
    tool('rewritten', {
      inputSchema: z.object({ value: z.number() }),
      execute: async ({ value }: { value: number }) => `value ${value}`,
    }),
    tool('asking'),
  )
  const hooks = new HookPipeline()
  hooks.registerPre('test', (name, _input, context) => {
    seen.push([name, context.toolCallId])
    if (name === 'guarded') return { action: 'block', reason: 'not today' }
    if (name === 'rewritten')
      return { action: 'modify', modifiedInput: { value: 2 } }
    return { action: 'allow' }
  })
  hooks.registerPost('test', (name, _input, output) =>
    name === 'rewritten'
      ? { action: 'modify', modifiedOutput: `${output}!` }
      : { action: 'allow' },
  )
  base.setHookPipeline(hooks)
  const confirmed = base.fork(registry.results, {
    confirm: async () => {
      asked++
      return false
    },
  })
  confirmed.setPermissions({ asking: 'ask' })
  const outcomes = await callCaller(confirmed)
  expect(outcomes.map((o) => [o.isError, o.result])).toEqual([
    [true, '[Blocked by hook] not today'],
    [false, 'value 2!'],
    [true, '[Rejected] asking was not approved'],
  ])
  expect(asked).toBe(1)
  expect(seen).toEqual([
    ['caller', 'call-1'],
    ['guarded', 'call-1/1'],
    ['rewritten', 'call-1/2'],
    ['asking', 'call-1/3'],
  ])
})

test('a sequential tool can call another sequential tool without deadlocking', async () => {
  const { registry } = makeSession(
    {
      ...caller([['inner', {}]]),
      executionMode: 'sequential',
    },
    tool('inner', { executionMode: 'sequential', execute: async () => 'in' }),
  )
  const outcomes = await callCaller(registry)
  expect(outcomes[0]).toMatchObject({ result: 'in', isError: false })
})

test('onUpdate emits tool_execution_update until the call settles, also for nested calls', async () => {
  let late: ((partial: unknown) => void) | undefined
  const forwarded: unknown[] = []
  const streamer = tool('streamer', {
    execute: async (_input, context) => {
      context!.onUpdate!({ step: 1 })
      context!.onUpdate!({ step: 2 })
      late = context!.onUpdate
      return 'done'
    },
  })
  const nester = tool('nester', {
    execute: async (_input, context) => {
      const outcome = await context!.executeTool!(
        'streamer',
        {},
        { onUpdate: (partial) => forwarded.push(partial) },
      )
      return outcome.result
    },
  })
  const { registry, events } = makeSession(streamer, nester)
  expect(await callModelTool(registry, 'streamer', {}, 'top')).toBe('done')
  late?.({ step: 3 })
  expect(await callModelTool(registry, 'nester', {}, 'outer')).toBe('done')
  const updates = events.filter((e) => e.type === 'tool_execution_update')
  expect(
    updates.map((e) => [e.toolCallId, e.parentToolCallId, e.partialResult]),
  ).toEqual([
    ['top', undefined, { step: 1 }],
    ['top', undefined, { step: 2 }],
    ['outer/1', 'outer', { step: 1 }],
    ['outer/1', 'outer', { step: 2 }],
  ])
  expect(forwarded).toEqual([{ step: 1 }, { step: 2 }])
})

test('bash streams the tail of its output while it runs', async () => {
  const { registry, events } = makeSession(createBashTool(root))
  await callModelTool(
    registry,
    'bash',
    { command: "printf 'first\\n'; sleep 0.4; printf 'second\\n'" },
    'bash-1',
  )
  const texts = events
    .filter((e) => e.type === 'tool_execution_update')
    .map(
      (e) =>
        (e.partialResult as { content: Array<{ text: string }> }).content[0]!
          .text,
    )
  expect(texts[0]).toBe('first\n')
  // Updates are sent only when the output grew
  expect(new Set(texts).size).toBe(texts.length)
})

test('bash failures are error results; the model reads the output and the status', async () => {
  const { registry } = makeSession(createBashTool(root))
  await expect(
    callModelTool(registry, 'bash', { command: "printf 'oops\\n'; exit 3" }),
  ).rejects.toThrow(/^oops\n\n\nCommand exited with code 3$/)
  const outcomes = await callCaller(
    makeSession(createBashTool(root), caller([['bash', { command: 'exit 4' }]]))
      .registry,
  )
  expect(outcomes[0]).toMatchObject({
    isError: true,
    result: '(no output)\n\nCommand exited with code 4',
  })
})
