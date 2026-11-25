import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDatabase } from '../../src/db/sqlite.ts'
import type { ExtensionAPI } from '../../src/driver/extensions/types.ts'
import {
  createVela,
  type Vela,
  type VelaSession,
} from '../../src/driver/index.ts'
import {
  createFauxModel,
  fauxSummary,
  fauxText,
  fauxToolCall,
} from '../../src/testing/core/index.ts'

const created: { vela?: Vela; dirs: string[] } = { dirs: [] }
afterEach(async () => {
  await created.vela?.dispose().catch(() => {})
  created.vela = undefined
  for (const dir of created.dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function setupDir() {
  const dir = mkdtempSync(join(tmpdir(), 'vela-s2b-driver-'))
  created.dirs.push(dir)
  return dir
}

test('TX1 persists assistant message and tool_calls atomically and rolls back together on failure', async () => {
  const cwd = setupDir()
  const db = openDatabase({ path: join(cwd, 'vela.db') })
  const vela = createVela({
    cwd,
    dataDir: cwd,
    db,
    model: createFauxModel({
      responses: [
        fauxToolCall('bash', { command: 'echo ok' }),
        fauxText('done'),
        fauxToolCall('bash', { command: 'echo ok2' }),
      ],
    }),
  })
  created.vela = vela

  const session = vela.session('tx1')
  await session.prompt('run')
  const msgs = db.all<{ id: string; role: string | null }>(
    "SELECT id, role FROM vela_messages WHERE session_id = ? AND kind = 'message'",
    'tx1',
  )
  expect(msgs.length).toBe(4)
  const calls = db.all<{ status: string; tool_name: string }>(
    'SELECT status, tool_name FROM vela_tool_calls WHERE session_id = ?',
    'tx1',
  )
  expect(calls).toEqual([{ status: 'completed', tool_name: 'bash' }])

  // Induce TX1 failure on vela_tool_calls insert: assistant row and tool_call row roll back together.
  db.exec(`
    CREATE TRIGGER fail_tx1_calls BEFORE INSERT ON vela_tool_calls
    BEGIN
      SELECT RAISE(ABORT, 'tx1 rollback');
    END;
  `)
  await expect(session.prompt('fail tx1')).rejects.toThrow('tx1 rollback')
  expect(
    db.all('SELECT id FROM vela_tool_calls WHERE session_id = ?', 'tx1'),
  ).toHaveLength(1)
  expect(
    db.all(
      "SELECT id FROM vela_messages WHERE session_id = ? AND role = 'assistant'",
      'tx1',
    ),
  ).toHaveLength(2)
  db.exec('DROP TRIGGER fail_tx1_calls;')
  await vela.dispose()
  db.close()
})

test('VelaDriver parallel vs sequential gate scheduling and capabilities', async () => {
  const cwd = setupDir()
  let concurrentPar = 0
  let maxPar = 0
  const events: string[] = []
  const parStarted = Promise.withResolvers<void>()
  let parCount = 0

  function probe(api: ExtensionAPI) {
    api.registerTool({
      name: 'par',
      description: 'Parallel tool',
      executionMode: 'parallel',
      inputSchema: z.object({ tag: z.string() }),
      execute: async ({ tag }) => {
        concurrentPar++
        maxPar = Math.max(maxPar, concurrentPar)
        parCount++
        if (parCount === 2) parStarted.resolve()
        await parStarted.promise
        await Bun.sleep(5)
        concurrentPar--
        return tag
      },
    })
    api.registerTool({
      name: 'seq',
      description: 'Sequential tool',
      executionMode: 'sequential',
      inputSchema: z.object({ tag: z.string() }),
      execute: async ({ tag }) => {
        events.push(`start:${tag}`)
        await Bun.sleep(10)
        events.push(`end:${tag}`)
        return tag
      },
    })
  }

  const vela = createVela({
    cwd,
    dataDir: cwd,
    ephemeralSessions: true,
    model: createFauxModel({
      responses: [
        [
          fauxToolCall('probe_par', { tag: 'p1' }),
          fauxToolCall('probe_par', { tag: 'p2' }),
        ],
        [
          fauxToolCall('probe_seq', { tag: 's1' }),
          fauxToolCall('probe_seq', { tag: 's2' }),
        ],
        fauxText('all done'),
      ],
    }),
    extensions: [probe],
  })
  created.vela = vela

  const session = vela.session('gate')
  expect(session.driver.capabilities).toEqual({
    recovery: 'step',
    executionEnv: 'managed',
    steer: true,
    approval: true,
  })
  await session.prompt('run both modes')
  expect(maxPar).toBe(2)
  expect(events).toEqual(['start:s1', 'end:s1', 'start:s2', 'end:s2'])
})

test('mid-step steer() skips remaining sequential calls with exact message and runs steer next', async () => {
  const cwd = setupDir()
  const db = openDatabase({ path: join(cwd, 'vela.db') })
  const executed: string[] = []
  let s!: VelaSession
  function probe(api: ExtensionAPI) {
    api.registerTool({
      name: 'step',
      description: 'Sequential gated step',
      executionMode: 'sequential',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        executed.push(id)
        if (id === 'first') {
          await s.steer('change plan')
        }
        return `ok:${id}`
      },
    })
  }
  const session = createVela({
    cwd,
    dataDir: cwd,
    db,
    model: createFauxModel({
      responses: [
        [
          fauxToolCall('probe_step', { id: 'first' }),
          fauxToolCall('probe_step', { id: 'second' }),
        ],
        fauxText('steered ok'),
      ],
    }),
    extensions: [probe],
  })
  created.vela = session

  s = session.session('steer-skip')
  await s.prompt('do two steps')
  expect(executed).toEqual(['first'])
  const rows = db.all<{ status: string; preview: string | null }>(
    'SELECT status, preview FROM vela_tool_calls WHERE session_id = ? ORDER BY call_index',
    'steer-skip',
  )
  expect(rows).toEqual([
    { status: 'completed', preview: 'ok:first' },
    { status: 'skipped', preview: 'Skipped due to queued user message.' },
  ])
  expect(s.messages.at(-2)).toMatchObject({
    role: 'user',
    content: 'change plan',
  })
  await session.dispose()
  db.close()
})

test('approval suspension -> resolveApproval (approve & deny) -> continueInterrupted lifecycle', async () => {
  const cwd = setupDir()
  const db = openDatabase({ path: join(cwd, 'vela.db') })
  const executed: string[] = []
  const model = createFauxModel({
    responses: [
      fauxToolCall('probe_danger', { action: 'deploy' }),
      fauxToolCall('probe_danger', { action: 'drop' }),
      fauxText('finished'),
    ],
  })
  function probe(api: ExtensionAPI) {
    api.on('tool_call', (event) => {
      if (event.toolName === 'probe_danger') {
        return {
          approval: {
            summary: `Confirm ${String((event.input as { action: string }).action)}`,
          },
        }
      }
    })
    api.registerTool({
      name: 'danger',
      description: 'Dangerous action',
      inputSchema: z.object({ action: z.string() }),
      execute: async ({ action }) => {
        executed.push(action)
        return `executed:${action}`
      },
    })
  }
  const vela = createVela({
    cwd,
    dataDir: cwd,
    db,
    model,
    extensions: [probe],
  })
  created.vela = vela

  const endedReasons: string[] = []
  const session = vela.session('approval-flow')
  session.subscribe((event) => {
    if (event.type === 'agent_end') endedReasons.push(event.reason)
  })

  await session.prompt('deploy now')
  expect(executed).toEqual([])
  expect(endedReasons).toEqual(['waiting_human'])
  const sessionRow1 = db.get<{ state: string; waiting_reason: string | null }>(
    'SELECT state, waiting_reason FROM sessions WHERE id = ?',
    'approval-flow',
  )
  expect(sessionRow1).toEqual({
    state: 'waiting_human',
    waiting_reason: 'approval',
  })
  const pending1 = db.get<{ id: string; summary: string; status: string }>(
    "SELECT id, summary, status FROM approvals WHERE session_id = ? AND status = 'pending'",
    'approval-flow',
  )!
  expect(pending1.summary).toBe('Confirm deploy')

  // Reject a new unrelated prompt while awaiting human decision.
  await expect(session.prompt('unrelated')).rejects.toThrow()

  // Approve and continue.
  session.resolveApproval(pending1.id, {
    approved: true,
    decidedBy: 'liam',
  })
  await session.continueInterrupted()
  expect(executed).toEqual(['deploy'])
  expect(endedReasons).toEqual(['waiting_human', 'waiting_human'])

  // Second approval requested on 'drop' -> deny it.
  const pending2 = db.get<{ id: string; summary: string }>(
    "SELECT id, summary FROM approvals WHERE session_id = ? AND status = 'pending'",
    'approval-flow',
  )!
  expect(pending2.summary).toBe('Confirm drop')
  session.resolveApproval(pending2.id, {
    approved: false,
    reason: 'Operator rejected drop',
    decidedBy: 'liam',
  })
  await session.continueInterrupted()
  expect(executed).toEqual(['deploy'])
  expect(endedReasons).toEqual(['waiting_human', 'waiting_human', 'done'])
  expect(JSON.stringify(model.calls.at(-1)!.prompt)).toContain(
    'Operator rejected drop',
  )

  await vela.dispose()
  db.close()
})

test('crash recovery matrix across pending, running (safe, attempt>=5, location mismatch, unsafe), completed, failed, skipped, interrupted', async () => {
  const cwd = setupDir()
  const dbPath = join(cwd, 'vela.db')
  const db = openDatabase({ path: dbPath })
  const executed: string[] = []
  const now = new Date().toISOString()

  function probe(api: ExtensionAPI) {
    api.registerTool({
      name: 'safe',
      description: 'Safe idempotent tool',
      replay: 'safe',
      inputSchema: z.object({ tag: z.string() }),
      execute: async ({ tag }) => {
        executed.push(`safe:${tag}`)
        return `replayed:${tag}`
      },
    })
    api.registerTool({
      name: 'unsafe',
      description: 'Unsafe tool',
      replay: 'unsafe',
      inputSchema: z.object({ tag: z.string() }),
      execute: async ({ tag }) => {
        executed.push(`unsafe:${tag}`)
        return `unsafe:${tag}`
      },
    })
  }

  const assistantMsg = {
    role: 'assistant' as const,
    content: [
      {
        type: 'tool_call' as const,
        toolCallId: 'c1',
        toolName: 'probe_safe',
        input: { tag: 'pending' },
      },
      {
        type: 'tool_call' as const,
        toolCallId: 'c2',
        toolName: 'probe_safe',
        input: { tag: 'running-safe' },
      },
      {
        type: 'tool_call' as const,
        toolCallId: 'c3',
        toolName: 'probe_safe',
        input: { tag: 'max-attempt' },
      },
      {
        type: 'tool_call' as const,
        toolCallId: 'c4',
        toolName: 'probe_safe',
        input: { tag: 'loc-mismatch' },
      },
      {
        type: 'tool_call' as const,
        toolCallId: 'c5',
        toolName: 'probe_unsafe',
        input: { tag: 'running-unsafe' },
      },
      {
        type: 'tool_call' as const,
        toolCallId: 'c6',
        toolName: 'probe_safe',
        input: { tag: 'done' },
      },
      {
        type: 'tool_call' as const,
        toolCallId: 'c7',
        toolName: 'probe_safe',
        input: { tag: 'failed' },
      },
      {
        type: 'tool_call' as const,
        toolCallId: 'c8',
        toolName: 'probe_safe',
        input: { tag: 'skipped' },
      },
      {
        type: 'tool_call' as const,
        toolCallId: 'c9',
        toolName: 'probe_safe',
        input: { tag: 'interrupted' },
      },
    ],
  }

  const userId = 'u1'
  const asstId = 'a1'
  const runId = 'r1'
  const locJson = JSON.stringify({
    environment: 'local',
    cwd: realpathSync(cwd),
  })
  const toolLocJson = JSON.stringify({
    environment: 'node:local',
    cwd: realpathSync(cwd),
  })
  const otherLoc = JSON.stringify({
    environment: 'node:local',
    cwd: '/tmp/other',
  })

  db.transaction(() => {
    db.run(
      `INSERT INTO sessions (
         id, kind, driver, archived, location_json, leaf_message_id, state, created_at, updated_at
       ) VALUES (?, 'chat', 'vela', 0, ?, ?, 'idle', ?, ?)`,
      'matrix',
      locJson,
      asstId,
      now,
      now,
    )
    db.run(
      "INSERT INTO runs (id, session_id, driver, trigger, status, started_at, updated_at) VALUES (?, ?, 'vela', 'user', 'running', ?, ?)",
      runId,
      'matrix',
      now,
      now,
    )
    db.run(
      "INSERT INTO vela_messages (session_id, id, parent_id, seq, run_id, kind, role, content_json, include_in_context, created_at) VALUES (?, ?, NULL, 1, ?, 'message', 'user', ?, 1, ?)",
      'matrix',
      userId,
      runId,
      JSON.stringify({ role: 'user', content: 'go' }),
      now,
    )
    db.run(
      "INSERT INTO vela_messages (session_id, id, parent_id, seq, run_id, kind, role, content_json, include_in_context, created_at) VALUES (?, ?, ?, 2, ?, 'message', 'assistant', ?, 1, ?)",
      'matrix',
      asstId,
      userId,
      runId,
      JSON.stringify(assistantMsg),
      now,
    )

    const rows: [
      string,
      number,
      string,
      string,
      'safe' | 'none',
      string | null,
      string,
      number,
      number,
      string | null,
    ][] = [
      [
        'c1',
        0,
        'probe_safe',
        '{"tag":"pending"}',
        'safe',
        null,
        'pending',
        0,
        0,
        null,
      ],
      [
        'c2',
        1,
        'probe_safe',
        '{"tag":"running-safe"}',
        'safe',
        toolLocJson,
        'running',
        1,
        0,
        null,
      ],
      [
        'c3',
        2,
        'probe_safe',
        '{"tag":"max-attempt"}',
        'safe',
        toolLocJson,
        'running',
        5,
        0,
        null,
      ],
      [
        'c4',
        3,
        'probe_safe',
        '{"tag":"loc-mismatch"}',
        'safe',
        otherLoc,
        'running',
        1,
        0,
        null,
      ],
      [
        'c5',
        4,
        'probe_unsafe',
        '{"tag":"running-unsafe"}',
        'none',
        toolLocJson,
        'running',
        1,
        0,
        null,
      ],
      [
        'c6',
        5,
        'probe_safe',
        '{"tag":"done"}',
        'safe',
        toolLocJson,
        'completed',
        1,
        0,
        JSON.stringify({ type: 'text', value: 'prior-ok' }),
      ],
      [
        'c7',
        6,
        'probe_safe',
        '{"tag":"failed"}',
        'safe',
        toolLocJson,
        'failed',
        1,
        1,
        JSON.stringify({ type: 'error-text', value: 'prior-err' }),
      ],
      [
        'c8',
        7,
        'probe_safe',
        '{"tag":"skipped"}',
        'safe',
        toolLocJson,
        'skipped',
        0,
        1,
        JSON.stringify({ type: 'error-text', value: 'Skipped earlier' }),
      ],
      [
        'c9',
        8,
        'probe_safe',
        '{"tag":"interrupted"}',
        'safe',
        toolLocJson,
        'interrupted',
        1,
        1,
        JSON.stringify({ type: 'error-text', value: 'Prior interrupted' }),
      ],
    ]
    for (const [
      id,
      idx,
      name,
      input,
      replay,
      loc,
      status,
      attempt,
      isErr,
      resJson,
    ] of rows) {
      db.run(
        `INSERT INTO vela_tool_calls (
           id, session_id, run_id, assistant_message_id, tool_call_id, call_index,
           tool_name, input_json, execution_mode, replay, location_json, status, attempt,
           is_error, result_json, created_at, updated_at
         ) VALUES (?, 'matrix', ?, ?, ?, ?, ?, ?, 'sequential', ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        runId,
        asstId,
        id,
        idx,
        name,
        input,
        replay,
        loc,
        status,
        attempt,
        isErr,
        resJson,
        now,
        now,
      )
    }
  })

  const model = createFauxModel({ responses: [fauxText('matrix done')] })
  const vela = createVela({
    cwd,
    dataDir: cwd,
    db,
    model,
    extensions: [probe],
  })
  created.vela = vela
  const resumed = vela.session('matrix')
  expect(await resumed.resume()).toBe(true)
  await resumed.continueInterrupted()

  // Only c1 (pending) and c2 (running safe with attempt < 5 and matching location) execute.
  expect(executed).toEqual(['safe:pending', 'safe:running-safe'])
  const toolResults = model.calls[0]!.toolResults
  expect(toolResults.find((r) => r.toolCallId === 'c1')?.output).toBe(
    'replayed:pending',
  )
  expect(toolResults.find((r) => r.toolCallId === 'c2')?.output).toBe(
    'replayed:running-safe',
  )
  expect(toolResults.find((r) => r.toolCallId === 'c3')?.output).toContain(
    'interrupted 5 times',
  )
  expect(toolResults.find((r) => r.toolCallId === 'c4')?.output).toContain(
    'location changed',
  )
  expect(toolResults.find((r) => r.toolCallId === 'c5')?.output).toContain(
    'may have partially run',
  )
  expect(toolResults.find((r) => r.toolCallId === 'c6')?.output).toBe(
    'prior-ok',
  )
  expect(toolResults.find((r) => r.toolCallId === 'c7')?.output).toBe(
    'prior-err',
  )
  expect(toolResults.find((r) => r.toolCallId === 'c8')?.output).toBe(
    'Skipped earlier',
  )
  expect(toolResults.find((r) => r.toolCallId === 'c9')?.output).toBe(
    'Prior interrupted',
  )

  await vela.dispose()
  db.close()
})

test('tool_search persists discovered_tools_json across resume, allows post-compaction re-search, and keeps <deferred_tools> prefix immutable', async () => {
  const cwd = setupDir()
  const model = createFauxModel({
    responses: [
      fauxToolCall('tool_search', { query: 'alpha' }),
      fauxText('found alpha'),
      fauxToolCall('tool_search', { query: 'alpha' }),
      fauxText('re-found alpha'),
    ],
    generate: [fauxSummary()],
  })
  function defExt(api: ExtensionAPI) {
    api.registerTool({
      name: 'alpha_tool',
      description: 'Searchable alpha deferred capability',
      exposure: 'deferred',
      inputSchema: z.object({}),
      execute: async () => 'alpha-ok',
    })
    api.registerTool({
      name: 'beta_tool',
      description: 'Searchable beta deferred capability',
      exposure: 'deferred',
      inputSchema: z.object({}),
      execute: async () => 'beta-ok',
    })
  }
  const db = openDatabase({ path: join(cwd, 'vela.db') })
  const vela = createVela({
    cwd,
    dataDir: cwd,
    db,
    model,
    extensions: [defExt],
  })
  created.vela = vela

  const session = vela.session('search-db')
  await session.prompt('search for alpha')
  expect(model.calls[0]!.system).toContain('<deferred_tools>')
  // Prefix cache invariant: system prompt remains identical after tool_search loads defExt_alpha_tool.
  expect(model.calls[1]!.system).toBe(model.calls[0]!.system)
  expect(model.calls[1]!.tools).toContain('defExt_alpha_tool')
  const discoveredRow = db.get<{ discovered_tools_json: string | null }>(
    'SELECT discovered_tools_json FROM sessions WHERE id = ?',
    'search-db',
  )
  expect(JSON.parse(discoveredRow!.discovered_tools_json!)).toContain(
    'defExt_alpha_tool',
  )

  await session.compact()
  await session.prompt('search alpha again')
  const streams = model.calls.filter((c) => c.kind === 'stream')
  expect(streams[3]!.toolResults[0]!.output).toContain('defExt_alpha_tool')
  expect(streams[3]!.system).toBe(streams[0]!.system)

  await vela.dispose()

  const model2 = createFauxModel({ responses: [fauxText('after resume')] })
  const vela2 = createVela({
    cwd,
    dataDir: cwd,
    db,
    model: model2,
    extensions: [defExt],
  })
  created.vela = vela2
  const resumed = vela2.session('search-db')
  expect(await resumed.resume()).toBe(true)
  await resumed.prompt('check tools')
  expect(model2.calls[0]!.tools).toContain('defExt_alpha_tool')
  await vela2.dispose()
  db.close()
})
