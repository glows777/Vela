import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
  tempDir,
} from '@glows777/vela/testing'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import { buildSessionPath } from '../../packages/vela/src/driver/diagnostics.ts'
import {
  createLocalExecutionEnv,
  createVela,
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
  const db = openDatabase({ path: ':memory:' })
  const state = {
    operations: 0,
    down: false,
    refuseSave: false,
    failDiscovery: false,
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
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS refuse_location_update
    BEFORE UPDATE OF location_json ON sessions
    WHEN EXISTS (SELECT 1)
    BEGIN
      SELECT 1;
    END;
    DROP TRIGGER refuse_location_update;
  `)
  const setRefuseSave = (refuse: boolean) => {
    state.refuseSave = refuse
    db.exec('DROP TRIGGER IF EXISTS refuse_location_update;')
    if (refuse) {
      db.exec(`
        CREATE TRIGGER refuse_location_update
        BEFORE UPDATE OF location_json ON sessions
        BEGIN
          SELECT RAISE(ABORT, 'storage unavailable');
        END;
      `)
    }
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
    db,
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
    db,
    setRefuseSave,
    cleanup: async () => {
      setRefuseSave(false)
      await vela.dispose()
      db.close()
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
      t.setRefuseSave(failure === 'persistence')
      await expect(t.session.setLocation(t.remote)).rejects.toThrow(
        failure === 'persistence' ? 'storage unavailable' : 'unavailable',
      )
      t.setRefuseSave(false)
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
    const origLoadSaved = reopened.store.loadSaved.bind(reopened.store)
    reopened.store.loadSaved = async () => {
      started.resolve()
      await release.promise
      return origLoadSaved()
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

test('a concurrent host metadata save preserves both name and moved location', async () => {
  const t = fixture()
  try {
    await t.session.prompt('first')
    const moving = t.session.setLocation(t.remote)
    t.session.setName('retained')
    const saving = t.session.save()
    await Promise.all([saving, moving])
    await t.session.close()
    const reopened = t.vela.session('move')
    expect(await reopened.resume()).toBe(true)
    expect(reopened.name).toBe('retained')
    expect(reopened.location).toEqual(t.remote)
  } finally {
    await t.cleanup()
  }
})

test('legacy history without saved location honors an explicit local open location and never inherits a remote default', async () => {
  const t = fixture()
  try {
    await t.session.prompt('first')
    await t.session.close()
    t.db.run("UPDATE sessions SET location_json = NULL WHERE id = 'move'")
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
    const raw = t.session.getEntries()
    await t.session.close()
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
