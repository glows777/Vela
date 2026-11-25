import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { openDatabase } from '../../src/db/sqlite.ts'
import { persistAssistantStepTx } from '../../src/driver/driver-step.ts'
import { SpilledToolOutput as ExtSpilledToolOutput } from '../../src/driver/extension-api.ts'
import type { ExtensionAPI } from '../../src/driver/extensions/types.ts'
import {
  createVela,
  type Vela,
  type VelaSession,
} from '../../src/driver/index.ts'
import { SessionStore } from '../../src/driver/session/index.ts'
import { loadStepToolCallRows } from '../../src/driver/step-recovery.ts'
import { executeStepCalls } from '../../src/driver/tool-executor.ts'
import { ToolRegistry } from '../../src/driver/tools/registry.ts'
import { ToolExecutionResult } from '../../src/driver/tools/types.ts'
import { TokenTracker } from '../../src/driver/usage/tracker.ts'
import { VelaDriver } from '../../src/driver/vela-driver.ts'
import {
  type ApprovalDecision,
  type PendingApprovalInfo,
  type ResolvedApprovalInfo,
  SpilledToolOutput,
} from '../../src/index.ts'
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

test('R1 #1/#2/#3/#6/#7/#13: atomic driver claim, approval binding, blank summary normalization, sequential ordering, no turn_end on waiting_human, and run reuse', async () => {
  const cwd = setupDir()
  const db = openDatabase({ path: join(cwd, 'vela.db') })
  let preHookCalls = 0
  let ranSecondTool = false
  function gateExt(api: ExtensionAPI) {
    api.registerTool({
      name: 'first_seq',
      description: 'Sequential gated tool',
      executionMode: 'sequential',
      inputSchema: z.object({ cmd: z.string() }),
      execute: async ({ cmd }: { cmd: string }) => `ran:${cmd}`,
    })
    api.registerTool({
      name: 'second_step',
      description: 'Second tool after sequential barrier',
      executionMode: 'parallel',
      inputSchema: z.object({}),
      execute: async () => {
        ranSecondTool = true
        return 'second-ok'
      },
    })
    api.on('tool_call', (event) => {
      if (event.toolName !== 'gateExt_first_seq') return
      preHookCalls++
      // R1 #3: empty string summary must normalize instead of silently bypassing approval
      return { approval: { summary: '   ' } }
    })
  }

  const events: string[] = []
  const vela2 = createVela({
    cwd,
    dataDir: cwd,
    db,
    extensions: [gateExt],
    model: createFauxModel({
      responses: [
        {
          text: '',
          toolCalls: [
            {
              id: 'c-1',
              name: 'gateExt_first_seq',
              input: { cmd: 'safe' },
            },
            { id: 'c-2', name: 'gateExt_second_step', input: {} },
          ],
        },
        fauxText('all done'),
      ],
    }),
  })
  created.vela = vela2
  const session = vela2.session('r1-driver')
  session.subscribe((e) => {
    events.push(e.type)
  })
  await session.prompt('run both')
  expect(ranSecondTool).toBe(false)
  expect(preHookCalls).toBe(1)
  // S2-fix: turn_end is emitted before suspending in waiting_human
  expect(events).toContain('turn_end')

  // R1 #3 & #20: pendingApprovals normalized summary
  const pending = session.pendingApprovals()
  expect(pending).toHaveLength(1)
  expect(pending[0]!.summary).toBe('Approval required for gateExt_first_seq')
  const runsBefore = db.all<{ id: string; status: string }>(
    'SELECT id, status FROM runs WHERE session_id = ?',
    'r1-driver',
  )
  expect(runsBefore).toHaveLength(1)
  expect(runsBefore[0]!.status).toBe('waiting_human')

  // R1 #1: second fresh driver.run while state != idle cannot overwrite waiting_human
  const resumedStore = new SessionStore('r1-driver', db)
  await resumedStore.loadSaved()
  const driver2 = new VelaDriver({
    sessionId: 'r1-driver',
    db,
    store: resumedStore,
    registry: session.registry,
    tracker: new TokenTracker(),
  })
  await expect(
    driver2.run({
      model: 'openai/gpt-5',
      systemPrompt: '',
      messages: [],
      prepareContext: async () => {},
    }),
  ).rejects.toThrow(/cannot start a new run while state is 'waiting_human'/i)

  session.resolveApproval(pending[0]!.id, { approved: true })
  await session.continueInterrupted()
  expect(ranSecondTool).toBe(true)
  // R1 #2: approved input did not re-run tool_call pre-hook
  expect(preHookCalls).toBe(1)
  // R1 #13: reused existing waiting_human run row
  const runsAfter = db.all<{ id: string; status: string }>(
    'SELECT id, status FROM runs WHERE session_id = ?',
    'r1-driver',
  )
  expect(runsAfter).toHaveLength(1)
  expect(runsAfter[0]!.id).toBe(runsBefore[0]!.id)
  expect(runsAfter[0]!.status).toBe('completed')

  // Check tampering rejection (#2) and malformed approval blocking (#3)
  let ranTampered = false
  const vela3 = createVela({
    cwd,
    dataDir: cwd,
    db,
    extensions: [
      function tamperExt(api: ExtensionAPI) {
        api.registerTool({
          name: 'op',
          description: 'op',
          inputSchema: z.object({ path: z.string() }),
          execute: async () => {
            ranTampered = true
            return 'ok'
          },
        })
        api.on('tool_call', (ev) => {
          if (ev.toolName === 'tamperExt_op')
            return { approval: { summary: 'Confirm op' } }
        })
      },
    ],
    model: createFauxModel({
      responses: [
        fauxToolCall('tamperExt_op', { path: 'safe.txt' }, { id: 't-1' }),
        fauxText('handled'),
      ],
    }),
  })
  created.vela = vela3
  const s3 = vela3.session('tamper-sess')
  await s3.prompt('go')
  const app3 = s3.pendingApprovals()[0]!
  s3.resolveApproval(app3.id, { approved: true })
  db.run(
    'UPDATE vela_tool_calls SET input_json = ? WHERE session_id = ? AND tool_call_id = ?',
    JSON.stringify({ path: 'evil.txt' }),
    'tamper-sess',
    't-1',
  )
  await s3.continueInterrupted()
  expect(ranTampered).toBe(false)
  expect(JSON.stringify(s3.messages)).toContain(
    'Tool input changed after human approval',
  )

  await vela2.dispose()
  await vela3.dispose()
  db.close()
})

test('R1 #1/#3/#4/#5/#8/#11: TX2a conflict, malformed approval, disabled replay, TX1 rollback, mixed tool assembly, single Zod transform', async () => {
  const cwd = setupDir()
  const db = openDatabase({ path: join(cwd, 'vela.db') })
  const store = new SessionStore('tx1-rollback', db)
  let saveCalls = 0
  const trackedStore = new SessionStore('tx1-rollback', db, {
    onSaved: () => {
      saveCalls++
    },
  })
  const registry = new ToolRegistry(cwd)
  let transformCount = 0
  registry.register({
    name: 'xform',
    description: 'transforms input once',
    replay: 'safe',
    inputSchema: z.object({
      n: z.string().transform((v) => {
        transformCount++
        return Number(v)
      }),
    }),
    execute: async (input: { n: number }) => `num:${input.n}`,
  })
  registry.register({
    name: 'bad_approval',
    description: 'bad approval',
    inputSchema: z.object({}),
    execute: async () => 'should not run',
  })

  // R1 #5: force SQLite failure mid-TX1 after store.appendMessage already mutated memory
  expect(() =>
    persistAssistantStepTx({
      db,
      store: trackedStore,
      registry,
      sessionId: 'tx1-rollback',
      runId: 'missing-run-id',
      producer: 'mock/model',
      assistant: {
        role: 'assistant',
        content: [{ type: 'text', text: 'nope' }],
      },
      responseMessages: [],
      clientCalls: [
        { type: 'tool_call', toolCallId: 'dup', toolName: 'xform', input: {} },
        { type: 'tool_call', toolCallId: 'dup', toolName: 'xform', input: {} },
      ],
      stepRecord: {
        ts: Date.now(),
        model: 'mock/model',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      rawUsage: {
        inputTokens: 1,
        outputTokens: 1,
      },
    }),
  ).toThrow()
  expect(trackedStore.getEntries()).toHaveLength(0)
  expect(trackedStore.getLeafId()).toBeNull()
  expect(saveCalls).toBe(0)

  // R1 #11: Zod .transform() executes once cleanly through provider + executor
  const vela = createVela({
    cwd,
    dataDir: cwd,
    db,
    extensions: [
      function xformExt(api: ExtensionAPI) {
        api.registerTool({
          name: 'doubler',
          description: 'parse numeric string once',
          inputSchema: z.object({
            val: z.string().transform((s) => {
              transformCount++
              return Number(s) * 2
            }),
          }),
          execute: async ({ val }: { val: number }) => `got:${val}`,
        })
      },
    ],
    model: createFauxModel({
      responses: [
        fauxToolCall('xformExt_doubler', { val: '21' }),
        fauxText('done'),
      ],
    }),
  })
  const s = vela.session('xform-sess')
  await s.prompt('double 21')
  expect(transformCount).toBe(1)
  expect(JSON.stringify(s.messages)).toContain('got:42')

  // R1 #3 malformed approval object & R1 #4 disabled safe-replay row
  const velaBad = createVela({
    cwd,
    dataDir: cwd,
    db,
    extensions: [
      function badExt(api: ExtensionAPI) {
        api.registerTool({
          name: 'blocked',
          description: 'blocked',
          inputSchema: z.object({}),
          execute: async () => 'ran',
        })
        api.on('tool_call', () => ({
          approval: 'bad' as unknown as { summary: string },
        }))
      },
    ],
    model: createFauxModel({
      responses: [
        fauxToolCall('badExt_blocked', {}),
        fauxText('after bad approval'),
      ],
    }),
  })
  const sBad = velaBad.session('bad-app')
  await sBad.prompt('try bad')
  expect(JSON.stringify(sBad.messages)).toContain('invalid approval request')

  // R1 #4 & R1 #1 TX2a concurrency conflict check via executeStepCalls
  store.ensureSessionRow()
  const now = new Date().toISOString()
  db.run(
    "INSERT INTO runs (id, session_id, driver, trigger, status, started_at, updated_at) VALUES ('r-c', 'tx1-rollback', 'vela', 'user', 'running', ?, ?)",
    now,
    now,
  )
  const msgEntry = store.appendMessage({
    role: 'assistant',
    content: [
      {
        type: 'tool_call',
        toolCallId: 'call-safe',
        toolName: 'xform',
        input: { n: '5' },
      },
    ],
  })
  db.run(
    `INSERT INTO vela_tool_calls (id, session_id, run_id, assistant_message_id, tool_call_id, call_index, tool_name, input_json, execution_mode, replay, status, attempt, is_error, created_at, updated_at)
     VALUES ('tc-safe', 'tx1-rollback', 'r-c', ?, 'call-safe', 0, 'xform', '{"n":"5"}', 'parallel', 'safe', 'running', 1, 0, ?, ?)`,
    msgEntry.id,
    now,
    now,
  )
  // Simulate TX2a concurrency conflict: pass stale attempt = 0 while DB has attempt = 1
  const staleRow = {
    ...db.get<Record<string, unknown>>(
      'SELECT * FROM vela_tool_calls WHERE id = ?',
      'tc-safe',
    )!,
    attempt: 0,
  }
  await expect(
    executeStepCalls({
      db,
      store,
      registry,
      sessionId: 'tx1-rollback',
      rows: [staleRow as unknown as never],
      emit: () => {},
      isRecovery: true,
    }),
  ).rejects.toThrow(/changed concurrently/i)

  // R1 #4: disabling tool fails safe-replay row precheck instead of running it
  registry.setSelection([])
  const realRows = loadStepToolCallRows(db, 'tx1-rollback', msgEntry.id)
  await executeStepCalls({
    db,
    store,
    registry,
    sessionId: 'tx1-rollback',
    rows: realRows,
    emit: () => {},
    isRecovery: true,
  })
  expect(realRows[0]!.status).toBe('failed')
  expect(realRows[0]!.preview).toContain('not enabled')

  await vela.dispose()
  await velaBad.dispose()
  db.close()
})

test('R1 #8/#18/#19: hosted+client filter, discovery order + prompt exclusion + tool_search guidelines, public exports', async () => {
  expect(SpilledToolOutput).toBe(ExtSpilledToolOutput)
  const spilled = new SpilledToolOutput('/tmp/out.txt', 100, 'preview', {
    isError: false,
  })
  expect(spilled.path).toBe('/tmp/out.txt')
  const _typesOk: [
    ApprovalDecision?,
    PendingApprovalInfo?,
    ResolvedApprovalInfo?,
  ] = []
  expect(_typesOk).toEqual([])

  const cwd = setupDir()
  const model = createFauxModel({
    responses: [
      fauxToolCall('tool_search', { query: 'zebra' }),
      fauxToolCall('tool_search', { query: 'alpha' }),
      fauxText('all searched'),
    ],
  })
  function deferredWithRules(api: ExtensionAPI) {
    api.registerTool({
      name: 'alpha_tool',
      description: 'Alpha description line',
      promptSnippet: 'ALPHA_SNIPPET_ONLY_IN_SEARCH',
      promptGuidelines: ['ALPHA_GUIDELINE_DO_NOT_LEAK'],
      exposure: 'deferred',
      inputSchema: z.object({}),
      execute: async () => 'a',
    })
    api.registerTool({
      name: 'zebra_tool',
      description: 'Zebra description line',
      promptSnippet: 'ZEBRA_SNIPPET_ONLY_IN_SEARCH',
      promptGuidelines: ['ZEBRA_GUIDELINE_DO_NOT_LEAK'],
      exposure: 'deferred',
      inputSchema: z.object({}),
      execute: async () => 'z',
    })
  }
  const vela = createVela({
    cwd,
    dataDir: cwd,
    model,
    extensions: [deferredWithRules],
  })
  created.vela = vela
  const session = vela.session('cache-order')
  await session.prompt('search zebra then alpha')

  // R1 #18: system prompt excludes deferred snippets & guidelines across searches
  for (const call of model.calls) {
    expect(call.system).not.toContain('ALPHA_SNIPPET_ONLY_IN_SEARCH')
    expect(call.system).not.toContain('ALPHA_GUIDELINE_DO_NOT_LEAK')
    expect(call.system).not.toContain('ZEBRA_SNIPPET_ONLY_IN_SEARCH')
    expect(call.system).not.toContain('ZEBRA_GUIDELINE_DO_NOT_LEAK')
  }
  expect(model.calls[1]!.system).toBe(model.calls[0]!.system)
  expect(model.calls[2]!.system).toBe(model.calls[0]!.system)

  // tool_search returns snippets + guidelines in tool result
  expect(String(model.calls[1]!.toolResults[0]!.output)).toContain(
    'ZEBRA_GUIDELINE_DO_NOT_LEAK',
  )
  // Discovered tools appended in discovery order (zebra first, then alpha at end)
  const call2Tools = model.calls[2]!.tools
  expect(call2Tools.slice(-2)).toEqual([
    'deferredWithRules_zebra_tool',
    'deferredWithRules_alpha_tool',
  ])

  // R1 #8: hosted + client mix filters client ids out of hosted messages and preserves all step tool rows
  const db = openDatabase({ path: join(cwd, 'mix.db') })
  const mixStore = new SessionStore('mix-step', db)
  const mixRegistry = new ToolRegistry(cwd)
  mixRegistry.register({
    name: 'client_ok',
    description: 'ok',
    inputSchema: z.object({}),
    execute: async () => 'client-result',
  })
  mixStore.ensureSessionRow()
  const now = new Date().toISOString()
  db.run(
    "INSERT INTO runs (id, session_id, driver, trigger, status, started_at, updated_at) VALUES ('r-mix', 'mix-step', 'vela', 'user', 'running', ?, ?)",
    now,
    now,
  )
  const { entry: stepEntry } = persistAssistantStepTx({
    db,
    store: mixStore,
    registry: mixRegistry,
    sessionId: 'mix-step',
    runId: 'r-mix',
    producer: 'mock/model',
    assistant: {
      role: 'assistant',
      content: [
        {
          type: 'tool_call',
          toolCallId: 'hosted-1',
          toolName: 'web_search',
          providerExecuted: true,
          input: {},
        },
        {
          type: 'tool_call',
          toolCallId: 'client-1',
          toolName: 'client_ok',
          input: {},
        },
        {
          type: 'tool_call',
          toolCallId: 'client-sdk-err',
          toolName: 'client_ok',
          input: {},
        },
      ],
    },
    responseMessages: [
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'hosted-1',
            toolName: 'web_search',
            providerExecuted: true,
            output: { type: 'text', value: 'hosted-res' },
          },
          {
            type: 'tool_result',
            toolCallId: 'client-sdk-err',
            toolName: 'client_ok',
            output: { type: 'error-text', value: 'sdk bad args' },
          },
        ],
      },
    ],
    clientCalls: [
      {
        type: 'tool_call',
        toolCallId: 'client-1',
        toolName: 'client_ok',
        input: {},
      },
      {
        type: 'tool_call',
        toolCallId: 'client-sdk-err',
        toolName: 'client_ok',
        input: {},
      },
    ],
    stepRecord: {
      ts: Date.now(),
      model: 'mock/model',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    rawUsage: {
      inputTokens: 1,
      outputTokens: 1,
    },
    sdkToolErrors: new Map([['client-sdk-err', 'sdk bad args']]),
  })
  const hostedSaved = mixStore
    .getEntries()
    .filter((e) => e.type === 'message' && e.message.role === 'tool')
  expect(hostedSaved).toHaveLength(1)
  expect(JSON.stringify(hostedSaved[0])).toContain('hosted-1')
  expect(JSON.stringify(hostedSaved[0])).not.toContain('client-sdk-err')
  const allStepRows = loadStepToolCallRows(db, 'mix-step', stepEntry.id)
  expect(allStepRows.map((r) => [r.tool_call_id, r.status])).toEqual([
    ['client-1', 'pending'],
    ['client-sdk-err', 'failed'],
  ])
  db.close()
})

test('R2 #1/#2: pre-mutation session claim blocks concurrent instances, rejects live PID owners, and recovers dead-owner running sessions on ordinary prompt()', async () => {
  const cwd = setupDir()
  const dbPath = join(cwd, 'vela.db')
  const db = openDatabase({ path: dbPath })

  let releaseHook!: () => void
  let insideHook!: () => void
  const enteredHook = new Promise<void>((resolve) => {
    insideHook = resolve
  })
  function hookExt(api: ExtensionAPI) {
    api.on('before_agent_start', async () => {
      insideHook()
      await new Promise<void>((resolve) => {
        releaseHook = resolve
      })
    })
  }
  const vela1 = createVela({
    cwd,
    dataDir: cwd,
    db,
    model: createFauxModel({ responses: [fauxText('first done')] }),
    extensions: [hookExt],
  })
  const vela1B = createVela({
    cwd,
    dataDir: cwd,
    db,
    model: createFauxModel({ responses: [fauxText('never')] }),
  })
  const s1 = vela1.session('claim-order')
  const p1 = s1.prompt('hello one')
  await enteredHook

  const s1Again = vela1B.session('claim-order')
  await s1Again.resume()
  await expect(s1Again.prompt('second before loop')).rejects.toThrow(
    /already has an active run/i,
  )
  releaseHook()
  await p1
  await vela1B.dispose()
  await vela1.dispose()

  // Live external PID owner_token rejects prompt(); dead PID owner_token recovers even on ordinary prompt().
  const now = new Date().toISOString()
  db.run(
    "UPDATE sessions SET state = 'running', updated_at = ? WHERE id = 'claim-order'",
    now,
  )
  db.run(
    `INSERT INTO runs (id, session_id, driver, trigger, status, model, owner_token, started_at, updated_at)
     VALUES ('live-ext-run', 'claim-order', 'vela', 'user', 'running', 'mock/model', ?, ?, ?)`,
    `other-proc:${process.pid}:nonce-1`,
    now,
    now,
  )
  const vela2 = createVela({
    cwd,
    dataDir: cwd,
    db,
    model: createFauxModel({ responses: [fauxText('reclaimed ok')] }),
  })
  const resumedLive = vela2.session('claim-order')
  await resumedLive.resume()
  await expect(resumedLive.prompt('blocked by live pid')).rejects.toThrow(
    /already has an active run/i,
  )

  db.run(
    "UPDATE runs SET owner_token = 'other-proc:99999999:dead' WHERE id = 'live-ext-run'",
  )
  await resumedLive.prompt('recovered after dead crash')
  const deadRun = db.get<{ status: string }>(
    "SELECT status FROM runs WHERE id = 'live-ext-run'",
  )
  expect(deadRun?.status).toBe('interrupted')
  expect(
    db.get<{ state: string }>(
      "SELECT state FROM sessions WHERE id = 'claim-order'",
    )?.state,
  ).toBe('idle')

  await vela2.dispose()
  db.close()
})

test('R2 #3/#4: queued bash/custom_message wait until post-recovery tool result and append rolls back atomically on SQLite failure', async () => {
  const cwd = setupDir()
  const db = openDatabase({ path: join(cwd, 'vela.db') })
  const store = new SessionStore('rollback-test', db)
  const msg1 = { role: 'user' as const, content: 'ok' }
  store.appendMessage(msg1)
  db.close()
  expect(() =>
    store.appendMessage({ role: 'user', content: 'should fail' }),
  ).toThrow()
  expect(store.getEntries()).toHaveLength(1)

  const dbPath = join(cwd, 'recovery-order.db')
  const rdb = openDatabase({ path: dbPath })
  function r2order(api: ExtensionAPI) {
    api.registerTool({
      name: 'gated_echo',
      description: 'requires approval',
      inputSchema: z.object({ v: z.string() }),
      execute: async ({ v }) => `echo:${v}`,
    })
    api.on('tool_call', async (ev) => {
      if (ev.toolName === 'r2order_gated_echo') {
        return { approval: { summary: 'Confirm echo' } }
      }
    })
  }
  const vela = createVela({
    cwd,
    dataDir: cwd,
    db: rdb,
    extensions: [r2order],
    model: createFauxModel({
      responses: [
        fauxToolCall('r2order_gated_echo', { v: 'ok' }),
        fauxText('all ordered'),
      ],
    }),
  })
  created.vela = vela
  const s = vela.session('rec-order')
  await s.prompt('run gated tool')
  const [ap] = s.pendingApprovals()
  s.resolveApproval(ap!.id, { approved: true })
  await s.executeBash('echo queued-before-resume')
  await s.continueInterrupted()

  const roles = s.messages.map((m) => m.role)
  const asstIdx = roles.indexOf('assistant')
  const toolIdx = roles.indexOf('tool')
  const userAfterIdx = roles.lastIndexOf('user')
  expect(toolIdx).toBe(asstIdx + 1)
  expect(userAfterIdx).toBeGreaterThan(toolIdx)
  expect(JSON.stringify(s.messages[userAfterIdx])).toContain(
    'queued-before-resume',
  )
  await vela.dispose()
  rdb.close()
})

test('R2 #5/#6/#7/#8/#11/#14: TX1 terminalError, Promise.allSettled + waitForIdle, tool_call_row_id binding, hidden guard, single schema transform, and empty takeDetails', async () => {
  const cwd = setupDir()
  const db = openDatabase({ path: join(cwd, 'vela.db') })

  // #5: persistAssistantStepTx marks terminalError client calls directly as failed
  const store5 = new SessionStore('tx1-term', db)
  store5.appendMessage({ role: 'user', content: 'go' })
  const now = new Date().toISOString()
  db.run(
    "INSERT INTO runs (id, session_id, driver, trigger, status, started_at, updated_at) VALUES ('r-term', 'tx1-term', 'vela', 'user', 'running', ?, ?)",
    now,
    now,
  )
  const { entry: termEntry } = persistAssistantStepTx({
    db,
    store: store5,
    registry: new ToolRegistry(),
    sessionId: 'tx1-term',
    runId: 'r-term',
    producer: 'mock/model',
    assistant: {
      role: 'assistant',
      content: [
        {
          type: 'tool_call',
          toolCallId: 'tc-len',
          toolName: 'bash',
          input: {},
        },
      ],
    },
    responseMessages: [],
    clientCalls: [
      { type: 'tool_call', toolCallId: 'tc-len', toolName: 'bash', input: {} },
    ],
    stepRecord: {
      ts: Date.now(),
      model: 'mock/model',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    rawUsage: { inputTokens: 1, outputTokens: 1 },
    terminalError: (name) => `truncated:${name}`,
  })
  const termRows = loadStepToolCallRows(db, 'tx1-term', termEntry.id)
  expect(termRows[0]!.status).toBe('failed')
  expect(termRows[0]!.preview).toBe('truncated:bash')

  // #7: duplicate tool_call_id across steps isolates approval resolution by tool_call_row_id
  const store7 = new SessionStore('dup-ap', db)
  store7.appendMessage({ role: 'user', content: 'two steps' })
  db.run(
    "INSERT INTO runs (id, session_id, driver, trigger, status, started_at, updated_at) VALUES ('r-dup', 'dup-ap', 'vela', 'user', 'waiting_human', ?, ?)",
    now,
    now,
  )
  const eA = store7.appendMessage({
    role: 'assistant',
    content: [
      {
        type: 'tool_call',
        toolCallId: 'dup-1',
        toolName: 'hidden_or_safe',
        input: {},
      },
    ],
  })
  const eB = store7.appendMessage({
    role: 'assistant',
    content: [
      {
        type: 'tool_call',
        toolCallId: 'dup-1',
        toolName: 'hidden_or_safe',
        input: {},
      },
    ],
  })
  db.run(
    `INSERT INTO vela_tool_calls (id, session_id, run_id, assistant_message_id, tool_call_id, call_index, tool_name, input_json, execution_mode, replay, status, attempt, created_at, updated_at)
     VALUES ('row-a', 'dup-ap', 'r-dup', ?, 'dup-1', 0, 'hidden_or_safe', '{}', 'parallel', 'none', 'awaiting_approval', 0, ?, ?),
            ('row-b', 'dup-ap', 'r-dup', ?, 'dup-1', 0, 'hidden_or_safe', '{}', 'parallel', 'none', 'awaiting_approval', 0, ?, ?)`,
    eA.id,
    now,
    now,
    eB.id,
    now,
    now,
  )
  db.run(
    `INSERT INTO approvals (id, session_id, run_id, tool_call_row_id, tool_call_id, tool_name, summary, status, created_at)
     VALUES ('ap-a', 'dup-ap', 'r-dup', 'row-a', 'dup-1', 'hidden_or_safe', 'A', 'pending', ?),
            ('ap-b', 'dup-ap', 'r-dup', 'row-b', 'dup-1', 'hidden_or_safe', 'B', 'pending', ?)`,
    now,
    now,
  )
  let transformCount = 0
  let siblingSettled = false
  const events: string[] = []

  function r2probe(api: ExtensionAPI) {
    api.registerTool({
      name: 'hidden_safe',
      description: 'hidden safe tool',
      exposure: 'hidden',
      replay: 'safe',
      inputSchema: z.object({}),
      execute: async () => 'should not run',
    })
    api.registerTool({
      name: 'count_transform',
      description: 'counts transforms and emits details',
      inputSchema: z.object({
        n: z.number().transform((v) => {
          transformCount++
          return v * 2
        }),
      }),
      execute: async ({ n }) =>
        new ToolExecutionResult({ diff: 'ok' }, `val=${n}`),
    })
    api.registerTool({
      name: 'parallel_slow',
      description: 'slow parallel sibling',
      executionMode: 'parallel',
      inputSchema: z.object({}),
      execute: async () => {
        await Bun.sleep(25)
        siblingSettled = true
        return 'sibling ok'
      },
    })
    api.registerTool({
      name: 'parallel_fast',
      description: 'fast parallel sibling',
      executionMode: 'parallel',
      inputSchema: z.object({}),
      execute: async () => 'ok',
    })
  }
  const vela = createVela({
    cwd,
    dataDir: cwd,
    db,
    extensions: [r2probe],
    model: createFauxModel({
      responses: [
        fauxToolCall('r2probe_count_transform', { n: 5 }),
        fauxText('done-1'),
        fauxToolCall('r2probe_hidden_safe', {}),
        fauxText('done-2'),
      ],
    }),
  })
  created.vela = vela
  const sess = vela.session('r2-tools')
  sess.subscribe((ev) => {
    if (ev.type === 'tool_execution_end')
      events.push(`${ev.toolName}:${Boolean(ev.details)}`)
  })
  const { resolveApproval } = await import('../../src/driver/step-recovery.ts')
  resolveApproval(db, 'dup-ap', 'ap-b', { approved: true })
  expect(
    db.get<{ status: string }>(
      "SELECT status FROM vela_tool_calls WHERE id = 'row-a'",
    )?.status,
  ).toBe('awaiting_approval')
  expect(
    db.get<{ status: string }>(
      "SELECT status FROM vela_tool_calls WHERE id = 'row-b'",
    )?.status,
  ).toBe('pending')

  // #11 & #14: single schema transform + no leftover registry.takeDetails
  await sess.prompt('transform')
  expect(transformCount).toBe(1)
  expect(sess.registry.takeDetails('faux-call-1-1')).toBeUndefined()
  expect(events).toContain('r2probe_count_transform:true')

  // #8: hidden tool rejected in live call & safe replay
  await sess.prompt('call hidden')
  const hiddenCall = db.get<{
    id: string
    assistant_message_id: string
    status: string
    preview: string | null
  }>(
    "SELECT id, assistant_message_id, status, preview FROM vela_tool_calls WHERE session_id = 'r2-tools' AND tool_name = 'r2probe_hidden_safe'",
  )!
  expect(hiddenCall.status).toBe('failed')
  expect(hiddenCall.preview).toContain('unavailable')

  // #6: Promise.allSettled waits for parallel sibling before rejecting & registry.waitForIdle() settles
  const reg6 = sess.registry.fork(undefined)
  reg6.setInterception({
    after: async (name) => {
      if (name === 'r2probe_parallel_fast') throw new Error('boom-after')
      return 'sibling ok'
    },
  })
  const store6 = new SessionStore('p-settle', db)
  store6.appendMessage({ role: 'user', content: 'parallel' })
  db.run(
    "INSERT INTO runs (id, session_id, driver, trigger, status, started_at, updated_at) VALUES ('r-p6', 'p-settle', 'vela', 'user', 'running', ?, ?)",
    now,
    now,
  )
  const asst6 = store6.appendMessage({
    role: 'assistant',
    content: [
      {
        type: 'tool_call',
        toolCallId: 'ps-1',
        toolName: 'r2probe_parallel_slow',
        input: {},
      },
      {
        type: 'tool_call',
        toolCallId: 'ps-2',
        toolName: 'r2probe_parallel_fast',
        input: {},
      },
    ],
  })
  db.run(
    `INSERT INTO vela_tool_calls (id, session_id, run_id, assistant_message_id, tool_call_id, call_index, tool_name, input_json, execution_mode, replay, status, attempt, created_at, updated_at)
     VALUES ('p6-1', 'p-settle', 'r-p6', ?, 'ps-1', 0, 'r2probe_parallel_slow', '{}', 'parallel', 'none', 'pending', 0, ?, ?),
            ('p6-2', 'p-settle', 'r-p6', ?, 'ps-2', 1, 'r2probe_parallel_fast', '{}', 'parallel', 'none', 'pending', 0, ?, ?)`,
    asst6.id,
    now,
    now,
    asst6.id,
    now,
    now,
  )
  await expect(
    executeStepCalls({
      db,
      store: store6,
      registry: reg6,
      sessionId: 'p-settle',
      rows: loadStepToolCallRows(db, 'p-settle', asst6.id),
      emit: () => {},
    }),
  ).rejects.toThrow('boom-after')
  expect(siblingSettled).toBe(true)
  expect(reg6.hasActiveCalls).toBe(false)

  // Verify hidden tool is also rejected during executeStepCalls recovery replay
  db.run(
    "UPDATE vela_tool_calls SET status = 'running', replay = 'safe' WHERE id = ?",
    hiddenCall.id,
  )
  await executeStepCalls({
    db,
    store: new SessionStore('r2-tools', db),
    registry: sess.registry,
    sessionId: 'r2-tools',
    rows: loadStepToolCallRows(db, 'r2-tools', hiddenCall.assistant_message_id),
    emit: () => {},
    isRecovery: true,
  })
  expect(
    db.get<{ status: string }>(
      'SELECT status FROM vela_tool_calls WHERE id = ?',
      hiddenCall.id,
    )?.status,
  ).toBe('failed')

  await vela.dispose()
  db.close()
})
