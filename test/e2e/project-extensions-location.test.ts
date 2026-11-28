import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRuntime } from '@glows777/vela'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
  tempDir,
} from '@glows777/vela/testing'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import { inspectSession } from '../../packages/vela/src/driver/diagnostics.ts'
import {
  createLocalExecutionEnv,
  loadConfig,
  type VelaOptions,
} from '../../packages/vela/src/driver/index.ts'
import { createVela } from '../support/compat-vela.ts'

interface Record {
  kind: string
  label: string
  version?: number
  session?: string
  cwd?: string
}
function setup(
  denied = false,
  host: Pick<VelaOptions, 'env' | 'db' | 'ephemeralSessions'> = {},
) {
  const dir = tempDir()
  const a = join(dir.path, 'A'),
    b = join(dir.path, 'B'),
    agentDir = join(dir.path, 'user'),
    ledger = join(dir.path, 'ledger.jsonl')
  mkdirSync(agentDir)
  const settings = (cwd: string, version: number) =>
    writeFileSync(
      join(cwd, '.vela/config.json'),
      JSON.stringify({
        extensions: ['./projectProbe.ts'],
        extensionConfig: { projectProbe: { version } },
      }),
    )
  for (const [cwd, label] of [
    [a, 'A'],
    [b, 'B'],
  ] as const) {
    mkdirSync(join(cwd, '.vela'), { recursive: true })
    writeFileSync(
      join(cwd, '.vela/projectProbe.ts'),
      `
import { appendFileSync } from 'node:fs'
import { z } from ${JSON.stringify(import.meta.resolve('zod'))}
const label = ${JSON.stringify(label)}
const record = (kind, extra = {}) => appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({kind, label, ...extra}) + '\\n')
record('import')
export default function projectProbe(api) {
  const version = api.config.version
  record('factory', {version, cwd: api.cwd})
  api.onShutdown(() => record('dispose', {version}))
  api.on('session_start', (_event, ctx) => record('session_start', {version, session: ctx.session.id}))
  api.on('session_shutdown', (_event, ctx) => record('session_shutdown', {version, session: ctx.session.id}))
  api.on('before_agent_start', (event, ctx) => { record('hook', {version, session: ctx.session.id, cwd: ctx.cwd}); event.sections.project = label + '_VERSION_' + version })
  api.registerTool({name:'who', description: label + ' project tool', inputSchema:z.object({}), execute:async () => { record('tool', {version}); return label + '_TOOL_' + version }})
  api.registerCommand('where', {description: label + ' command', handler:(_args, ctx) => record('command', {version, session:ctx.session.id, cwd:ctx.cwd})})
}
`,
    )
    settings(cwd, 1)
  }
  const read = (): Record[] =>
    existsSync(ledger)
      ? readFileSync(ledger, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
  const config = loadConfig({ cwd: a, agentDir, trusted: true, env: {} })
  const model = createFauxModel({ responses: [] })
  const reports: string[] = []
  const hostSeen: { session: string; cwd: string }[] = []
  const vela = createVela({
    cwd: a,
    ...host,
    logger: {
      debug: () => {},
      info: (message) => reports.push(message),
      warn: (message) => reports.push(message),
      error: (message) => reports.push(message),
    },
    dataDir: join(dir.path, 'data'),
    model,
    sessionResources: {
      ...config.sessionResources!,
      workspaceModeAt: (cwd) => (denied && cwd === b ? 'none' : 'all'),
    },
    extensions: [
      function hostObserver(api) {
        api.on('before_agent_start', (_event, ctx) => {
          hostSeen.push({ session: ctx.session.id, cwd: ctx.cwd })
        })
      },
    ],
  })
  return { dir, a, b, model, vela, read, settings, hostSeen, reports }
}

test('same-named project tools and commands stay in A or B, with an unchanged A request prefix after B', async () => {
  const t = setup()
  try {
    t.model.push(
      fauxToolCall('projectProbe_who', {}),
      fauxText('A done'),
      fauxToolCall('projectProbe_who', {}),
      fauxText('B done'),
      fauxText('A again'),
    )
    const a = t.vela.session('a'),
      b = t.vela.session('b', { cwd: t.b })
    await a.prompt('run the project tool')
    expect(
      t
        .read()
        .filter((e) => e.kind === 'tool')
        .map((e) => e.label),
    ).toEqual(['A'])
    await a.prompt('/where')
    await b.prompt('run the project tool')
    await b.prompt('/where')
    await a.prompt('continue A')
    expect(
      t
        .read()
        .filter((e) => e.kind === 'tool')
        .map((e) => e.label),
    ).toEqual(['A', 'B'])
    expect(
      t
        .read()
        .filter((e) => e.kind === 'command')
        .map((e) => [e.label, e.session, e.cwd]),
    ).toEqual([
      ['A', 'a', t.a],
      ['B', 'b', t.b],
    ])
    expect(
      t.model.calls[1]!.toolResults.map((r) => r.output).join(' '),
    ).toContain('A_TOOL_1')
    expect(
      t.model.calls[3]!.toolResults.map((r) => r.output).join(' '),
    ).toContain('B_TOOL_1')
    expect(t.model.calls[4]!.system).toBe(t.model.calls[0]!.system)
    expect(JSON.stringify(t.model.calls[4]!.tools)).toBe(
      JSON.stringify(t.model.calls[0]!.tools),
    )
    expect(
      t
        .read()
        .filter((e) => e.kind === 'hook' && e.session === 'b')
        .every((e) => e.label === 'B'),
    ).toBe(true)
  } finally {
    await t.vela.dispose()
    t.dir.cleanup()
  }
})

test('a host extension receives B as ctx.cwd when it handles a B session', async () => {
  const t = setup()
  try {
    t.model.push(fauxText('done'))
    await t.vela.session('b', { cwd: t.b }).prompt('hello')
    expect(t.hostSeen).toEqual([{ session: 'b', cwd: t.b }])
  } finally {
    await t.vela.dispose()
    t.dir.cleanup()
  }
})

test('denied B imports no project code and inherits no A registration', async () => {
  const t = setup(true)
  try {
    t.model.push(fauxText('A'), fauxText('B'))
    await t.vela.session('a').prompt('hello')
    await t.vela.session('b', { cwd: t.b }).prompt('hello')
    expect(
      t
        .read()
        .filter((e) => e.kind === 'import')
        .map((e) => e.label),
    ).toEqual(['A'])
    expect(t.read().filter((e) => e.session === 'b')).toEqual([])
    expect(t.model.calls[1]!.tools).not.toContain('projectProbe_who')
  } finally {
    await t.vela.dispose()
    t.dir.cleanup()
  }
})

test('same-location sessions share a project instance until its last session closes', async () => {
  const t = setup()
  try {
    t.model.push(fauxText('one'), fauxText('two'))
    const a1 = t.vela.session('a1'),
      a2 = t.vela.session('a2')
    await a1.prompt('hello')
    await a2.prompt('hello')
    expect(t.read().filter((e) => e.kind === 'factory')).toEqual([
      { kind: 'factory', label: 'A', version: 1, cwd: t.a },
    ])
    await a1.close()
    expect(t.read().filter((e) => e.kind === 'dispose')).toHaveLength(0)
    await a2.close()
    expect(t.read().filter((e) => e.kind === 'dispose')).toEqual([
      { kind: 'dispose', label: 'A', version: 1 },
    ])
    await t.vela.dispose()
    expect(t.read().filter((e) => e.kind === 'dispose')).toHaveLength(1)
  } finally {
    await t.vela.dispose()
    t.dir.cleanup()
  }
})

test('edited project config gives a new session a new instance without mutating the old snapshot', async () => {
  const t = setup()
  try {
    t.model.push(fauxText('old'), fauxText('new'))
    const old = t.vela.session('old')
    await old.prompt('hello')
    t.settings(t.a, 2)
    const fresh = t.vela.session('fresh')
    await fresh.prompt('hello')
    expect(
      t
        .read()
        .filter((e) => e.kind === 'factory')
        .map((e) => e.version),
    ).toEqual([1, 2])
    await old.prompt('/where')
    await fresh.prompt('/where')
    expect(
      t
        .read()
        .filter((e) => e.kind === 'factory')
        .map((e) => e.version),
    ).toEqual([1, 2])
    expect(
      t
        .read()
        .filter((e) => e.kind === 'command')
        .map((e) => [e.session, e.version]),
    ).toEqual([
      ['old', 1],
      ['fresh', 2],
    ])
    await old.close()
    await fresh.close()
    await t.vela.dispose()
    expect(
      t
        .read()
        .filter((e) => e.kind === 'dispose')
        .map((e) => e.version)
        .sort(),
    ).toEqual([1, 2])
  } finally {
    await t.vela.dispose()
    t.dir.cleanup()
  }
})

test('a project provider registration is diagnosed rather than added to host identity', async () => {
  const t = setup()
  try {
    writeFileSync(
      join(t.a, '.vela/projectProbe.ts'),
      `export default function projectProbe(api) { api.registerProvider('projectForbidden', { models: [{id:'test',contextWindow:32000}], createModel() { throw new Error('Project provider must not run') } }) }`,
    )
    t.model.push(fauxText('done'))
    const session = t.vela.session('a')
    await session.prompt('hello')
    expect(t.reports.join('\n')).toMatch(/provider/i)
    expect(
      t.vela
        .models({ all: true })
        .some((model) => model.ref === 'projectForbidden/test'),
    ).toBe(false)
    expect(() => session.setModel('projectForbidden/test')).toThrow()
  } finally {
    await t.vela.dispose()
    t.dir.cleanup()
  }
})

test('a failed async project factory disposes its resources once and does not break B', async () => {
  const t = setup()
  const ledger = join(t.dir.path, 'ledger.jsonl')
  try {
    writeFileSync(
      join(t.a, '.vela/projectProbe.ts'),
      `import {appendFileSync} from 'node:fs'; export default async function projectProbe(api) {
      api.onShutdown(() => appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({kind:'dispose',label:'A'})+'\\n'))
      await new Promise(resolve=>setTimeout(resolve,10)); throw new Error('A initialization failed')
    }`,
    )
    const failed = t.vela.session('failed')
    await expect(failed.resources()).rejects.toThrow('failed to prepare')
    expect(
      t.read().filter((e) => e.kind === 'dispose' && e.label === 'A'),
    ).toHaveLength(1)
    t.model.push(fauxText('B works'))
    await t.vela.session('b', { cwd: t.b }).prompt('hello')
    expect(t.model.calls).toHaveLength(1)
    expect(t.read().some((e) => e.kind === 'hook' && e.label === 'B')).toBe(
      true,
    )
    await failed.close()
    await t.vela.dispose()
    expect(
      t.read().filter((e) => e.kind === 'dispose' && e.label === 'A'),
    ).toHaveLength(1)
  } finally {
    await t.vela.dispose()
    t.dir.cleanup()
  }
})

test('closing while resources and inspection await a project factory cannot reuse its dead scope', async () => {
  const t = setup(),
    ledger = join(t.dir.path, 'ledger.jsonl'),
    gate = join(t.dir.path, 'factory-started'),
    release = join(t.dir.path, 'release-factory')
  try {
    writeFileSync(
      join(t.a, '.vela/projectProbe.ts'),
      `import {appendFileSync,writeFileSync,existsSync} from 'node:fs';let instance=0;export default async function projectProbe(api){
      const version=++instance; const record=kind=>appendFileSync(${JSON.stringify(ledger)},JSON.stringify({kind,label:'A',version})+'\\n');record('factory');api.onShutdown(()=>record('dispose'));
      writeFileSync(${JSON.stringify(gate)},'started');while(!existsSync(${JSON.stringify(release)})) await new Promise(resolve=>setTimeout(resolve,5));
      api.registerCommand('where',{handler:()=>record('command')})
    }`,
    )
    const old = t.vela.session('overlap')
    const resources = old.resources().then(
      () => 'resolved',
      () => 'rejected',
    )
    const inspected = inspectSession(t.vela, old).then(
      () => 'resolved',
      () => 'rejected',
    )
    const deadline = Date.now() + 5000
    while (!existsSync(gate)) {
      if (Date.now() > deadline) throw new Error('Factory did not start')
      await Bun.sleep(5)
    }
    const closing = old.close()
    writeFileSync(release, 'continue')
    await closing
    expect(await resources).toBe('rejected')
    expect(await inspected).toBe('rejected')
    expect(
      t
        .read()
        .filter((e) => e.kind === 'dispose')
        .map((e) => e.version),
    ).toEqual([1])
    const fresh = t.vela.session('overlap')
    await fresh.prompt('/where')
    expect(
      t
        .read()
        .filter((e) => e.kind === 'command')
        .map((e) => e.version),
    ).toEqual([2])
    await fresh.close()
    await t.vela.dispose()
    expect(
      t
        .read()
        .filter((e) => e.kind === 'dispose')
        .map((e) => e.version),
    ).toEqual([1, 2])
  } finally {
    writeFileSync(release, 'continue')
    await t.vela.dispose()
    t.dir.cleanup()
  }
})

test('a started A session restored to saved B shuts down A and starts B exactly once', async () => {
  const t = setup()
  try {
    t.model.push(fauxText('saved B'))
    const seed = t.vela.session('restore', { cwd: t.b })
    await seed.prompt('save in B')
    await seed.close()
    const offset = t.read().length
    const reopened = t.vela.session('restore', { cwd: t.a })
    await reopened.prompt('/where')
    expect(await reopened.resume()).toBe(true)
    await reopened.prompt('/where')
    await reopened.close()
    expect(
      t
        .read()
        .slice(offset)
        .filter(
          (e) => e.kind === 'session_start' || e.kind === 'session_shutdown',
        )
        .map((e) => [e.kind, e.label, e.session]),
    ).toEqual([
      ['session_start', 'A', 'restore'],
      ['session_shutdown', 'A', 'restore'],
      ['session_start', 'B', 'restore'],
      ['session_shutdown', 'B', 'restore'],
    ])
    expect(
      t
        .read()
        .slice(offset)
        .filter((e) => e.kind === 'command')
        .map((e) => [e.label, e.cwd]),
    ).toEqual([
      ['A', t.a],
      ['B', t.b],
    ])
  } finally {
    await t.vela.dispose()
    t.dir.cleanup()
  }
})

test('the first plain input loads its project input handler before contacting the model', async () => {
  const t = setup()
  try {
    for (const [cwd, label] of [
      [t.a, 'A'],
      [t.b, 'B'],
    ] as const)
      writeFileSync(
        join(cwd, '.vela/projectProbe.ts'),
        `export default function projectProbe(api) { api.on('input', event => ({action:'transform',text:${JSON.stringify(label)} + ':' + event.text})) }`,
      )
    t.model.push(fauxText('A'), fauxText('B'), fauxText('A again'))
    const a = t.vela.session('a')
    await a.prompt('first')
    await t.vela.session('b', { cwd: t.b }).prompt('first')
    await a.prompt('second')
    expect(t.model.calls.map((call) => call.lastUserText)).toEqual([
      'A:first',
      'B:first',
      'A:second',
    ])
  } finally {
    await t.vela.dispose()
    t.dir.cleanup()
  }
})

test('Runtime memory stays host-owned across two projects without loading project memory config', async () => {
  const dir = tempDir()
  const aDir = join(dir.path, 'A')
  const bDir = join(dir.path, 'B')
  const agentDir = join(dir.path, 'user')
  mkdirSync(agentDir)
  const ownerConfigPath = join(agentDir, 'config.json')
  writeFileSync(
    ownerConfigPath,
    JSON.stringify({
      memory: { dream: false },
    }),
  )
  for (const cwd of [aDir, bDir]) {
    mkdirSync(join(cwd, '.vela'), { recursive: true })
    writeFileSync(
      join(cwd, '.vela/config.json'),
      JSON.stringify({
        memory: { dream: true },
      }),
    )
  }
  const backdateDreamTurns = () => {
    const db = openDatabase({ path: join(agentDir, 'vela.db') })
    try {
      const staleTime = Date.now() - 3 * 24 * 3600_000
      const rows = db.all<{ key: string; value_json: string }>(
        "SELECT key, value_json FROM kv_meta WHERE key LIKE 'memory_dream:%'",
      )
      for (const row of rows) {
        const parsed = JSON.parse(row.value_json) as {
          pendingRefs?: Array<{ time?: number }>
        }
        if (Array.isArray(parsed.pendingRefs)) {
          for (const entry of parsed.pendingRefs) {
            entry.time = staleTime
          }
          db.run(
            'UPDATE kv_meta SET value_json = ? WHERE key = ?',
            JSON.stringify(parsed),
            row.key,
          )
        }
      }
    } finally {
      db.close()
    }
  }
  const countDreamRuns = (): number => {
    const db = openDatabase({ path: join(agentDir, 'vela.db') })
    try {
      const rows = db.all<{ value_json: string }>(
        "SELECT value_json FROM kv_meta WHERE key LIKE 'memory_dream:%'",
      )
      let runs = 0
      for (const row of rows) {
        const parsed = JSON.parse(row.value_json) as { lastRun?: unknown }
        if (parsed.lastRun) runs += 1
      }
      return runs
    } finally {
      db.close()
    }
  }

  const offModel = createFauxModel({
    responses: [fauxText('A'), fauxText('B'), fauxText('B again')],
  })
  const offRuntime = createRuntime({
    agentDir,
    defaultModel: offModel,
    hostEnv: {},
    mcp: false,
  })
  try {
    await offRuntime.ready()
    await offRuntime.trust.approve(aDir, true)
    await offRuntime.trust.approve(bDir, true)
    const a = await offRuntime.sessions.create({
      location: { environment: 'local', cwd: aDir },
    })
    const b = await offRuntime.sessions.create({
      location: { environment: 'local', cwd: bDir },
    })
    await offRuntime.prompt(a.id, { text: 'A' })
    await offRuntime.waitForIdle(a.id)
    await offRuntime.prompt(b.id, { text: 'B' })
    await offRuntime.waitForIdle(b.id)
    backdateDreamTurns()
    await offRuntime.prompt(b.id, { text: 'B remains active' })
    await offRuntime.waitForIdle(b.id)
    const inspectedB = await offRuntime.sessions.inspect(b.id)
    expect(inspectedB.activeTools).toContain('memory')
    expect(inspectedB.extensionErrors).toEqual([])
  } finally {
    await offRuntime.dispose()
  }
  expect(offModel.calls).toHaveLength(3)
  expect(countDreamRuns()).toBe(0)

  // Control: enabling memory.dream in the owner config causes the backdated turn to dream.
  writeFileSync(
    ownerConfigPath,
    JSON.stringify({
      memory: { dream: true },
    }),
  )
  const onModel = createFauxModel({
    responses: [
      fauxText('A enabled'),
      fauxText(JSON.stringify({ summary: 'Consolidated', actions: [] })),
    ],
  })
  const onRuntime = createRuntime({
    agentDir,
    defaultModel: onModel,
    hostEnv: {},
    mcp: false,
  })
  try {
    await onRuntime.ready()
    const a2 = await onRuntime.sessions.create({
      location: { environment: 'local', cwd: aDir },
    })
    await onRuntime.prompt(a2.id, { text: 'trigger dream check' })
    await onRuntime.waitForIdle(a2.id)
    for (let i = 0; i < 50 && onModel.calls.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
  } finally {
    await onRuntime.dispose()
    dir.cleanup()
  }
  expect(onModel.calls.length).toBeGreaterThanOrEqual(2)
})

test('preparing a same-cwd nonlocal target cannot inherit local project authority or prematurely replace its tools', async () => {
  const db = openDatabase({ path: ':memory:' })
  const t = setup(false, {
    db,
    env: ({ location }) => {
      const env = createLocalExecutionEnv({ cwd: location.cwd })
      if (location.environment !== 'local')
        Object.defineProperty(env, 'id', { value: 'fixture:guest' })
      return env
    },
  })
  try {
    const session = t.vela.session('scoped-move')
    const target = { environment: 'guest', cwd: t.a }
    t.model.push(
      fauxText('start'),
      fauxToolCall('projectProbe_who', {}),
      fauxText('old tool'),
      fauxText('moved'),
    )
    await session.prompt('source')
    db.exec(`
      CREATE TRIGGER refuse_location_update BEFORE UPDATE OF location_json ON sessions
      BEGIN
        SELECT RAISE(ABORT, 'write refused');
      END;
    `)
    await expect(session.setLocation(target)).rejects.toThrow('write refused')
    db.exec('DROP TRIGGER refuse_location_update;')
    await session.prompt('which project')
    expect(t.model.calls[2]!.toolResults[0]!.output).toContain('A_TOOL_1')
    expect(t.model.calls[2]!.system).toBe(t.model.calls[0]!.system)
    expect(t.read().filter((e) => e.kind === 'session_shutdown')).toHaveLength(
      0,
    )
    await session.setLocation(target)
    expect(session.getActiveTools()).not.toContain('projectProbe_who')
    expect(t.vela.commands(session.id).some((c) => c.name === 'where')).toBe(
      false,
    )
    await session.prompt('inspect guest')
    expect(t.model.calls[3]!.system).not.toContain('A_VERSION_1')
    expect(t.read().filter((e) => e.kind === 'factory')).toHaveLength(1)
    expect(t.read().filter((e) => e.kind === 'session_shutdown')).toHaveLength(
      1,
    )
  } finally {
    await t.vela.dispose()
    db.close()
    t.dir.cleanup()
  }
})
