import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVela, type VelaOptions } from '@glows777/vela'
import { createFauxModel, fauxText, tempDir } from '@glows777/vela/testing'
import { drainChannels } from '@glows777/vela-channels/testing'
import { createLocalExecutionEnv } from '@glows777/vela-core'
import { lark } from '@glows777/vela-lark'
import { cliHostExtensionConfig } from '../../packages/vela/src/cli/project-extensions.ts'
import { parseArgs } from '../../packages/vela/src/cli/setup.ts'
import { loadConfig } from '../../packages/vela/src/config/index.ts'
import { fakeLark, larkEvent } from '../support/lark.ts'

test('project settings cannot redirect an owner environment, group or Docker data directory', () => {
  const dir = tempDir()
  try {
    const owner = join(dir.path, 'owner'),
      project = join(dir.path, 'project/.vela')
    for (const path of [owner, project]) mkdirSync(path, { recursive: true })
    for (const [path, dataDir, chats] of [
      [owner, 'owner-data', [{ id: 'group', environment: 'blue' }]],
      [
        project,
        'project-data',
        [
          { id: 'group', environment: 'red', readUntagged: false },
          { id: 'other', environment: 'red' },
        ],
      ],
    ] as const)
      writeFileSync(
        join(path, 'settings.json'),
        JSON.stringify({
          dataDir,
          ...(path === project
            ? { location: { environment: 'red', cwd: '/workspace' } }
            : {}),
          environments: { blue: { image: path } },
          extensionConfig: { lark: { chats } },
        }),
      )
    const config = loadConfig({
      cwd: join(dir.path, 'project'),
      agentDir: owner,
      trusted: true,
    })
    expect(cliHostExtensionConfig(config, parseArgs([])).lark?.chats).toEqual([
      { id: 'group', environment: 'blue', readUntagged: false },
      { id: 'other' },
    ])
    expect(config.settings).toHaveProperty('environments.blue.image', owner)
    expect(config.settings).not.toHaveProperty('location')
    expect(config.dataDir).toBe(join(dir.path, 'project/owner-data'))
  } finally {
    dir.cleanup()
  }
})

function host(dataDir: string, environment?: string, env?: VelaOptions['env']) {
  const fake = fakeLark()
  const model = createFauxModel({ cache: true })
  const vela = createVela({
    dataDir,
    cwd: dataDir,
    model,
    env,
    extensions: [lark({ appId: 'bot', transport: fake.transport })],
    extensionConfig: {
      lark: {
        chats: [{ id: 'oc_group', ...(environment ? { environment } : {}) }],
      },
    },
  })
  const replies: string[] = []
  let n = 0
  return {
    vela,
    fake,
    model,
    replies,
    async start() {
      await vela.ready()
      vela.subscribe((e) => {
        if (e.type === 'channel_reply') replies.push(e.text)
      })
      await vela.startChannels()
    },
    async input(topic: boolean, text: string) {
      model.push(fauxText('answer'))
      if (topic && text === 'seed') {
        fake.deliver(
          larkEvent({
            message_id: 'topic-seed',
            root_id: 'root',
            thread_id: 'thread',
          }),
        )
        for (let n = 0; n < 200 && !replies.includes('answer'); n++)
          await Bun.sleep(10)
        await drainChannels(vela)
        return vela.session(
          vela
            .channel('lark')
            .sessions('oc_group')
            .find((s) => s.topic)!.sessionId,
        )
      }
      const { sessionId } = await vela.channel('lark').submit({
        channelId: 'oc_group',
        chatKind: 'group',
        senderId: 'user',
        senderName: 'User',
        text,
        replyToId: `msg-${text}-${++n}`,
        ...(topic ? { topic: { rootId: 'root', threadId: 'thread' } } : {}),
      })
      await drainChannels(vela)
      return vela.session(sessionId)
    },
  }
}

// Simulate guest path semantics. Discovery reads synthetic empty directories only.
function guest(populated: boolean) {
  let calls = 0
  const stub = createLocalExecutionEnv({ cwd: '/workspace' })
  Object.defineProperty(stub, 'id', { value: 'fixture:blue' })
  const missing = {
    ok: false,
    error: Object.assign(Error('missing'), { code: 'not_found' }),
  }
  const backend = new Proxy(stub, {
    get(target, prop) {
      const fn = Reflect.get(target, prop)
      if (typeof fn !== 'function') return fn
      return (...args: unknown[]) => {
        calls++
        if (prop === 'joinPath')
          return { ok: true, value: join(...(args[0] as string[])) }
        if (prop === 'absolutePath')
          return {
            ok: true,
            value: String(args[0]).replace(/^~/, '/home/guest'),
          }
        if (prop === 'exists') return { ok: true, value: false }
        if (prop === 'listDir' && args[0] === '/workspace')
          return { ok: true, value: populated ? [{ name: 'repo' }] : [] }
        if (prop === 'cleanup') return
        return missing
      }
    },
  })
  return { backend, count: () => calls }
}

test.each([false, true])(
  'existing group session (topic=%s) moves on admission once, remains warm, and moves back on restart',
  async (topic) => {
    const dir = tempDir(),
      g = guest(topic)
    const resolve: VelaOptions['env'] = ({ location }) =>
      location.environment === 'local'
        ? createLocalExecutionEnv({ cwd: location.cwd })
        : g.backend
    let h = host(dir.path)
    try {
      await h.start()
      const initial = await h.input(topic, 'seed')
      expect(h.model.calls.length).toBe(1)
      const local = initial.location
      await h.vela.dispose()
      h = host(dir.path, 'blue', resolve)
      await h.start()
      const s = await h.input(topic, 'move')
      expect(s.id).toBe(initial.id)
      expect(s.location).toEqual({ environment: 'blue', cwd: '/workspace' })
      const notices = () =>
        h.replies.filter(
          (text) => text.includes('workspace') && text.includes('blue'),
        )
      expect(notices()).toHaveLength(1)
      expect(notices()[0]!.includes('empty')).toBe(!topic)
      expect(notices()[0]!.includes('clone')).toBe(!topic)
      const cold = g.count()
      await h.input(topic, 'wake')
      expect(g.count()).toBe(cold)
      expect(h.model.calls[1]!.system).toBe(h.model.calls[0]!.system)
      expect(notices()).toHaveLength(1)
      await h.vela.dispose()
      h = host(dir.path)
      await h.start()
      const back = await h.input(topic, 'reverse')
      expect(back.location).toEqual(local)
      expect(h.model.calls.length).toBe(1)
    } finally {
      await h.vela.dispose()
      dir.cleanup()
    }
  },
)

test('failed target preparation keeps an existing hub local and never admits the input to its model', async () => {
  const dir = tempDir()
  let h = host(dir.path)
  try {
    await h.start()
    const local = await h.input(false, 'seed')
    await h.vela.dispose()
    h = host(dir.path, 'missing', ({ location }) =>
      location.environment === 'local'
        ? createLocalExecutionEnv({ cwd: location.cwd })
        : undefined,
    )
    await h.start()
    await h.input(false, 'unavailable').catch(() => {})
    expect(h.model.calls).toHaveLength(0)
    expect(h.vela.session(local.id).location).toEqual(local.location)
    expect(h.replies.some((text) => text.includes('Moved'))).toBe(false)
  } finally {
    await h.vela.dispose()
    dir.cleanup()
  }
})

test('a hub with tracked work waits for idle before migration and admission', async () => {
  const dir = tempDir(),
    g = guest(false)
  let h = host(dir.path)
  const job = Promise.withResolvers<void>()
  try {
    await h.start()
    const initial = await h.input(false, 'seed')
    await h.vela.dispose()
    h = host(dir.path, 'blue', ({ location }) =>
      location.environment === 'local'
        ? createLocalExecutionEnv({ cwd: location.cwd })
        : g.backend,
    )
    await h.start()
    const active = h.vela.session(initial.id, { location: initial.location })
    active.trackWork(job.promise)
    const next = h.input(false, 'while-busy')
    await Bun.sleep(100)
    expect(g.count()).toBe(0)
    expect(h.model.calls).toHaveLength(0)
    job.resolve()
    await next
    expect(active.location.environment).toBe('blue')
    expect(h.model.calls).toHaveLength(1)
  } finally {
    job.resolve()
    await h.vela.dispose()
    dir.cleanup()
  }
})

test('a lost migration-notice receipt reuses the original Lark delivery identity and chat anchor on restart', async () => {
  const dir = tempDir(),
    g = guest(false)
  const resolve: VelaOptions['env'] = ({ location }) =>
    location.environment === 'local'
      ? createLocalExecutionEnv({ cwd: location.cwd })
      : g.backend
  let h = host(dir.path)
  const attempts: { anchor: string; text: string; uuid?: string }[] = []
  function intercept(fail: boolean) {
    const transport: import('@glows777/vela-lark').LarkTransport =
      h.fake.transport
    const reply = transport.reply.bind(transport)
    transport.reply = async (anchor, text, uuid) => {
      if (text.includes('Moved this session')) {
        attempts.push({ anchor, text, uuid })
        if (fail) throw Error('fixture lost receipt')
      }
      return reply(anchor, text, uuid)
    }
  }
  try {
    await h.start()
    await h.input(false, 'seed')
    await h.vela.dispose()
    h = host(dir.path, 'blue', resolve)
    intercept(true)
    await h.start()
    const s = await h.input(false, 'move')
    expect(s.location.environment).toBe('blue')
    await h.vela.dispose()
    h = host(dir.path, 'blue', resolve)
    intercept(false)
    await h.start()
    await drainChannels(h.vela)
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toEqual(attempts[0])
    expect(attempts[0]!.uuid).toBeString()
    expect(h.model.calls).toHaveLength(0)
    await h.input(false, 'later')
    expect(attempts).toHaveLength(2)
  } finally {
    await h.vela.dispose()
    dir.cleanup()
  }
})
