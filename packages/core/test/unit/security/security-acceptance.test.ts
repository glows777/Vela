import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import { jsonSchema } from 'ai'
import { z } from 'zod'
import {
  cleanupTestVelas,
  createTestVela,
} from '../../../../../test/support/vela.ts'
import { decidePermission } from '../../../src/security/permissions.ts'
import { ToolResultStore } from '../../../src/session/tool-results.ts'
import {
  type ToolDefinition,
  ToolRegistry,
} from '../../../src/tools/registry.ts'
import { ToolExecutionResult } from '../../../src/tools/types.ts'

const root = mkdtempSync(join(tmpdir(), 'vela-security-acceptance-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const spies: Array<{ mockRestore(): void }> = []
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  await cleanupTestVelas()
})
function quiet(method: 'log' | 'warn' | 'error') {
  const spy = spyOn(console, method).mockImplementation(() => {})
  spies.push(spy)
  return spy
}
function fixture() {
  const registry = new ToolRegistry(
    new ToolResultStore(join(root, crypto.randomUUID(), 'outputs')),
  )
  return { registry }
}
function fake(
  name: string,
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: z.object({ command: z.string() }),
    execute: async () => 'original',
    ...overrides,
  }
}
function invoke(
  registry: ToolRegistry,
  name: string,
  input: unknown = { command: 'echo hello' },
  signal?: AbortSignal,
) {
  const execute = registry.toAISDKFormat()[name]?.execute
  if (!execute) throw new Error(`Missing executable ${name}`)
  return Promise.resolve(
    execute(input, {
      toolCallId: crypto.randomUUID(),
      messages: [],
      context: undefined,
      abortSignal: signal,
    }),
  )
}
type HistoryRow = { type: string; status?: string; input?: unknown } & Record<
  string,
  unknown
>
async function rows(registry: ToolRegistry): Promise<HistoryRow[]> {
  return (await Bun.file(registry.results.history.path).text())
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}
async function rejected(registry: ToolRegistry, attempt: Promise<unknown>) {
  await attempt.catch(() => {})
  const records = await rows(registry)
  expect(
    records
      .filter((row) => row.type === 'tool_result')
      .map((row) => row.status),
  ).toEqual(['rejected'])
}

test('session permission rules: no rule means allow; exact names beat *', () => {
  expect(decidePermission('bash')).toBe('allow')
  expect(decidePermission('bash', {})).toBe('allow')
  expect(decidePermission('bash', { bash: 'deny' })).toBe('deny')
  expect(decidePermission('rag_search', { rag_search: 'ask' })).toBe('ask')
  expect(decidePermission('rag_search', { '*': 'deny' })).toBe('deny')
  expect(decidePermission('bash', { '*': 'ask' })).toBe('ask')
  expect(
    decidePermission('read_file', { '*': 'deny', read_file: 'allow' }),
  ).toBe('allow')
})

test('ask runs the confirm callback with the final input; no callback means deny', async () => {
  const { registry } = fixture()
  let calls = 0
  registry.register(
    fake('bash', {
      execute: async () => {
        calls++
        return 'ran'
      },
    }),
  )
  registry.setPermissions({ bash: 'ask' })
  await rejected(registry, invoke(registry, 'bash'))
  expect(calls).toBe(0)

  const asked: unknown[] = []
  const forked = registry.fork(
    new ToolResultStore(join(root, crypto.randomUUID(), 'outputs')),
    {
      confirm: async (_name, input) => {
        asked.push(input)
        return true
      },
    },
  )
  forked.setPermissions({ bash: 'ask' })
  expect(await invoke(forked, 'bash')).toContain('ran')
  expect(asked).toEqual([{ command: 'echo hello' }])
})

test('a permission change rejects an already exposed tool and records rejection', async () => {
  const { registry } = fixture()
  let calls = 0
  registry.register(
    fake('bash', {
      execute: async () => {
        calls++
        return 'bad'
      },
    }),
  )
  const execute = registry.toAISDKFormat().bash!.execute!
  registry.setPermissions({ bash: 'deny' })
  await rejected(
    registry,
    Promise.resolve(
      execute(
        { command: 'echo hello' },
        { toolCallId: crypto.randomUUID(), messages: [], context: undefined },
      ),
    ),
  )
  expect(calls).toBe(0)
})

test('tool_call modifications chain through handlers into execution and history', async () => {
  const seen: unknown[] = []
  const t = createTestVela({
    files: { 'final.txt': 'done' },
    extensions: [
      function first(vela) {
        vela.on('tool_call', (event) => {
          seen.push({ ...event.input })
          event.input.path = 'second.txt'
        })
      },
      function second(vela) {
        vela.on('tool_call', (event) => {
          seen.push({ ...event.input })
          event.input.path = 'final.txt'
        })
      },
      function allow(vela) {
        vela.on('tool_call', (event) => {
          seen.push({ ...event.input })
        })
      },
    ],
    responses: [
      fauxToolCall('read_file', { path: 'original.txt' }),
      fauxText('done'),
    ],
  })
  await t.run('Read the file')
  expect(seen).toEqual([
    { path: 'original.txt' },
    { path: 'second.txt' },
    { path: 'final.txt' },
  ])
  expect(t.model.calls[1]!.toolResults[0]!.output).toBe('done')
  expect(
    (await rows(t.session.registry)).find((row) => row.type === 'tool_call')
      ?.input,
  ).toEqual({ path: 'final.txt' })
})

for (const throws of [false, true]) {
  test(`tool_call ${throws ? 'exception' : 'block'} stops following handlers and execution`, async () => {
    let calls = 0
    const t = createTestVela({
      extensions: [
        function block(vela) {
          vela.on('tool_call', () => {
            if (throws) throw new Error('acceptance failure')
            return { block: true, reason: 'acceptance block' }
          })
        },
        function unreachable(vela) {
          vela.on('tool_call', () => {
            calls++
          })
          vela.registerTool({
            name: 'probe',
            description: 'Must not execute',
            inputSchema: z.object({}),
            execute: async () => {
              calls++
              return 'bad'
            },
          })
        },
      ],
      responses: [fauxToolCall('unreachable_probe', {}), fauxText('blocked')],
    })
    await t.run('Run the probe')
    expect(calls).toBe(0)
    expect(t.model.calls[1]!.toolResults[0]!.output).toContain(
      throws
        ? 'Extension block check failed: acceptance failure'
        : 'acceptance block',
    )
    expect(
      (await rows(t.session.registry))
        .filter((row) => row.type === 'tool_result')
        .map((row) => row.status),
    ).toEqual(['rejected'])
  })
}

for (const kind of ['zod', 'json'] as const) {
  test(`modified input is validated before execution (${kind} schema)`, async () => {
    const { registry } = fixture()
    let calls = 0
    registry.setInterception({
      before: () => ({ input: { command: 42 } }),
    })
    registry.register(
      fake('read_file', {
        ...(kind === 'json'
          ? {
              inputSchema: jsonSchema({
                type: 'object',
                properties: { command: { type: 'string' } },
                required: ['command'],
              }),
            }
          : {}),
        execute: async () => {
          calls++
          return 'bad'
        },
      }),
    )
    await rejected(registry, invoke(registry, 'read_file'))
    expect(calls).toBe(0)
  })
}

test('tool_result chains modifications and preserves the previous output after exceptions', async () => {
  const seen: string[] = []
  const t = createTestVela({
    files: { 'source.txt': 'original' },
    extensions: [
      function first(vela) {
        vela.on('tool_result', (event) => {
          seen.push(event.output)
          return { output: 'one' }
        })
      },
      function unchanged(vela) {
        vela.on('tool_result', (event) => {
          seen.push(event.output)
        })
      },
      function throws(vela) {
        vela.on('tool_result', (event) => {
          seen.push(event.output)
          throw new Error('expected isolated failure')
        })
      },
      function last(vela) {
        vela.on('tool_result', (event) => {
          seen.push(event.output)
          return { output: `${event.output}-two` }
        })
      },
    ],
    responses: [
      fauxToolCall('read_file', { path: 'source.txt' }),
      fauxText('done'),
    ],
  })
  await t.run('Read the file')
  expect(seen).toEqual(['original', 'one', 'one', 'one'])
  expect(t.model.calls[1]!.toolResults[0]!.output).toBe('one-two')
  expect(
    (await rows(t.session.registry)).find((row) => row.type === 'tool_result')
      ?.output,
  ).toBe('original')
})

test('post changes model text while history preserves native small result', async () => {
  const { registry } = fixture()
  registry.setInterception({
    after: (_name, input, output) => {
      expect(input).toEqual({ command: 'echo hello' })
      expect(output).toBe('original')
      return 'decorated'
    },
  })
  registry.register(
    fake('read_file', {
      execute: async () =>
        new ToolExecutionResult({ native: true }, 'original', { exitCode: 0 }),
    }),
  )
  expect(await invoke(registry, 'read_file')).toBe('decorated')
  const record = (await rows(registry)).find(
    (row) => row.type === 'tool_result',
  )
  expect(record?.output).toEqual({ native: true })
  expect(record?.exitCode).toBe(0)
})

for (const preStored of [false, true]) {
  test(`post preserves stored result metadata and original file (preStored=${preStored})`, async () => {
    const { registry } = fixture()
    const original = 'full output '.repeat(100)
    registry.setInterception({
      after: (_name, _input, output) => {
        expect(typeof output).toBe('string')
        return 'custom preview'
      },
    })
    registry.register(
      fake('read_file', {
        maxResultChars: 30,
        execute: async (_input, ctx) => {
          if (!preStored)
            return new ToolExecutionResult(original, original, { exitCode: 0 })
          const stored = await ctx!.results.save(
            original,
            'read_file',
            'initial preview',
            ctx!.toolCallId,
            ctx!.callId,
          )
          stored.execution = { exitCode: 0 }
          return stored
        },
      }),
    )
    const result = await invoke(registry, 'read_file')
    expect(result).toBe('custom preview')
    const record = (await rows(registry)).find(
      (row) => row.type === 'tool_result',
    )
    expect(record?.exitCode).toBe(0)
    expect(record?.bytes).toBe(Buffer.byteLength(original))
    expect(await Bun.file(String(record?.outputPath)).text()).toBe(original)
    expect(record?.status).toBe('completed')
  })
}

test('pre-aborted call never executes and existing cancelled history survives', async () => {
  const { registry } = fixture()
  let calls = 0
  registry.register(
    fake('read_file', {
      execute: async () => {
        calls++
        return 'bad'
      },
    }),
  )
  const controller = new AbortController()
  controller.abort()
  await invoke(
    registry,
    'read_file',
    { command: 'echo hello' },
    controller.signal,
  ).catch(() => {})
  expect(calls).toBe(0)
  expect(
    (await rows(registry)).find((row) => row.type === 'tool_result')?.status,
  ).toBe('cancelled')
})

test('/hooks lists registered hooks', async () => {
  const t = createTestVela({
    extensions: [
      function acceptancePre(vela) {
        vela.on('tool_call', () => {})
      },
      function acceptancePost(vela) {
        vela.on('tool_result', () => {})
      },
    ],
  })
  const log = quiet('log')
  expect(t.dispatch('/hooks')).toBe(true)
  expect(log.mock.calls.flat().join(' ')).toContain('acceptancePre')
  expect(log.mock.calls.flat().join(' ')).toContain('acceptancePost')
  expect(t.dispatch('/unrelated')).toBe(false)
})
