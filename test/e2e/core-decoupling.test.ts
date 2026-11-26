import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '@glows777/vela/testing'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import { background } from '../../packages/vela/src/driver/extensions/background/index.ts'
import type { InternalSessionOptions } from '../../packages/vela/src/driver/session/options.ts'
import { sessionScope } from '../../packages/vela/src/driver/session/routing.ts'
import { getToolContextScope } from '../../packages/vela/src/driver/session/scope.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../packages/vela/src/testing/core/index.ts'
import {
  createVela,
  type Vela,
  type VelaOptions,
} from '../support/compat-vela.ts'

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

test('first routing binding preserves a preopened session and its cwd and tools', async () => {
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
              scope: getToolContextScope(context),
            })
            return 'observed'
          },
        })
        api.on('before_agent_start', (_event, ctx) => {
          observed.push(sessionScope(ctx.session))
        })
      },
    ],
  })
  mkdirSync(join(cwd, 'original'))
  writeFileSync(join(cwd, 'original', 'a.txt'), 'original')
  const session = vela.session('fake-chat', {
    cwd: 'original',
    tools: ['probe_scope'],
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
  } as InternalSessionOptions)
  expect(bound).toBe(session)
  expect(session.cwd).toBe(join(cwd, 'original'))
  expect(sessionScope(session)).toEqual(scope)
  expect(session.channel).toBe('fake')
  expect(session.getActiveTools()).toEqual(['probe_scope'])
  expect(
    vela.session(session.id, {
      scope: { ...scope },
      channel: 'fake',
    } as InternalSessionOptions),
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
  } as InternalSessionOptions)
  let error: unknown
  try {
    vela.session(session.id, {
      scope: second,
      channel: 'fake',
    } as InternalSessionOptions)
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).name).toBe('SessionRoutingConflictError')
  for (const text of [session.id, first.id, second.id])
    expect((error as Error).message).toContain(text)
  expect(sessionScope(session)).toEqual(first)
})

test('a real channel logs a conflicting route once without retrying or calling the model', async () => {
  const errors: string[] = []
  let deliver!: (
    message: import('../../packages/vela/src/legacy-channels/types.ts').IncomingMessage,
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
  } as InternalSessionOptions)
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
  const delivered: string[] = []
  const model = createFauxModel({
    responses: [
      fauxText('saved'),
      fauxToolCall('bash', {
        command: 'echo COPY_ONLY',
        run_in_background: true,
      }),
      fauxText('started in the copy'),
      fauxText('the copy’s own delivery turn'),
    ],
  })
  const { vela, cwd } = setup({ model, extensions: [background()] })
  const source = vela.session('source', {
    scope: { id: 'group', kind: 'shared', dataDir: join(cwd, 'group') },
    channel: 'fake',
    tools: ['bash', 'background_stop'],
    host: {
      deliver: (text: string) => {
        delivered.push(text)
      },
    },
  } as InternalSessionOptions)
  expect(sessionScope(source)?.id).toBe('group')
  await source.prompt('hello')
  const clone = (await source.clone({ sessionId: 'copy' })).session!
  const user = source
    .getEntries()
    .find((entry) => entry.type === 'message' && entry.message.role === 'user')!
  const fork = (await source.fork(user.id, { sessionId: 'branch' })).session!
  // The copy has no topic of its own, so its command's exit must start a turn here rather than
  // arriving in the source's channel queue.
  await clone.prompt('start a check')
  const before = model.calls.length
  const deadline = Date.now() + 5000
  while (
    model.calls.length === before &&
    delivered.length === 0 &&
    Date.now() < deadline
  )
    await Bun.sleep(20)
  expect(delivered).toEqual([])
  expect(model.calls.length).toBeGreaterThan(before)
  for (const child of [clone, fork]) {
    expect(sessionScope(child)).toBeUndefined()
    expect(child.channel).toBeUndefined()
    expect(child.host).toBeUndefined()
  }
})

test('storage success observers cannot turn committed batches into duplicate history', async () => {
  const db = openDatabase({ path: ':memory:' })
  const errors: string[] = []
  let saved = 0
  const { vela } = setup({
    model: createFauxModel({ responses: [fauxText('saved')] }),
    db,
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
  try {
    const session = vela.session('observer')
    await session.prompt('write once')
    expect(saved).toBeGreaterThan(0)
    const msgCount = () =>
      db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM vela_messages WHERE session_id = ?',
        session.id,
      )!.c
    const before = msgCount()
    const count = saved
    await session.save()
    await session.save()
    expect(msgCount()).toBe(before)
    expect(saved).toBe(count)
    expect(
      db.all<{ id: string }>(
        'SELECT id FROM sessions WHERE id = ?',
        session.id,
      ),
    ).toHaveLength(1)
    expect(errors.join('\n')).toContain('observer failed')
  } finally {
    db.close()
  }
})

test('explicit save failure rejects while retaining the live session', async () => {
  const db = openDatabase({ path: ':memory:' })
  const { vela } = setup({
    model: createFauxModel({ responses: [fauxText('saved')] }),
    db,
  })
  try {
    const session = vela.session('save')
    await session.prompt('start')
    db.exec(`
      CREATE TRIGGER block_pending_write BEFORE INSERT ON vela_messages
      WHEN NEW.kind = 'custom' AND NEW.content_json LIKE '%"pending"%'
      BEGIN
        SELECT RAISE(ABORT, 'storage unavailable');
      END;
    `)
    expect(() => session.appendEntry('pending', { retain: true })).toThrow(
      'storage unavailable',
    )
    expect(vela.sessions()).toContain(session)
    db.exec('DROP TRIGGER block_pending_write;')
    session.appendEntry('pending', { retain: true })
    await session.save()
  } finally {
    db.close()
  }
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
