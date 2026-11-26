import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import z from 'zod'
import { cliWorkspaceModeAt } from '../../../../test/support/legacy-cli-helpers.ts'
import {
  cleanupTestVelas,
  createTestVela,
  tempDir,
} from '../../../../test/support/vela.ts'
import { openDatabase, savedTrust, saveTrust } from '../../src/db/index.ts'
import { createLocalExecutionEnv } from '../../src/driver/execution/local.ts'
import { loadConfig } from '../../src/driver/index.ts'
import { environment } from '../../src/driver/prompt/index.ts'
import {
  canonicalEnvironmentPath,
  ProjectConfig,
} from '../../src/driver/session/project-config.ts'
import { parseServers } from '../../src/mcp/config.ts'
import { McpPool, mcp } from '../../src/mcp/index.ts'
import { dockerContainerId } from '../../src/runtime/docker/container.ts'
import { createEnvironmentRegistryForTest } from '../../src/runtime/environments.ts'
import { silentLogger } from '../../src/shared/logger.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../src/testing/core/index.ts'

const dirs: { cleanup(): void }[] = []
afterEach(async () => {
  await cleanupTestVelas()
  for (const dir of dirs.splice(0)) dir.cleanup()
})

test('R2-P0-1: non-local trust is isolated per owner dataDir', () => {
  const dir = tempDir('vela-r2-scope-')
  dirs.push(dir)
  const agentDir = join(dir.path, 'agent')
  const dataA = join(dir.path, 'data-a')
  const dataB = join(dir.path, 'data-b')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(dataA, { recursive: true })
  mkdirSync(dataB, { recursive: true })

  saveTrust(agentDir, { environment: 'dev', cwd: '/workspace' }, true, dataA)
  expect(
    cliWorkspaceModeAt({
      agentDir,
      dataDir: dataA,
      startupCwd: dir.path,
      location: '/workspace/sub',
      environment: 'dev',
    }),
  ).toBe('all')
  expect(
    cliWorkspaceModeAt({
      agentDir,
      dataDir: dataB,
      startupCwd: dir.path,
      location: '/workspace/sub',
      environment: 'dev',
    }),
  ).toBe('none')
})

test('R2-P0-2: symlinks cannot transfer local trust or bypass remote child denials', async () => {
  const dir = tempDir('vela-r2-symlink-')
  dirs.push(dir)
  const agentDir = join(dir.path, 'agent')
  const trustedOrig = join(dir.path, 'trusted-dir')
  const untrustedTarget = join(dir.path, 'evil-dir')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(trustedOrig, { recursive: true })
  mkdirSync(untrustedTarget, { recursive: true })

  saveTrust(agentDir, trustedOrig, true)
  rmSync(trustedOrig, { recursive: true, force: true })
  symlinkSync(untrustedTarget, trustedOrig)
  expect(savedTrust(agentDir, trustedOrig)).toBeUndefined()
  expect(savedTrust(agentDir, untrustedTarget)).toBeUndefined()

  // Remote workspace symlink inside approved parent pointing to denied physical child
  const remoteRoot = join(dir.path, 'remote')
  const remoteSecret = join(remoteRoot, 'secret')
  const remoteAlias = join(remoteRoot, 'alias')
  mkdirSync(join(remoteSecret, '.vela'), { recursive: true })
  symlinkSync(remoteSecret, remoteAlias)
  writeFileSync(
    join(remoteSecret, '.vela/config.json'),
    JSON.stringify({ thinkingLevel: 'high' }),
  )

  const baseEnv = createLocalExecutionEnv({ cwd: remoteAlias })
  const remoteEnv = Object.assign(
    Object.create(Object.getPrototypeOf(baseEnv)),
    baseEnv,
    { id: 'docker:dev' },
  ) as typeof baseEnv
  try {
    const resolved = await canonicalEnvironmentPath(remoteEnv, remoteAlias)
    expect(resolved).toEndWith('/remote/secret')

    saveTrust(agentDir, { environment: 'dev', cwd: remoteRoot }, true)
    saveTrust(agentDir, { environment: 'dev', cwd: resolved }, false)

    const cfg = loadConfig({ cwd: dir.path, agentDir })
    const projectCfg = new ProjectConfig(
      {
        ...cfg.sessionResources!,
        workspaceModeAt: (cwd, environment = 'local') =>
          savedTrust(agentDir, { environment, cwd }) === true ? 'all' : 'none',
      },
      join(dir.path, 'data'),
      silentLogger,
    )
    const settings = await projectCfg.get('s-alias', remoteEnv, 'dev')
    expect(settings.thinkingLevel).toBeUndefined()
  } finally {
    await baseEnv.cleanup()
  }
})

test('R2-P1-1: opening session on day 1 and prompting on day 2 preserves day 1 created_at across resume', async () => {
  const real = Date
  const pin = (iso: string) => {
    const fixed = new real(iso)
    globalThis.Date = new Proxy(real, {
      construct(target, args, newTarget) {
        const used = args.length === 0 ? [fixed.getTime()] : args
        return Reflect.construct(target, used, newTarget)
      },
      get(target, prop, receiver) {
        if (prop === 'now') return () => fixed.getTime()
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as DateConstructor
  }
  const dir = tempDir('vela-r2-date-')
  dirs.push(dir)
  try {
    pin('2026-10-11T23:30:00')
    const first = createVela({
      cwd: dir.path,
      dataDir: join(dir.path, 'data'),
      model: createFauxModel({ responses: [fauxText('ok')] }),
    })
    const s = first.session('date-span')

    pin('2026-10-12T00:30:00')
    await s.prompt('hi')
    await first.dispose()

    const resumedModel = createFauxModel({ responses: [fauxText('again')] })
    const second = createVela({
      cwd: dir.path,
      dataDir: join(dir.path, 'data'),
      model: resumedModel,
    })
    const rs = second.session('date-span')
    expect(await rs.resume()).toBe(true)
    await rs.prompt('second')
    expect(resumedModel.calls[0]!.system).toContain(
      '\nCurrent date: 2026-10-11\n',
    )
    await second.dispose()
  } finally {
    globalThis.Date = real
  }
})

test('R2-P1-2 & R2-P1-3 & R2-P1-4 & R2-P2-1: MCP resume wait, deterministic direct order, eviction wait on dispose, and cleared error replay', async () => {
  // R2-P1-2: delayed deferred server owning restored discoveredTools waits on resume Turn 1
  const dir = tempDir('vela-r2-mcp-resume-')
  dirs.push(dir)
  let delayConnect = false
  let releaseConnect!: () => void
  const delayedCreateTransport = async (entry: { name: string }) => {
    if (delayConnect) {
      await new Promise<void>((resolve) => {
        releaseConnect = resolve
      })
    }
    const server = new McpServer({ name: entry.name, version: '1.0.0' })
    server.registerTool(
      'ping',
      { description: 'Ping', inputSchema: { x: z.string() } },
      async ({ x }) => ({ content: [{ type: 'text', text: x }] }),
    )
    const [client, side] = InMemoryTransport.createLinkedPair()
    await server.connect(side)
    return client
  }

  const m1 = createFauxModel({
    responses: [
      fauxToolCall('tool_search', { query: 'mcp__sample__ping' }),
      fauxText('loaded'),
    ],
  })
  const v1 = createVela({
    cwd: dir.path,
    dataDir: join(dir.path, 'data'),
    model: m1,
    extensions: [
      mcp({
        servers: { sample: { command: 'unused' } },
        createTransport: delayedCreateTransport,
      }),
    ],
  })
  await v1.session('s-res').prompt('load it')
  await v1.dispose()

  delayConnect = true
  const m2 = createFauxModel({ responses: [fauxText('resumed-ok')] })
  const v2 = createVela({
    cwd: dir.path,
    dataDir: join(dir.path, 'data'),
    model: m2,
    extensions: [
      mcp({
        servers: { sample: { command: 'unused' } },
        createTransport: delayedCreateTransport,
      }),
    ],
  })
  const s2 = v2.session('s-res')
  expect(await s2.resume()).toBe(true)
  const promptTask = s2.prompt('after resume')
  for (let i = 0; i < 50 && !releaseConnect; i++) await Bun.sleep(5)
  releaseConnect()
  await promptTask
  expect(m2.calls[0]!.tools).toContain('mcp__sample__ping')
  await v2.dispose()

  // R2-P1-3: deterministic direct MCP tool order regardless of initial connect vs warm replay order
  const pool = new McpPool({ idleTtlMs: 60_000 })
  let releaseA!: () => void
  const directOrderCreateTransport = async (entry: { name: string }) => {
    if (entry.name === 'alpha') {
      await new Promise<void>((resolve) => {
        releaseA = resolve
      })
    }
    const server = new McpServer({ name: entry.name, version: '1.0.0' })
    server.registerTool(
      'run',
      { description: entry.name, inputSchema: {} },
      async () => ({ content: [{ type: 'text', text: entry.name }] }),
    )
    const [client, side] = InMemoryTransport.createLinkedPair()
    await server.connect(side)
    return client
  }
  const orderM1 = createFauxModel({ responses: [fauxText('first')] })
  const orderV1 = createVela({
    model: orderM1,
    extensions: [
      mcp({
        pool,
        servers: {
          alpha: { command: 'unused', exposure: 'direct' },
          beta: { command: 'unused', exposure: 'direct' },
        },
        createTransport: directOrderCreateTransport,
      }),
    ],
  })
  const orderS1 = orderV1.session()
  const p1 = orderS1.prompt('one')
  for (let i = 0; i < 50 && !releaseA; i++) await Bun.sleep(5)
  releaseA()
  await p1
  const firstTools = orderM1.calls[0]!.tools

  await orderV1.dispose()
  const orderM2 = createFauxModel({ responses: [fauxText('second')] })
  const orderV2 = createVela({
    model: orderM2,
    extensions: [
      mcp({
        pool,
        servers: {
          alpha: { command: 'unused', exposure: 'direct' },
          beta: { command: 'unused', exposure: 'direct' },
        },
        createTransport: directOrderCreateTransport,
      }),
    ],
  })
  await orderV2.session().prompt('two')
  expect(orderM2.calls[0]!.tools).toEqual(firstTools)
  await orderV2.dispose()
  await pool.dispose()

  // R2-P1-4 & R2-P2-1: dispose awaits in-flight idle eviction; reconnected server clears error replay
  let closeFinished = false
  let releaseClose!: () => void
  let markCloseEntered!: () => void
  const closeEntered = new Promise<void>((resolve) => {
    markCloseEntered = resolve
  })
  const slowClosePool = new McpPool({ idleTtlMs: 15 })
  const { entries } = parseServers({ docs: { command: 'unused' } })
  const evictLease = slowClosePool.acquire({
    cwd: join(dir.path, 'evict'),
    entries,
    errors: [],
    createTransport: async () =>
      ({
        start: async () => {},
        send: async () => {},
        close: async () => {
          markCloseEntered()
          await new Promise<void>((resolve) => {
            releaseClose = resolve
          })
          closeFinished = true
        },
      }) as Transport,
    onTools: () => {},
    onError: () => {},
  })
  evictLease.start()
  await Bun.sleep(10)
  await evictLease.release()
  await closeEntered
  let disposed = false
  const disposing = slowClosePool.dispose().then(() => {
    disposed = true
  })
  await Bun.sleep(20)
  expect(closeFinished).toBe(false)
  expect(disposed).toBe(false)
  releaseClose()
  await disposing
  expect(closeFinished).toBe(true)

  // R2-P2-1: reconnected server does not replay stale failure to later lease
  const reconnectPool = new McpPool({ idleTtlMs: 60_000 })
  let shouldFail = true
  const rErrors1: string[][] = []
  const rErrors2: string[][] = []
  const rLease1 = reconnectPool.acquire({
    cwd: join(dir.path, 'rec'),
    entries,
    errors: [],
    createTransport: async (entry) => {
      if (shouldFail) throw new Error('initial failure')
      const server = new McpServer({ name: entry.name, version: '1.0.0' })
      server.registerTool(
        'ping',
        { description: 'Ping', inputSchema: {} },
        async () => ({ content: [{ type: 'text', text: 'pong' }] }),
      )
      const [client, side] = InMemoryTransport.createLinkedPair()
      await server.connect(side)
      return client
    },
    onTools: () => {},
    onError: (e) => rErrors1.push(e),
  })
  rLease1.start()
  await rLease1.waitForAll()
  expect(rErrors1.length).toBe(1)
  shouldFail = false
  const rec = await rLease1.reconnect('docs')
  expect(rec.ok).toBe(true)
  const rLease2 = reconnectPool.acquire({
    cwd: join(dir.path, 'rec'),
    entries,
    errors: [],
    onTools: () => {},
    onError: (e) => rErrors2.push(e),
  })
  rLease2.start()
  await Bun.sleep(20)
  expect(rErrors2).toEqual([])
  await reconnectPool.dispose()
})

test('R2-P1-5 & R2-P1-6: in-flight invalidated probe retries cleanly and completed cleanup errors surface in dispose', async () => {
  const dir = tempDir('vela-r2-env-')
  dirs.push(dir)

  let opened = 0
  let releaseProbe!: () => void
  let holdProbe = true
  const cleanups: string[] = []

  const reg = createEnvironmentRegistryForTest({
    dataDir: dir.path,
    environments: { dev: { image: 'vela-base:local' } },
    openDocker: async (_opts, cwd = '/workspace') => {
      const n = ++opened
      const base = createLocalExecutionEnv({ cwd: dir.path })
      return {
        ...base,
        id: `docker:dev:${n}`,
        cwd,
        [dockerContainerId]: `c-${n}`,
        async cleanup() {
          cleanups.push(`c-${n}`)
          await base.cleanup()
          if (n === 2) throw new Error('earlier completed failure')
        },
      }
    },
    probeAlive: async () => {
      if (holdProbe) {
        holdProbe = false
        await new Promise<void>((resolve) => {
          releaseProbe = resolve
        })
      }
      return true
    },
  })

  const env1 = await reg.resolve({
    sessionId: 's1',
    location: { environment: 'dev', cwd: '/workspace' },
  })
  const resolving2 = reg.resolve({
    sessionId: 's2',
    location: { environment: 'dev', cwd: '/workspace' },
  })
  for (let i = 0; i < 50 && !releaseProbe; i++) await Bun.sleep(5)
  reg.invalidate({ environment: 'dev', cwd: '/workspace' })
  releaseProbe()
  const env2 = await resolving2
  expect(env2).not.toBe(env1)
  expect(env2?.id).toBe('docker:dev:2')

  // Invalidate c-2 and let its cleanup finish (rejecting) BEFORE dispose() runs
  reg.invalidate({ environment: 'dev', cwd: '/workspace' })
  await Bun.sleep(30)
  expect(cleanups).toEqual(['c-1', 'c-2'])
  await expect(reg.dispose()).rejects.toThrow('earlier completed failure')
})

test('R2-P1-7: openDatabase({ mustExist: true }) never recreates a missing vela.db', () => {
  const dir = tempDir('vela-r2-must-exist-')
  dirs.push(dir)
  const missingPath = join(dir.path, 'vela.db')
  expect(() => openDatabase({ path: missingPath, mustExist: true })).toThrow()
  expect(existsSync(missingPath)).toBe(false)
})

test('R2-P2-2 & R2-P2-3: narrowed sessions omit unreachable MCP namespaces and remote <env> omits shell', async () => {
  const fakeTransport = async (entry: { name: string }) => {
    const server = new McpServer({ name: entry.name, version: '1.0.0' })
    server.registerTool(
      'lookup',
      { description: 'Lookup', inputSchema: {} },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    )
    const [client, side] = InMemoryTransport.createLinkedPair()
    await server.connect(side)
    return client
  }

  const t = createTestVela({
    session: { tools: ['read', 'tool_search'] },
    extensions: [
      mcp({
        servers: { docs: { command: 'unused', description: 'Docs server' } },
        createTransport: fakeTransport,
      }),
    ],
    responses: [
      (req) => {
        expect(req.system).not.toContain('mcp__docs')
        expect(req.system).not.toContain('<deferred_tools>')
        return fauxText('ok')
      },
    ],
  })
  await t.run('hi')

  expect(
    environment({ os: 'linux', shell: false, date: '2026-11-25' })({
      deferredToolSummary: '',
      sessionId: 's',
    }),
  ).toBe('os: linux\nCurrent date: 2026-11-25')
})
