import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { memorySessionStorage } from '../../src/session/storage.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux.ts'
import { tempDir } from '../../src/testing/test-vela.ts'
import { createVela, type Vela, type VelaOptions } from '../../src/vela.ts'

const opened: { vela: Vela; cleanup(): void }[] = []
afterEach(async () => {
  for (const { vela, cleanup } of opened.splice(0)) {
    await vela.dispose().catch(() => {})
    cleanup()
  }
})

function setup(options: VelaOptions = {}) {
  const dir = tempDir('vela-decoupling-')
  const vela = createVela({ cwd: dir.path, contextFiles: false, ...options })
  opened.push({ vela, cleanup: dir.cleanup })
  return { vela, cwd: dir.path }
}

test('first routing binding preserves a preopened session and its cwd, tools and permissions', async () => {
  const observed: unknown[] = []
  const model = createFauxModel({
    responses: [fauxToolCall('probe_scope', {}), fauxText('bound')],
  })
  const { vela, cwd } = setup({
    model,
    extensions: [
      function probe(api) {
        api.registerTool({
          name: 'scope',
          description: 'observe scope',
          channel: 'fake',
          inputSchema: z.object({}),
          async execute(_input, context) {
            observed.push({
              sessionId: context?.sessionId,
              scope: context?.scope,
            })
            return 'observed'
          },
        })
        api.on('before_agent_start', (_event, ctx) => {
          observed.push(ctx.session.scope)
        })
      },
    ],
  })
  mkdirSync(join(cwd, 'original'))
  writeFileSync(join(cwd, 'original', 'a.txt'), 'original')
  const session = vela.session('fake-chat', {
    cwd: 'original',
    tools: ['probe_scope', 'read_file'],
    permissions: { read_file: 'deny' },
  })
  const scope = {
    id: 'group-one',
    kind: 'shared' as const,
    dataDir: join(cwd, 'group-one'),
  }
  const bound = vela.session(session.id, {
    scope,
    channel: 'fake',
    cwd: 'ignored',
    tools: ['bash'],
    permissions: { read_file: 'allow', probe_scope: 'deny' },
  })
  expect(bound).toBe(session)
  expect(session.cwd).toBe(join(cwd, 'original'))
  expect(session.scope).toEqual(scope)
  expect(session.channel).toBe('fake')
  expect(session.getActiveTools()).toEqual(['probe_scope'])
  expect(session.toolDecision('read_file')).toBe('deny')
  expect(
    vela.session(session.id, { scope: { ...scope }, channel: 'fake' }),
  ).toBe(session)
  await session.prompt('observe routing')
  expect(observed).toEqual([scope, { sessionId: session.id, scope }])
  expect(model.pending()).toBe(0)
})

test('conflicting routing names the session and both routes without changing its binding', () => {
  const { vela, cwd } = setup()
  const first = {
    id: 'group-one',
    kind: 'shared' as const,
    dataDir: join(cwd, 'one'),
  }
  const second = {
    id: 'group-two',
    kind: 'shared' as const,
    dataDir: join(cwd, 'two'),
  }
  const session = vela.session('same-session', {
    scope: first,
    channel: 'fake',
  })
  let error: unknown
  try {
    vela.session(session.id, { scope: second, channel: 'fake' })
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).name).toBe('SessionRoutingConflictError')
  for (const text of [session.id, first.id, second.id])
    expect((error as Error).message).toContain(text)
  expect(session.scope).toEqual(first)
})

test('a real channel logs a conflicting route once without retrying or calling the model', async () => {
  const errors: string[] = []
  let deliver!: (
    message: import('../../src/channels/types.ts').IncomingMessage,
  ) => void | Promise<void>
  const model = createFauxModel({ responses: [] })
  const { vela, cwd } = setup({
    model,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error(message) {
        errors.push(message)
      },
    },
    extensions: [
      function platform(api) {
        api.registerChannel({
          name: 'fake',
          description: 'conflict probe',
          start() {},
          stop() {},
          async send() {},
          onMessage(handler) {
            deliver = handler
          },
        })
      },
    ],
  })
  vela.session('fake-c1', {
    channel: 'fake',
    scope: { id: 'wrong-group', kind: 'shared', dataDir: join(cwd, 'wrong') },
  })
  await vela.startChannels()
  await deliver({
    channelId: 'c1',
    senderId: 'owner',
    senderName: 'Owner',
    text: 'do not retry',
  })
  expect(model.calls).toHaveLength(0)
  const conflicts = errors.filter((message) =>
    message.includes('SessionRoutingConflictError'),
  )
  expect(conflicts).toHaveLength(1)
  expect(conflicts[0]).toContain('fake-c1')
  expect(conflicts[0]).toContain('wrong-group')
})

test('clone and fork retain history without inheriting routing authority', async () => {
  const { vela, cwd } = setup({
    model: createFauxModel({ responses: [fauxText('saved')] }),
  })
  const source = vela.session('source', {
    scope: { id: 'group', kind: 'shared', dataDir: join(cwd, 'group') },
    channel: 'fake',
  })
  expect(source.scope?.id).toBe('group')
  await source.prompt('hello')
  const clone = (await source.clone({ sessionId: 'copy' })).session!
  const user = source
    .getEntries()
    .find((entry) => entry.type === 'message' && entry.message.role === 'user')!
  const fork = (await source.fork(user.id, { sessionId: 'branch' })).session!
  for (const child of [clone, fork]) {
    expect(child.scope).toBeUndefined()
    expect(child.channel).toBeUndefined()
  }
})

test('storage success observers cannot turn committed batches into duplicate history', async () => {
  const storage = memorySessionStorage()
  const errors: string[] = []
  let saved = 0
  const { vela } = setup({
    model: createFauxModel({ responses: [fauxText('saved')] }),
    sessionStorage: storage,
    onSessionSaved() {
      saved++
      throw new Error('observer failed')
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error(message) {
        errors.push(message)
      },
    },
  })
  const session = vela.session('observer')
  await session.prompt('write once')
  expect(saved).toBeGreaterThan(0)
  const before = await storage.load(session.id)
  const count = saved
  await session.save()
  await session.save()
  expect(await storage.load(session.id)).toEqual(before)
  expect(saved).toBe(count)
  expect(before?.filter((entry) => entry.type === 'session')).toHaveLength(1)
  expect(errors.join('\n')).toContain('observer failed')
})

test('explicit save reports a failure only when requested and retains the live session', async () => {
  const storage = memorySessionStorage()
  let broken = false
  const { vela } = setup({
    model: createFauxModel({ responses: [fauxText('saved')] }),
    sessionStorage: {
      ...storage,
      async append(id, entries) {
        if (broken) throw new Error('storage unavailable')
        await storage.append(id, entries)
      },
    },
  })
  const session = vela.session('save')
  await session.prompt('start')
  broken = true
  session.appendEntry('pending', { retain: true })
  const failures: unknown[] = []
  session.subscribe((event) => {
    if (event.type === 'session_save_failed') failures.push(event.error)
  })
  await expect(session.save()).rejects.toThrow('storage unavailable')
  expect(failures).toHaveLength(0)
  await expect(session.save({ reportFailure: true })).rejects.toThrow(
    'storage unavailable',
  )
  expect(failures).toHaveLength(1)
  expect(vela.sessions()).toContain(session)
  broken = false
  await session.save()
})

test('beforeDispose precedes session/shared shutdown and failure does not skip either', async () => {
  const order: string[] = []
  const { vela } = setup({
    model: createFauxModel({ responses: [fauxText('ok')] }),
    beforeDispose() {
      order.push('before')
      throw new Error('before failed')
    },
    extensions: [
      function lifecycle(api) {
        api.on('session_shutdown', () => {
          order.push('session')
        })
        api.onShutdown(() => {
          order.push('shared')
        })
      },
    ],
  })
  await vela.session('lifecycle').prompt('open')
  const disposing = vela.dispose()
  expect(vela.dispose()).toBe(disposing)
  await expect(disposing).rejects.toThrow('Vela disposal failed')
  expect(order).toEqual(['before', 'session', 'shared'])
  expect(vela.sessions()).toEqual([])
})

import { z } from 'zod'
