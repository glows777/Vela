import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/db/sqlite.ts'
import { createMemoryTool } from '../../src/driver/extensions/memory/tool.ts'
import {
  serperSearchTool,
  tavilySearchTool,
  webFetchTool,
} from '../../src/driver/extensions/web/tools.ts'
import { MemoryDream, readDreamKvState } from '../../src/driver/memory/dream.ts'
import { rules } from '../../src/driver/prompt/index.ts'
import { createVelaAgentDriver } from '../../src/driver/runtime-adapter.ts'
import { runtimeToolModifiers } from '../../src/driver/runtime-prompt.ts'
import { ToolRegistry } from '../../src/driver/tools/registry.ts'
import { createVela } from '../../src/driver/vela.ts'
import {
  EnvironmentRegistry,
  VelaRuntimeEngine,
} from '../../src/runtime/index.ts'
import {
  MAX_NOTE_CHARS,
  MemoryRegistry,
  MemoryStore,
  memorySlug,
  resolveMemoryDirs,
} from '../../src/runtime/memory/index.ts'
import { createFauxModel, fauxText } from '../../src/testing/core/index.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const webServer = Bun.serve({
  port: 0,
  routes: {
    '/plain': () =>
      new Response('<h1>not html markdown</h1>\n\nline 2', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    '/json': () =>
      new Response(JSON.stringify({ ok: true, count: 2 }), {
        headers: { 'content-type': 'application/json' },
      }),
    '/html': () =>
      new Response('<html><body><h1>Hello</h1><p>World</p></body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
  },
})
afterAll(() => webServer.stop(true))

test('web_fetch runs turndown only for text/html and application/xhtml+xml, returning raw text otherwise', async () => {
  const plain = (await webFetchTool.execute({
    url: `http://localhost:${webServer.port}/plain`,
  })) as string
  expect(plain).toBe('<h1>not html markdown</h1>\n\nline 2')

  const json = (await webFetchTool.execute({
    url: `http://localhost:${webServer.port}/json`,
  })) as string
  expect(json).toBe('{"ok":true,"count":2}')

  const html = (await webFetchTool.execute({
    url: `http://localhost:${webServer.port}/html`,
  })) as string
  expect(html).toContain('# Hello')
  expect(html).toContain('World')
})

test('web_search passes 15s AbortSignal timeout to Tavily and Serper fetch requests', async () => {
  const signals: Array<AbortSignal | undefined> = []
  const spy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        signals.push((init?.signal as AbortSignal | undefined) ?? undefined)
        return new Response(JSON.stringify({ results: [], organic: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
      { preconnect: () => {} },
    ) as typeof fetch,
  )
  try {
    await tavilySearchTool('test-tavily').execute({ query: 'vela' })
    await serperSearchTool('test-serper').execute({ query: 'vela' })
    expect(signals).toHaveLength(2)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals[1]).toBeInstanceOf(AbortSignal)
  } finally {
    spy.mockRestore()
  }
})

test('restricted network mode disables web_fetch/web_search in EnvironmentRegistry, ToolRegistry, and createVela', async () => {
  const root = tempDir('vela-s3c-net-')
  const envs = new EnvironmentRegistry({
    dataDir: root,
    environments: {
      'docker-isolated': {
        image: 'alpine:latest',
        network: 'restricted',
      },
    },
  })
  expect(envs.networkMode('local')).toBe('on')
  expect(envs.networkMode('docker-isolated')).toBe('restricted')
  expect(
    runtimeToolModifiers({
      kind: 'work',
      projectId: 'p1',
      hasChannelBinding: false,
      networkMode: 'restricted',
    }),
  ).toEqual(expect.arrayContaining(['-web_fetch', '-web_search']))

  const registry = new ToolRegistry(join(root, 'spill'))
  registry.register(
    {
      name: 'web_fetch',
      description: 'fetch',
      inputSchema: webFetchTool.inputSchema,
      execute: async () => 'ok',
    },
    {
      name: 'read',
      description: 'read',
      inputSchema: webFetchTool.inputSchema,
      execute: async () => 'ok',
    },
  )
  registry.setRestrictedNetwork(true)
  expect(registry.isAvailable('web_fetch')).toBe(false)
  expect(registry.isAvailable('read')).toBe(true)

  const v = createVela({
    cwd: root,
    dataDir: join(root, 'data'),
    ephemeralSessions: true,
    model: createFauxModel({ responses: [fauxText('ok')] }),
    envNetworkMode: (envName) => (envName === 'local' ? 'restricted' : 'on'),
  })
  try {
    const s = v.session('s1')
    s.registry.register({
      name: 'web_fetch',
      description: 'fetch',
      inputSchema: webFetchTool.inputSchema,
      execute: async () => 'ok',
    })
    expect(s.getActiveTools()).not.toContain('web_fetch')
  } finally {
    await v.dispose()
  }
})

test('MemoryStore slug prevents collisions (C++ vs C# vs C, symbols, Unicode), matches index exactly, caps MAX_NOTE_CHARS=16000, and paginates reads', async () => {
  const dir = tempDir('vela-s3c-memstore-')
  const store = new MemoryStore(dir)

  expect(memorySlug('C++')).not.toBe(memorySlug('C#'))
  expect(memorySlug('C++')).not.toBe(memorySlug('C'))
  expect(memorySlug('???')).toMatch(/^note-[0-9a-f]{8}$/)

  const fCpp = store.save({
    name: 'C++',
    description: 'C plus plus preferences (user_c.md)',
    type: 'user',
    content: 'Use C++20',
  })
  const fCsharp = store.save({
    name: 'C#',
    description: 'C sharp notes',
    type: 'user',
    content: 'Use .NET 8',
  })
  const fC = store.save({
    name: 'C',
    description: 'C notes',
    type: 'user',
    content: 'Use C11',
  })
  expect(new Set([fCpp, fCsharp, fC]).size).toBe(3)

  // Deleting user_c.md must not touch the entry whose description contains "(user_c.md)"
  expect(store.delete(fC)).toBe(true)
  expect(store.loadIndex()).toContain(fCpp)
  expect(store.loadIndex()).not.toContain(`- [C](${fC})`)

  expect(() =>
    store.save({
      name: 'too-long',
      description: 'overflow',
      type: 'project',
      content: 'x'.repeat(MAX_NOTE_CHARS + 1),
    }),
  ).toThrow(/16000/)

  const longBody = Array.from(
    { length: 500 },
    (_, i) => `line-${i}: abcdefghij`,
  ).join('\n')
  const fLong = store.save({
    name: 'long-note',
    description: 'Paginated memory',
    type: 'project',
    content: longBody.slice(0, 10_000),
  })
  const page1 = store.loadFile(fLong, { offset: 0, limit: 2000 })!
  expect(page1).toContain('pass offset=2000 to continue')
  const page2 = store.loadFile(fLong, { offset: 2000, limit: 2000 })!
  expect(page2).not.toBe(page1)

  const tool = createMemoryTool(store)
  const toolRead = (await tool.execute({
    action: 'read',
    filename: fLong,
    offset: 2000,
    limit: 500,
  })) as string
  expect(toolRead).toContain('pass offset=2500 to continue')
  expect(existsSync(join(dir, '.dream'))).toBe(false)
})

test('MemoryRegistry caches singleton stores per directory and isolates project vs standalone chat stores', () => {
  const agentDir = tempDir('vela-s3c-memreg-')
  const reg = new MemoryRegistry()
  const p1 = resolveMemoryDirs(agentDir, 'proj-1')
  const chat = resolveMemoryDirs(agentDir, null)
  expect(p1.isProject).toBe(true)
  expect(p1.localDir).toBe(join(agentDir, 'projects', 'proj-1', 'memory'))
  expect(p1.globalDir).toBe(join(agentDir, 'memory'))
  expect(chat.isProject).toBe(false)
  expect(chat.localDir).toBe(join(agentDir, 'memory'))

  const a = reg.forSession(agentDir, 'proj-1')
  const b = reg.forSession(agentDir, 'proj-1')
  const c = reg.forSession(agentDir, null)
  expect(a.local).toBe(b.local)
  expect(a.global).toBe(c.local)
  expect(a.local).not.toBe(a.global)
})

test('MemoryDream in Runtime uses vela.db kv_meta + vela_messages cursor with zero .dream directory', async () => {
  const root = tempDir('vela-s3c-runtime-dream-')
  const db = openDatabase({ path: join(root, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: root })
  const model = createFauxModel({
    responses: [fauxText('Remembered')],
    generate: [
      (req) => {
        const payload = JSON.parse(req.lastUserText)
        expect(payload.inbox[0].user).toContain('Our API port is 8443')
        return fauxText(
          JSON.stringify({
            ops: [
              {
                action: 'create',
                filename: 'project_api-port.md',
                name: 'api-port',
                description: 'API server port',
                type: 'project',
                content: 'The API listens on port 8443',
                reason: 'User stated API port',
                source: payload.triggeringSessionId,
              },
            ],
            report: 'Recorded API port',
          }),
        )
      },
    ],
  })
  runtime.registerDriver(
    createVelaAgentDriver({
      db,
      agentDir: root,
      blobs: runtime.blobs,
      environments: runtime.environments,
      defaultModel: model,
    }),
  )

  try {
    const project = runtime.projects.create({ name: 'p', cwd: root })
    const s = runtime.sessions.create({
      projectId: project.id,
      kind: 'work',
      location: { environment: 'local', cwd: root },
    })
    runtime.submitPrompt({ sessionId: s.id, text: 'Our API port is 8443' })
    await runtime.waitForIdle(s.id)

    const projStore = new MemoryStore(
      join(root, 'projects', project.id, 'memory'),
    )
    const dream = new MemoryDream(projStore, db, {
      kind: 'project',
      projectId: project.id,
    })
    const report = await dream.run({
      sessionId: s.id,
      model,
      recordUsage: () => {},
    })
    expect(report).toContain('1 changes')
    expect(projStore.list().map((e) => e.name)).toContain('api-port')
    expect(
      existsSync(join(root, 'projects', project.id, 'memory', '.dream')),
    ).toBe(false)
    expect(existsSync(join(root, 'memory', '.dream'))).toBe(false)

    const kv = readDreamKvState(db, dream.kvKey)
    expect(kv.cursorRowId).toBeGreaterThan(0)
    expect(kv.logs).toHaveLength(1)
  } finally {
    await runtime.dispose()
    db.close()
  }
})

test('VelaAgentDriver injects initial [memory] index before user turn and system prompt uses relaxed conciseness rule', async () => {
  const root = tempDir('vela-s3c-mem-inject-')
  const db = openDatabase({ path: join(root, 'vela.db') })
  const runtime = new VelaRuntimeEngine({ db, agentDir: root })
  const model = createFauxModel({
    responses: [
      (req) => {
        const userMsgs = req.prompt.filter((m) => m.role === 'user')
        expect(userMsgs.length).toBeGreaterThanOrEqual(2)
        expect(JSON.stringify(userMsgs[0])).toContain('preferred-db')
        expect(JSON.stringify(userMsgs[1])).toContain('What DB do we use?')
        expect(req.system).not.toContain('at most 3')
        expect(req.system).toContain('Keep responses concise and proportional')
        return fauxText('SQLite WAL')
      },
    ],
  })
  runtime.registerDriver(
    createVelaAgentDriver({
      db,
      agentDir: root,
      blobs: runtime.blobs,
      environments: runtime.environments,
      defaultModel: model,
    }),
  )

  try {
    const project = runtime.projects.create({ name: 'p', cwd: root })
    new MemoryStore(join(root, 'projects', project.id, 'memory')).save({
      name: 'preferred-db',
      description: 'Database choice',
      type: 'project',
      content: 'SQLite WAL',
    })
    const s = runtime.sessions.create({
      projectId: project.id,
      kind: 'hub',
      location: { environment: 'local', cwd: root },
    })
    runtime.submitPrompt({ sessionId: s.id, text: 'What DB do we use?' })
    await runtime.waitForIdle(s.id)
    expect(model.calls).toHaveLength(1)
  } finally {
    await runtime.dispose()
    db.close()
  }

  const renderedRules = rules()({
    sessionId: 'x',
    activeTools: [],
    deferredToolSummary: '',
  })
  expect(renderedRules).toContain('Keep responses concise and proportional')
  mkdirSync(join(root, 'noop'), { recursive: true })
  writeFileSync(join(root, 'noop', 'ok'), '1')
})
