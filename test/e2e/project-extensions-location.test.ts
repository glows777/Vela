import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
  tempDir,
} from '@glows777/vela/testing'
import {
  cliHostExtensionConfig,
  cliProjectExtensions,
} from '../../packages/vela/src/cli/project-extensions.ts'
import {
  loadCliExtensions,
  parseArgs,
} from '../../packages/vela/src/cli/setup.ts'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import { inspectSession } from '../../packages/vela/src/driver/diagnostics.ts'
import {
  createLocalExecutionEnv,
  loadConfig,
  type VelaOptions,
} from '../../packages/vela/src/driver/index.ts'
import { loadConfig as loadCliConfig } from '../../packages/vela/src/load-config.ts'

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

test('a project channel registration is diagnosed without creating a host channel', async () => {
  const t = setup()
  try {
    writeFileSync(
      join(t.a, '.vela/projectProbe.ts'),
      `export default function projectProbe(api) { api.registerChannel({name:'projectChannel',description:'Must not become a host listener',onMessage(){},send:async()=>{}}) }`,
    )
    t.model.push(fauxText('done'))
    await t.vela.session('a').prompt('hello')
    expect(t.reports.join('\n')).toMatch(/channel.*host|host.*channel/i)
    expect(t.vela.channels()).toEqual([])
    await t.vela.startChannels()
    expect(t.vela.runningChannels()).toEqual([])
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

test('CLI memory and RAG stay host-owned across two projects and project idle closes', async () => {
  const dir = tempDir()
  const aDir = join(dir.path, 'A')
  const bDir = join(dir.path, 'B')
  const args = parseArgs(['serve'])
  const agentDir = join(dir.path, 'user')
  mkdirSync(agentDir)
  writeFileSync(
    join(agentDir, 'config.json'),
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
  const config = loadCliConfig({
    cwd: aDir,
    agentDir,
    trusted: true,
    env: {},
    builtins: ['memory'],
  })
  const host = await loadCliExtensions(config, args, () => {}, true)
  const extensionConfig = cliHostExtensionConfig(config, args)
  const select = cliProjectExtensions(config, args)
  const projectFactories: string[] = []
  const vela = createVela({
    cwd: aDir,
    dataDir: join(dir.path, 'host'),
    model: createFauxModel({
      responses: [fauxText('A'), fauxText('B'), fauxText('B again')],
    }),
    extensions: host,
    extensionConfig,
    sessionResources: {
      ...config.sessionResources!,
      workspaceModeAt: () => 'all',
      projectExtensions: async (input) => {
        const selected = await select(input)
        return {
          ...selected,
          load: async () => {
            const factories = await selected.load()
            projectFactories.push(...factories.map((factory) => factory.name))
            return factories
          },
        }
      },
    },
  })
  try {
    const a = vela.session('a')
    const b = vela.session('b', { cwd: bDir })
    await a.prompt('A')
    await b.prompt('B')
    await a.close()
    await b.prompt('B remains active')
    expect(projectFactories).toEqual([])
    expect(host.map((factory) => factory.name)).toEqual(['memory'])
    expect(b.getActiveTools()).toContain('memory')
    expect(extensionConfig.memory).toEqual({ dream: false })
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
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
