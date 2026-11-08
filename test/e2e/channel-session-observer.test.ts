import { afterEach, expect, test } from 'bun:test'
import type {
  ChannelDefinition,
  ChannelRuntime,
  ChannelSessionUpdate,
} from '@glows777/vela-channels'
import { drainChannels } from '@glows777/vela-channels/testing'
import { fauxHang, fauxText } from '@glows777/vela-core/testing'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

function adapter(name: string, extra: Partial<ChannelDefinition> = {}) {
  let runtime!: ChannelRuntime
  return {
    channel: {
      name,
      description: name,
      start() {},
      stop() {},
      async send() {},
      connect(value) {
        runtime = value
      },
      ...extra,
    } satisfies ChannelDefinition,
    get runtime() {
      return runtime
    },
  }
}
const message = {
  channelId: 'chat',
  senderId: 'owner',
  senderName: 'Owner',
  text: 'hello',
  chatKind: 'direct' as const,
}

test('session observer exposes cancellable preparation and exact stopped lifetime without model events', async () => {
  let entered!: () => void
  const preparing = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = adapter('observer', {
    async prepareMessage(msg) {
      entered()
      await gate
      return msg
    },
  })
  const t = createTestVela({
    responses: [],
    extensions: [(api) => api.registerChannel(f.channel)],
  })
  await t.vela.startChannels()
  const updates: ChannelSessionUpdate[] = []
  f.runtime.onSession((update) => updates.push(update))
  await f.runtime.submit(message)
  await preparing
  const start = updates.find((update) => update.run?.type === 'started')!
  expect(start).toBeDefined()
  expect(start.session.runId).toBe(start.run!.runId)
  expect(await f.runtime.stop({ chatId: 'chat' }, start.run!.runId)).toBe(true)
  release()
  await drainChannels(t.vela)
  expect(
    updates.filter((update) => update.run).map((update) => update.run),
  ).toEqual([
    { type: 'started', runId: start.run!.runId },
    { type: 'finished', runId: start.run!.runId, outcome: 'stopped' },
  ])
  expect(updates.at(-1)?.session.state).toBe('stopped')
  expect(t.model.calls).toHaveLength(0)
})

test('session observers isolate channels, copies, failures and unsubscribe; preparation failure ends failed', async () => {
  const a = adapter('observer', {
    async prepareMessage() {
      throw new Error('preparation failed')
    },
  })
  const b = adapter('other')
  const t = createTestVela({
    responses: [],
    extensions: [
      (api) => {
        api.registerChannel(a.channel)
        api.registerChannel(b.channel)
      },
    ],
  })
  await t.vela.startChannels()
  const updates: ChannelSessionUpdate[] = []
  let other = 0
  b.runtime.onSession(() => {
    other++
  })
  a.runtime.onSession((update) => {
    update.session.requester.name = 'mutated'
    throw new Error('listener failed')
  })
  const off = a.runtime.onSession((update) => updates.push(update))
  await a.runtime.submit(message)
  await drainChannels(t.vela)
  expect(
    updates.find((update) => update.run?.type === 'finished')?.run,
  ).toMatchObject({ outcome: 'failed' })
  expect(
    updates.every((update) => update.session.requester.name === 'Owner'),
  ).toBe(true)
  expect(other).toBe(0)
  const count = updates.length
  off()
  await a.runtime.submit(message)
  await drainChannels(t.vela)
  expect(updates).toHaveLength(count)
})

test('queued successors have separate ordered lifetimes and final queue release', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const preparing = new Promise<void>((resolve) => {
    entered = resolve
  })
  const f = adapter('observer', {
    async prepareMessage(msg) {
      if (msg.text === 'first') {
        entered()
        await gate
      }
      return msg
    },
  })
  const t = createTestVela({
    responses: [fauxText('first answer'), fauxText('second answer')],
    extensions: [(api) => api.registerChannel(f.channel)],
  })
  await t.vela.startChannels()
  const updates: ChannelSessionUpdate[] = []
  f.runtime.onSession((update) => updates.push(update))
  await f.runtime.submit({ ...message, text: 'first' })
  await preparing
  await f.runtime.submit({ ...message, text: 'second' })
  release()
  await drainChannels(t.vela)
  const runs = updates.flatMap((update) => (update.run ? [update.run] : []))
  expect(runs.map((run) => run.type)).toEqual([
    'started',
    'finished',
    'started',
    'finished',
  ])
  expect(runs[0]!.runId).toBe(runs[1]!.runId)
  expect(runs[2]!.runId).toBe(runs[3]!.runId)
  expect(runs[0]!.runId).not.toBe(runs[2]!.runId)
  expect(updates.at(-1)?.session).toMatchObject({
    state: 'done',
    runId: undefined,
  })
})

test('gateway dispatch finishes its source before the transferred task finishes', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const preparing = new Promise<void>((resolve) => {
    entered = resolve
  })
  const f = adapter('observer', {
    async prepareMessage(msg) {
      if (msg.topic) {
        entered()
        await gate
      }
      return msg
    },
  })
  const t = createTestVela({
    responses: [
      () => {
        f.runtime.dispatch(
          'observer-chat',
          { ...message, topic: { rootId: 'task', threadId: 'task' } },
          'task',
        )
        return fauxText('dispatched')
      },
      fauxText('task done'),
    ],
    extensions: [(api) => api.registerChannel(f.channel)],
  })
  await t.vela.startChannels()
  const updates: ChannelSessionUpdate[] = []
  let sourceFinished!: () => void
  const finished = new Promise<void>((resolve) => {
    sourceFinished = resolve
  })
  f.runtime.onSession((update) => {
    updates.push(update)
    if (
      update.session.sessionId === 'observer-chat' &&
      update.run?.type === 'finished'
    )
      sourceFinished()
  })
  await f.runtime.submit(message)
  try {
    await Promise.all([preparing, finished])
    expect(
      updates.find(
        (update) =>
          update.session.sessionId === 'observer-chat' &&
          update.run?.type === 'finished',
      )?.run,
    ).toMatchObject({ outcome: 'done' })
    expect(
      updates.filter(
        (update) => update.session.topic && update.run?.type === 'finished',
      ),
    ).toHaveLength(0)
  } finally {
    release()
  }
  await drainChannels(t.vela)
})

test('waiting is published after queue release and passive silence keeps its outcome', async () => {
  const f = adapter('observer')
  const t = createTestVela({
    responses: [
      () => {
        void f.runtime.waitForInput('observer-chat-task', 'Need a choice')
        return fauxText('Which one?')
      },
      () => {
        f.runtime.skipReply('observer-chat')
        return fauxText('')
      },
    ],
    extensions: [(api) => api.registerChannel(f.channel)],
  })
  await t.vela.startChannels()
  const updates: ChannelSessionUpdate[] = []
  f.runtime.onSession((update) => updates.push(update))
  await f.runtime.submit({
    ...message,
    topic: { rootId: 'task', threadId: 'task' },
  })
  await drainChannels(t.vela)
  expect(updates.at(-1)?.session).toMatchObject({
    state: 'waiting',
    waitingReason: 'Need a choice',
    runId: undefined,
  })
  await f.runtime.submit({ ...message, chatKind: 'group', passive: true })
  await drainChannels(t.vela)
  expect(
    updates.findLast((update) => update.run?.type === 'finished')?.run,
  ).toMatchObject({ outcome: 'silent' })
})

test('automatic topic steering shares one observed run lifetime', async () => {
  let steered!: () => void
  const steering = new Promise<void>((resolve) => {
    steered = resolve
  })
  const f = adapter('observer', {
    prepareMessage(msg) {
      if (msg.text === 'steer') steered()
      return Promise.resolve(msg)
    },
  })
  const t = createTestVela({
    responses: [fauxHang()],
    extensions: [(api) => api.registerChannel(f.channel)],
  })
  await t.vela.startChannels()
  const updates: ChannelSessionUpdate[] = []
  f.runtime.onSession((update) => updates.push(update))
  const topic = { rootId: 'task', threadId: 'task' }
  await f.runtime.submit({ ...message, topic })
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 2000
    while (!check()) {
      if (Date.now() > deadline) throw new Error('Steer did not settle')
      await Bun.sleep(1)
    }
  }
  await until(() => t.model.calls.length === 1)
  await f.runtime.submit({ ...message, text: 'steer', topic })
  await steering
  const started = updates.find((update) => update.run?.type === 'started')!.run!
  expect(
    await f.runtime.stop({ chatId: 'chat', rootId: 'task' }, started.runId),
  ).toBe(true)
  await drainChannels(t.vela)
  expect(
    updates.flatMap((update) => (update.run ? [update.run.type] : [])),
  ).toEqual(['started', 'finished'])
})
