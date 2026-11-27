import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  cleanupTestVelas,
  createTestVela,
} from '../../../../../../test/support/vela.ts'
import { openDatabase, type VelaDatabase } from '../../../../src/db/index.ts'
import { SessionStore } from '../../../../src/driver/session/index.ts'
import {
  executeStepCalls,
  type VelaToolCallRow,
} from '../../../../src/driver/tool-executor.ts'
import {
  type ToolDefinition,
  ToolRegistry,
} from '../../../../src/driver/tools/registry.ts'
import { ToolExecutionResult } from '../../../../src/driver/tools/types.ts'
import { createJsonSchema } from '../../../../src/shared/tool-schema.ts'
import { fauxText, fauxToolCall } from '../../../../src/testing/core/index.ts'

const root = mkdtempSync(join(tmpdir(), 'vela-security-acceptance-'))
const dbs: VelaDatabase[] = []
afterAll(() => rmSync(root, { recursive: true, force: true }))
const spies: Array<{ mockRestore(): void }> = []
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  for (const db of dbs.splice(0)) if (db.open) db.close()
  await cleanupTestVelas()
})
function quiet(method: 'log' | 'warn' | 'error') {
  const spy = spyOn(console, method).mockImplementation(() => {})
  spies.push(spy)
  return spy
}
function fixture() {
  const db = openDatabase({ path: ':memory:' })
  dbs.push(db)
  const store = new SessionStore('sec-test', db, { ephemeral: true })
  store.ensureSessionRow()
  const registry = new ToolRegistry(join(root, crypto.randomUUID(), 'outputs'))
  return { db, store, registry }
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
async function invoke(
  fx: ReturnType<typeof fixture>,
  name: string,
  input: unknown = { command: 'echo hello' },
  signal?: AbortSignal,
): Promise<VelaToolCallRow> {
  const now = new Date().toISOString()
  const runId = crypto.randomUUID()
  fx.db.run(
    `INSERT INTO runs (id, session_id, driver, trigger, status, started_at, updated_at)
     VALUES (?, 'sec-test', 'vela', 'user', 'running', ?, ?)`,
    runId,
    now,
    now,
  )
  const id = crypto.randomUUID()
  const toolCallId = crypto.randomUUID()
  const row: VelaToolCallRow = {
    id,
    session_id: 'sec-test',
    run_id: runId,
    assistant_message_id: crypto.randomUUID(),
    tool_call_id: toolCallId,
    call_index: 0,
    tool_name: name,
    input_json: JSON.stringify(input),
    execution_mode: fx.registry.get(name)?.executionMode ?? 'sequential',
    replay: fx.registry.get(name)?.replay === 'safe' ? 'safe' : 'none',
    location_json: null,
    status: 'pending',
    attempt: 0,
    is_error: 0,
    preview: null,
    result_json: null,
    spill_path: null,
    details_json: null,
    duration_ms: null,
    started_at: null,
    finished_at: null,
    created_at: now,
    updated_at: now,
  }
  fx.db.run(
    `INSERT INTO vela_tool_calls (
       id, session_id, run_id, assistant_message_id, tool_call_id, call_index,
       tool_name, input_json, execution_mode, replay, status, attempt, is_error,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)`,
    row.id,
    row.session_id,
    row.run_id,
    row.assistant_message_id,
    row.tool_call_id,
    row.tool_name,
    row.input_json,
    row.execution_mode,
    row.replay,
    now,
    now,
  )
  await executeStepCalls({
    db: fx.db,
    store: fx.store,
    registry: fx.registry,
    sessionId: 'sec-test',
    rows: [row],
    emit: () => {},
    signal,
  })
  return fx.db.get<Record<string, unknown>>(
    'SELECT * FROM vela_tool_calls WHERE id = ?',
    id,
  ) as unknown as VelaToolCallRow
}

function sessionToolRows(dataDir: string) {
  const db = openDatabase({ path: join(dataDir, 'vela.db'), readonly: true })
  try {
    return db.all<Record<string, unknown>>(
      'SELECT * FROM vela_tool_calls ORDER BY created_at ASC',
    ) as unknown as VelaToolCallRow[]
  } finally {
    db.close()
  }
}

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
      fauxToolCall('read', { path: 'original.txt' }),
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
  expect(JSON.parse(String(sessionToolRows(t.dataDir)[0]?.input_json))).toEqual(
    {
      path: 'final.txt',
    },
  )
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
    expect(sessionToolRows(t.dataDir).map((row) => row.status)).toEqual([
      'failed',
    ])
  })
}

for (const kind of ['zod', 'json'] as const) {
  test(`modified input is validated before execution (${kind} schema)`, async () => {
    const fx = fixture()
    let calls = 0
    fx.registry.setInterception({
      before: () => ({ input: { command: 42 } }),
    })
    fx.registry.register(
      fake('read', {
        ...(kind === 'json'
          ? {
              inputSchema: createJsonSchema({
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
    const row = await invoke(fx, 'read')
    expect(row.status).toBe('failed')
    expect(row.preview?.toLowerCase()).toContain('invalid')
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
    responses: [fauxToolCall('read', { path: 'source.txt' }), fauxText('done')],
  })
  await t.run('Read the file')
  expect(seen).toEqual(['original', 'one', 'one', 'one'])
  expect(t.model.calls[1]!.toolResults[0]!.output).toBe('one-two')
  expect(sessionToolRows(t.dataDir)[0]?.status).toBe('completed')
})

test('post changes model text while details preserve native small result', async () => {
  const fx = fixture()
  fx.registry.setInterception({
    after: (_name, input, output) => {
      expect(input).toEqual({ command: 'echo hello' })
      expect(output).toBe('original')
      return 'decorated'
    },
  })
  fx.registry.register(
    fake('read', {
      execute: async () =>
        new ToolExecutionResult({ native: true }, 'original', { exitCode: 0 }),
    }),
  )
  const row = await invoke(fx, 'read')
  expect(row.preview).toBe('decorated')
  expect(JSON.parse(String(row.details_json))).toEqual({ native: true })
  expect(row.status).toBe('completed')
})

test('post preserves spillPath and original file when output exceeds maxResultChars', async () => {
  const fx = fixture()
  const original = 'full output '.repeat(100)
  fx.registry.setInterception({
    after: (_name, _input, output) => {
      expect(typeof output).toBe('string')
      return 'custom preview'
    },
  })
  fx.registry.register(
    fake('read', {
      maxResultChars: 30,
      execute: async () =>
        new ToolExecutionResult(original, original, { exitCode: 0 }),
    }),
  )
  const row = await invoke(fx, 'read')
  expect(row.preview).toBe('custom preview')
  expect(await Bun.file(String(row.spill_path)).text()).toBe(original)
  expect(row.status).toBe('completed')
})

test('pre-aborted call never executes and records aborted error result', async () => {
  const fx = fixture()
  let calls = 0
  fx.registry.register(
    fake('read', {
      execute: async () => {
        calls++
        return 'bad'
      },
    }),
  )
  const controller = new AbortController()
  controller.abort()
  const row = await invoke(
    fx,
    'read',
    { command: 'echo hello' },
    controller.signal,
  )
  expect(calls).toBe(0)
  expect(row.status).toBe('failed')
  expect(row.preview).toContain('aborted')
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
  expect(await t.command('/hooks')).toBe(true)
  expect(log.mock.calls.flat().join(' ')).toContain('acceptancePre')
  expect(log.mock.calls.flat().join(' ')).toContain('acceptancePost')
  expect(t.dispatch('/unrelated')).toBe(false)
})
