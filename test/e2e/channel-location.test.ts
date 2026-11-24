import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVela, type VelaOptions } from '@glows777/vela'
import { createFauxModel, fauxText, tempDir } from '@glows777/vela/testing'
import { ownerDocker } from '../../packages/vela/src/cli/docker.ts'
import {
  cliHostExtensionConfig,
  cliProjectExtensions,
} from '../../packages/vela/src/cli/project-extensions.ts'
import {
  BUILTIN_EXTENSIONS,
  parseArgs,
} from '../../packages/vela/src/cli/setup.ts'
import { createLocalExecutionEnv } from '../../packages/vela/src/driver/index.ts'
import { lark } from '../../packages/vela/src/lark/index.ts'
import { drainChannels } from '../../packages/vela/src/legacy-channels/testing.ts'
import { loadConfig } from '../../packages/vela/src/load-config.ts'
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
        join(path, 'config.json'),
        JSON.stringify({
          dataDir,
          ...(path === project
            ? { location: { environment: 'red', cwd: '/workspace' } }
            : {}),
          environments: { blue: { image: path } },
          lark: { chats },
        }),
      )
    const config = loadConfig({
      cwd: join(dir.path, 'project'),
      agentDir: owner,
      trusted: true,
    })
    expect(cliHostExtensionConfig(config, parseArgs([])).lark?.chats).toEqual([
      { id: 'group', environment: 'blue' },
    ])
    expect(config.settings).toHaveProperty('environments.blue.image', owner)
    expect(config.settings).not.toHaveProperty('location')
    expect(config.dataDir).toBe(join(dir.path, 'project/owner-data'))
  } finally {
    dir.cleanup()
  }
})

test('owner Docker credential settings are refused before engine access with safe diagnostics', async () => {
  const dir = tempDir()
  const key = 'INVALID_VELA_OWNER_CREDENTIAL_TEST'
  const before = process.env[key]
  try {
    const path = join(dir.path, 'config.json')
    const origins = ['https://github.com']
    const literal = 'synthetic-do-not-print'
    process.env[key] = `${literal}\nother-line`
    const cases = [
      [
        {
          network: 'off',
          credentials: {
            GH_TOKEN: { value: '$MISSING_VELA_OWNER_TEST', origins },
          },
        },
        /credentials.*network.*off/i,
      ],
      [
        { credentials: { GH_TOKEN: { value: literal, origins } } },
        /host environment variable reference/i,
      ],
      [
        {
          credentials: {
            GH_TOKEN: { value: '$MISSING_VELA_OWNER_TEST', origins },
          },
        },
        /MISSING_VELA_OWNER_TEST.*(unset|empty|missing)/i,
      ],
      [
        { credentials: { GH_TOKEN: { value: `$${key}`, origins } } },
        /INVALID_VELA_OWNER_CREDENTIAL_TEST.*invalid header characters/i,
      ],
    ] as const
    for (const [entry, diagnostic] of cases) {
      writeFileSync(
        path,
        JSON.stringify({
          environments: { test: { image: 'node:22-bookworm', ...entry } },
        }),
      )
      const config = loadConfig({
        cwd: dir.path,
        agentDir: dir.path,
        trusted: true,
      })
      const host = ownerDocker(config)
      expect(host).toBeDefined()
      try {
        await host!.env({
          sessionId: 'credentials-settings',
          location: { environment: 'test', cwd: '/workspace' },
        })
        throw Error('expected owner configuration rejection')
      } catch (failure) {
        expect(String(failure)).toMatch(diagnostic)
        expect(String(failure)).not.toContain(literal)
      } finally {
        await host?.beforeDispose()
      }
    }
  } finally {
    if (before === undefined) delete process.env[key]
    else process.env[key] = before
    dir.cleanup()
  }
})

function host(
  dataDir: string,
  environment?: string,
  env?: VelaOptions['env'],
  extra?: Pick<VelaOptions, 'logger' | 'sessionResources'>,
) {
  const fake = fakeLark()
  const model = createFauxModel({ cache: true })
  const vela = createVela({
    ...extra,
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
    const diagnostic = 'ENOENT /synthetic/operator/install/guest.cjs'
    const logs: string[] = []
    h = host(
      dir.path,
      'missing',
      ({ location }) => {
        if (location.environment === 'local')
          return createLocalExecutionEnv({ cwd: location.cwd })
        throw Error(diagnostic)
      },
      {
        logger: {
          debug() {},
          info() {},
          warn() {},
          error: (m) => logs.push(m),
        },
      },
    )
    await h.start()
    await h.input(false, 'unavailable').catch(() => {})
    expect(h.model.calls).toHaveLength(0)
    expect(logs.some((m) => m.includes(diagnostic))).toBe(true)
    const feedback = h.fake.sent.map((m) => m.text).join(' ')
    expect(feedback).not.toContain('/synthetic/operator')
    expect(feedback).toMatch(/workspace.*operator/i)
    expect(h.vela.session(local.id).location).toEqual(local.location)
    expect(h.replies.some((text) => text.includes('Moved'))).toBe(false)
  } finally {
    await h.vela.dispose()
    dir.cleanup()
  }
})

test.each([false, true])(
  'tracked work holds a hub migration until idle or Stop (stop=%s)',
  async (stop) => {
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
      const waiting = () => h.replies.filter((text) => text.includes('Waiting'))
      for (let n = 0; n < 100 && !waiting().length; n++) await Bun.sleep(10)
      expect(waiting()).toHaveLength(1)
      expect(waiting()[0]).toMatch(/work.*blue.*Stop/i)
      const second = stop ? undefined : h.input(false, 'second-in-line')
      await Bun.sleep(125)
      expect(waiting()).toHaveLength(1)
      expect(g.count()).toBe(0)
      expect(h.model.calls).toHaveLength(0)
      if (stop) {
        const channel = h.vela.channel('lark')
        const runId = channel.sessions('oc_group')[0]!.runId!
        expect(await channel.stop({ chatId: 'oc_group' }, runId)).toBe(true)
        expect(
          await Promise.race([
            next.then(() => true),
            Bun.sleep(500).then(() => false),
          ]),
        ).toBe(true)
        expect(active.location).toEqual(initial.location)
        expect(h.model.calls).toHaveLength(0)
        expect(g.count()).toBe(0)
        expect(h.replies.some((text) => text.includes('Moved'))).toBe(false)
        return
      }
      job.resolve()
      await Promise.all([next, second])
      expect(active.location.environment).toBe('blue')
      expect(h.replies.filter((text) => text.includes('Moved'))).toHaveLength(1)
      expect(waiting()).toHaveLength(1)
      expect(h.model.calls.map((call) => call.lastUserText)).toEqual([
        expect.stringContaining('while-busy'),
        expect.stringContaining('second-in-line'),
      ])
    } finally {
      job.resolve()
      await h.vela.dispose()
      dir.cleanup()
    }
  },
)

test.each([false, true])(
  'restart settles a lost migration-notice receipt using its original Lark identity (expired=%s)',
  async (expired) => {
    const dir = tempDir(),
      g = guest(false)
    const resolve: VelaOptions['env'] = ({ location }) =>
      location.environment === 'local'
        ? createLocalExecutionEnv({ cwd: location.cwd })
        : g.backend
    let h = host(dir.path)
    const attempts: { anchor: string; text: string; uuid?: string }[] = []
    function intercept(fail: boolean) {
      const transport: import('../../packages/vela/src/lark/index.ts').LarkTransport =
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
      if (expired) {
        const path = join(dir.path, 'sessions', s.id, 'transcript.jsonl')
        const lines = readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        const intent = lines.find(
          (e) =>
            e.customType === 'channel.lark_delivery' &&
            e.data?.identity?.startsWith('move:'),
        )
        expect(intent).toBeDefined()
        intent.data.startedAt -= 2 * 60 * 60 * 1000
        writeFileSync(
          path,
          lines.map((e) => JSON.stringify(e)).join('\n') + '\n',
        )
      }
      h = host(dir.path, 'blue', resolve)
      intercept(false)
      await h.start()
      await drainChannels(h.vela)
      expect(attempts).toHaveLength(expired ? 1 : 2)
      if (!expired) expect(attempts[1]).toEqual(attempts[0])
      const index = JSON.parse(
        readFileSync(join(dir.path, 'channels/index.json'), 'utf8'),
      )
      expect(index.records[0].locationNotice).toBeUndefined()
      expect(attempts[0]!.uuid).toBeString()
      expect(h.model.calls).toHaveLength(0)
      await h.input(false, 'later')
      expect(attempts).toHaveLength(expired ? 1 : 2)
    } finally {
      await h.vela.dispose()
      dir.cleanup()
    }
  },
)

test('a migrated group retains eligible CLI built-ins and their warm tool prefix', async () => {
  const dir = tempDir(),
    g = guest(true),
    reports: string[] = []
  const config = loadConfig({
    cwd: dir.path,
    agentDir: join(dir.path, 'owner'),
    env: {},
    builtins: Object.keys(BUILTIN_EXTENSIONS),
  })
  const resources = {
    ...config.sessionResources!,
    projectExtensions: cliProjectExtensions(config, parseArgs([]), (m) =>
      reports.push(m),
    ),
  }
  let h = host(dir.path, undefined, undefined, { sessionResources: resources })
  try {
    await h.start()
    const local = await h.input(false, 'seed')
    const names = ['background_output', 'background_stop', 'web_fetch', 'todo']
    expect(local.registry.getAllTools().map((t) => t.name)).toEqual(
      expect.arrayContaining(names),
    )
    await h.vela.dispose()
    h = host(
      dir.path,
      'blue',
      ({ location }) =>
        location.environment === 'local'
          ? createLocalExecutionEnv({ cwd: location.cwd })
          : g.backend,
      { sessionResources: resources },
    )
    await h.start()
    const moved = await h.input(false, 'move')
    expect(moved.registry.getAllTools().map((t) => t.name)).toEqual(
      expect.arrayContaining(names),
    )
    expect(
      reports.some((m) => m.includes('Skipped project extensions and MCP')),
    ).toBe(true)
    const calls = g.count()
    await h.input(false, 'again')
    expect(g.count()).toBe(calls)
    expect(h.model.calls[1]!.tools).toEqual(h.model.calls[0]!.tools)
    expect(h.model.calls[1]!.system).toBe(h.model.calls[0]!.system)
  } finally {
    await h.vela.dispose()
    dir.cleanup()
  }
})

test('first admission keeps an operator installation diagnostic out of the group', async () => {
  const dir = tempDir(),
    logs: string[] = []
  const diagnostic = 'ENOENT /synthetic/owner/private/install/guest.cjs'
  const h = host(
    dir.path,
    'blue',
    () => {
      throw Error(diagnostic)
    },
    {
      logger: { debug() {}, info() {}, warn() {}, error: (m) => logs.push(m) },
    },
  )
  try {
    await h.start()
    await h.input(false, 'first')
    const reply = h.fake.sent.map((m) => m.text).join(' ')
    expect(reply).not.toContain('/synthetic/owner')
    expect(reply).toMatch(/workspace.*operator/i)
    expect(logs.some((m) => m.includes(diagnostic))).toBe(true)
    expect(h.model.calls).toHaveLength(0)
  } finally {
    await h.vela.dispose()
    dir.cleanup()
  }
})

test('Stop after resume clears a waiting migration notice while existing work stays active', async () => {
  const dir = tempDir(),
    g = guest(false),
    job = Promise.withResolvers<void>()
  let h = host(dir.path)
  try {
    await h.start()
    const source = await h.input(false, 'seed')
    await h.vela.dispose()
    h = host(dir.path, 'blue', ({ location }) =>
      location.environment === 'local'
        ? createLocalExecutionEnv({ cwd: location.cwd })
        : g.backend,
    )
    await h.start()
    const active = h.vela.session(source.id, { location: source.location })
    h.vela.subscribe((e) => {
      if (e.type === 'channel_message') active.trackWork(job.promise)
    })
    const queued = h.input(false, 'held')
    const index = join(dir.path, 'channels/index.json')
    const notice = () =>
      JSON.parse(readFileSync(index, 'utf8')).records[0].locationNotice
    for (let n = 0; n < 150 && !notice(); n++) await Bun.sleep(10)
    expect(notice()).toBeDefined()
    for (
      let n = 0;
      n < 100 && !h.replies.some((text) => text.includes('Waiting'));
      n++
    )
      await Bun.sleep(10)
    expect(
      h.replies.filter((text) => /work.*blue.*Stop/i.test(text)),
    ).toHaveLength(1)
    const channel = h.vela.channel('lark'),
      run = channel.sessions('oc_group')[0]!.runId!
    expect(await channel.stop({ chatId: 'oc_group' }, run)).toBe(true)
    expect(
      await Promise.race([
        queued.then(() => true),
        Bun.sleep(600).then(() => false),
      ]),
    ).toBe(true)
    expect(notice()).toBeUndefined()
    expect(active.location).toEqual(source.location)
    expect(h.model.calls).toHaveLength(0)
    expect(g.count()).toBe(0)
  } finally {
    job.resolve()
    await h.vela.dispose()
    dir.cleanup()
  }
})
