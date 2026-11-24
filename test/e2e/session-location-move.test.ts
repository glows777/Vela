import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
  tempDir,
} from '@glows777/vela/testing'
import { buildSessionPath } from '../../packages/vela/src/driver/diagnostics.ts'
import {
  createLocalExecutionEnv,
  createVela,
  memorySessionStorage,
} from '../../packages/vela/src/driver/index.ts'

function fixture() {
  const dir = tempDir('vela-move-')
  const local = { environment: 'local', cwd: join(dir.path, 'local') }
  const remote = { environment: 'sandbox', cwd: join(dir.path, 'remote') }
  for (const target of [local, remote]) {
    mkdirSync(target.cwd)
    writeFileSync(
      join(target.cwd, 'AGENTS.md'),
      `${target.environment} instructions`,
    )
    writeFileSync(join(target.cwd, 'marker'), `${target.environment} file`)
  }
  const disk = createLocalExecutionEnv({ cwd: remote.cwd })
  Object.defineProperty(disk, 'id', { value: 'fixture:isolated' })
  const storage = memorySessionStorage()
  const state = {
    operations: 0,
    down: false,
    refuseSave: false,
    failDiscovery: false,
    lostAck: false,
  }
  // Count every environment operation, including path and directory probes on a warm wake.
  const backend = new Proxy(disk, {
    get(target, key) {
      const method = Reflect.get(target, key)
      if (typeof method !== 'function') return method
      return (...args: unknown[]) => {
        state.operations++
        if (key === 'readTextFile' && state.failDiscovery)
          return Promise.resolve({
            ok: false,
            error: Object.assign(new Error('resource read unavailable'), {
              code: 'unavailable',
            }),
          })
        return Reflect.apply(method, target, args)
      }
    },
  })
  const append = storage.append.bind(storage)
  storage.append = async (...args) => {
    if (state.refuseSave) throw Error('storage unavailable')
    // A schema-backed storage can round-trip the documented custom entry fields only.
    const entries = args[1].map((entry) =>
      entry.type === 'custom'
        ? {
            id: entry.id,
            parentId: entry.parentId,
            timestamp: entry.timestamp,
            type: entry.type,
            customType: entry.customType,
            data: entry.data,
          }
        : entry,
    )
    await append(args[0], entries)
    if (state.lostAck) throw Error('lost acknowledgement')
  }
  const model = createFauxModel({
    cache: true,
    responses: [
      fauxText('first'),
      fauxToolCall('read', { path: 'marker' }),
      fauxText('done'),
      fauxText('again'),
    ],
  })
  const vela = createVela({
    dataDir: join(dir.path, 'data'),
    cwd: local.cwd,
    model,
    sessionStorage: storage,
    env: ({ location }) =>
      location.environment === 'local'
        ? createLocalExecutionEnv({ cwd: location.cwd })
        : location.environment === 'sandbox' && !state.down
          ? backend
          : undefined,
  })
  const session = vela.session('move')
  return {
    local,
    remote,
    model,
    session,
    vela,
    state,
    storage,
    cleanup: async () => {
      await vela.dispose()
      dir.cleanup()
    },
  }
}

test('a trusted move changes the tool and prompt together, pins resources and survives reopen', async () => {
  const t = fixture()
  try {
    await t.session.prompt('first')
    expect(t.session.location).toEqual(t.local)
    await t.session.setLocation(t.remote)
    expect(t.session.location).toEqual(t.remote)
    const prepared = await t.session.resources()
    expect(prepared.contextFiles.map((f) => f.content)).toContain(
      'sandbox instructions',
    )
    const coldOperations = t.state.operations
    await t.session.setLocation({ ...t.remote })
    await t.session.resources()
    expect(t.state.operations).toBe(coldOperations)
    await t.session.prompt('read marker')
    expect(t.model.calls[2]!.toolResults[0]!.output).toContain('sandbox file')
    const afterTool = t.state.operations
    expect(afterTool).toBeGreaterThan(coldOperations)
    await t.session.prompt('ordinary wake')
    expect(t.state.operations).toBe(afterTool)
    expect(t.model.calls[3]!.system).toBe(t.model.calls[2]!.system)
    expect(t.model.calls[3]!.tools).toEqual(t.model.calls[2]!.tools)
    expect(t.session.buildSystem()).not.toContain('local instructions')
    await t.session.close()
    const reopened = t.vela.session('move')
    expect(await reopened.resume()).toBe(true)
    expect(reopened.location).toEqual(t.remote)
    expect((await reopened.executeBash('cat marker')).output).toBe(
      'sandbox file',
    )
    await reopened.setLocation(t.local)
    expect((await reopened.executeBash('cat marker')).output).toBe('local file')
  } finally {
    await t.cleanup()
  }
})

test.each(['resolver', 'discovery', 'persistence'] as const)(
  'a failed %s does not switch live or durable location, context or tools',
  async (failure) => {
    const t = fixture()
    try {
      await t.session.prompt('first')
      const prefix = t.session.buildSystem(),
        tools = t.session.getActiveTools()
      t.state.down = failure === 'resolver'
      t.state.failDiscovery = failure === 'discovery'
      t.state.refuseSave = failure === 'persistence'
      await expect(t.session.setLocation(t.remote)).rejects.toThrow(
        failure === 'persistence' ? 'storage unavailable' : 'unavailable',
      )
      t.state.refuseSave = false
      expect(t.session.location).toEqual(t.local)
      expect(t.session.buildSystem()).toBe(prefix)
      expect(t.session.getActiveTools()).toEqual(tools)
      expect((await t.session.executeBash('cat marker')).output).toBe(
        'local file',
      )
      await t.session.close()
      const s = t.vela.session('move')
      expect(await s.resume()).toBe(true)
      expect(s.location).toEqual(t.local)
    } finally {
      await t.cleanup()
    }
  },
)

test('busy foreground, shell and tracked background work refuse a move', async () => {
  const t = fixture()
  try {
    const job = Promise.withResolvers<void>()
    t.session.trackWork(job.promise)
    try {
      await expect(t.session.setLocation(t.remote)).rejects.toThrow(
        /busy|running/i,
      )
    } finally {
      job.resolve()
      await job.promise
    }
    const shell = t.session.executeBash('echo ready')
    try {
      await expect(t.session.setLocation(t.remote)).rejects.toThrow(
        /busy|running/i,
      )
    } finally {
      await shell
    }
    const turn = t.session.prompt('first')
    try {
      await expect(t.session.setLocation(t.remote)).rejects.toThrow(
        /busy|running/i,
      )
    } finally {
      await turn
    }
    expect(t.session.location).toEqual(t.local)
  } finally {
    await t.cleanup()
  }
})

test('a completed move with a lost storage acknowledgement survives reopen', async () => {
  const t = fixture()
  try {
    // Establish the source transcript; only the relocation append loses its acknowledgement.
    await t.session.prompt('first')
    t.state.lostAck = true
    await t.session.setLocation(t.remote)
    t.state.lostAck = false
    await t.session.close()
    const reopened = t.vela.session('move')
    expect(await reopened.resume()).toBe(true)
    expect(reopened.location).toEqual(t.remote)
  } finally {
    t.state.lostAck = false
    await t.cleanup()
  }
})

test('a saved remote target that is offline on reopen cannot run a local tool', async () => {
  const t = fixture()
  try {
    await t.session.setLocation(t.remote)
    await t.session.close()
    t.state.down = true
    const reopened = t.vela.session('move')
    await expect(reopened.resume()).rejects.toThrow('unavailable')
    expect(reopened.location).toEqual(t.remote)
    await expect(reopened.prompt('try to read marker')).rejects.toThrow(
      'unavailable',
    )
    expect(t.model.calls).toHaveLength(0)
    t.state.down = false
    expect(await reopened.resume()).toBe(true)
    expect((await reopened.executeBash('cat marker')).output).toBe(
      'sandbox file',
    )
  } finally {
    await t.cleanup()
  }
})

test('a session cannot relocate while resume is reading the saved location', async () => {
  const t = fixture()
  try {
    await t.session.prompt('first')
    await t.session.close()
    const reopened = t.vela.session('move')
    const started = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const load = t.storage.load.bind(t.storage)
    t.storage.load = async (id) => {
      const saved = await load(id)
      started.resolve()
      await release.promise
      return saved
    }
    const restoring = reopened.resume()
    await started.promise
    try {
      await expect(reopened.setLocation(t.remote)).rejects.toThrow(
        /running|busy/,
      )
    } finally {
      release.resolve()
      await restoring
    }
    expect(reopened.location).toEqual(t.local)
  } finally {
    await t.cleanup()
  }
})

test('an uncertain storage outcome blocks execution until resume reconciles the recorded location', async () => {
  const t = fixture()
  try {
    await t.session.prompt('first')
    const load = t.storage.load.bind(t.storage)
    t.state.lostAck = true
    t.storage.load = async () => {
      throw Error('readback offline')
    }
    await expect(t.session.setLocation(t.remote)).rejects.toThrow(
      /resume|unknown/i,
    )
    expect(t.session.location).toEqual(t.local)
    await expect(t.session.executeBash('cat marker')).rejects.toThrow(
      /resume|unknown/i,
    )
    await expect(t.session.prompt('continue here')).rejects.toThrow(
      /resume|unknown/i,
    )
    expect(t.model.calls).toHaveLength(1)
    t.state.lostAck = false
    t.storage.load = load
    expect(await t.session.resume()).toBe(true)
    expect(t.session.location).toEqual(t.remote)
    expect((await t.session.executeBash('cat marker')).output).toBe(
      'sandbox file',
    )
  } finally {
    t.state.lostAck = false
    await t.cleanup()
  }
})

test('a concurrent host metadata save serializes with the location append', async () => {
  const t = fixture()
  try {
    await t.session.prompt('first')
    const append = t.storage.append.bind(t.storage)
    const started = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    let writing = false,
      overlap = false
    t.storage.append = async (id, entries) => {
      if (writing) overlap = true
      if (
        entries.some(
          (e) =>
            e.type === 'custom' && e.customType === 'vela.session.location',
        )
      ) {
        writing = true
        started.resolve()
        await release.promise
      }
      await append(id, entries)
      writing = false
    }
    const moving = t.session.setLocation(t.remote)
    await started.promise
    t.session.setName('retained')
    const saving = t.session.save()
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
    } finally {
      release.resolve()
      await Promise.all([saving, moving])
    }
    expect(overlap).toBe(false)
    await t.session.close()
    const reopened = t.vela.session('move')
    expect(await reopened.resume()).toBe(true)
    expect(reopened.name).toBe('retained')
    expect(reopened.location).toEqual(t.remote)
  } finally {
    await t.cleanup()
  }
})

test('legacy history honors an explicit local open location and never inherits a remote default', async () => {
  const t = fixture()
  try {
    await t.session.prompt('first')
    await t.session.close()
    const load = t.storage.load.bind(t.storage)
    t.storage.load = async (id) => {
      const entries = await load(id)
      const header = entries?.[0]
      if (header?.type === 'session') delete header.location
      return entries
    }
    const localOverride = { environment: 'local', cwd: t.remote.cwd }
    const first = t.vela.session('move', { location: localOverride })
    expect(await first.resume()).toBe(true)
    expect(first.location).toEqual(localOverride)
    await first.close()
    const second = t.vela.session('move', { location: t.remote })
    expect(await second.resume()).toBe(true)
    expect(second.location).toEqual(t.local)
  } finally {
    await t.cleanup()
  }
})

test('a remote clone reopens on its own saved location and ordinary custom history cannot reroute it', async () => {
  const t = fixture()
  try {
    await t.session.setLocation(t.remote)
    await t.session.prompt('first')
    const fork = (await t.session.clone({ sessionId: 'copy' })).session!
    expect(fork.location).toEqual(t.remote)
    fork.appendEntry('vela.session.location', t.local)
    await fork.save()
    await fork.close()
    const reopened = t.vela.session('copy')
    expect(await reopened.resume()).toBe(true)
    expect(reopened.location).toEqual(t.remote)
    expect((await reopened.executeBash('cat marker')).output).toBe(
      'sandbox file',
    )
    await reopened.setLocation(t.local)
    expect(t.session.location).toEqual(t.remote)
  } finally {
    await t.cleanup()
  }
})

test('an offline export and archiving a closed session preserve the conversation after a move', async () => {
  const t = fixture()
  try {
    await t.session.prompt('history to retain')
    const messages = structuredClone(t.session.messages)
    await t.session.setLocation(t.remote)
    await t.session.close()
    const raw = (await t.storage.load('move'))!.filter(
      (e) => e.type !== 'session',
    )
    expect(
      buildSessionPath(raw).filter((e) => e.type === 'message'),
    ).toHaveLength(messages.length)
    await t.vela.setSessionArchived('move', true)
    const reopened = t.vela.session('move')
    expect(await reopened.resume()).toBe(true)
    expect(reopened.messages).toEqual(messages)
    expect(reopened.location).toEqual(t.remote)
  } finally {
    await t.cleanup()
  }
})
