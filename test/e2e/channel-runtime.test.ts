import { afterEach, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ChannelDefinition,
  ChannelRuntime,
  IncomingMessage,
  OutgoingMessage,
} from '@glows777/vela-channels'
import { channelSessionId } from '@glows777/vela-channels'
import { drainChannels } from '@glows777/vela-channels/testing'
import { memorySessionStorage } from '@glows777/vela-core'
import { fauxHang, fauxText } from '@glows777/vela-core/testing'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Channel runtime did not settle')
    await Bun.sleep(1)
  }
}

function adapter(name = 'fixture', options: Partial<ChannelDefinition> = {}) {
  let runtime!: ChannelRuntime
  let receive!: (message: IncomingMessage) => void | Promise<void>
  const sent: OutgoingMessage[] = []
  const channel: ChannelDefinition = {
    name,
    description: 'A transport using the public channel runtime',
    start() {},
    stop() {},
    async send(message) {
      sent.push(message)
    },
    connect(value) {
      runtime = value
    },
    onMessage(handler) {
      receive = handler
    },
    ...options,
  }
  return {
    channel,
    sent,
    get runtime() {
      return runtime
    },
    deliver: (message: IncomingMessage) => receive(message),
  }
}

const input = (
  text: string,
  rest: Partial<IncomingMessage> = {},
): IncomingMessage => ({
  channelId: 'project',
  senderId: 'owner',
  senderName: 'Owner',
  text,
  chatKind: 'group',
  ...rest,
})

test('explicit conversation kind survives reopening without a service reply identity', async () => {
  const f = adapter()
  const first = createTestVela({
    responses: [fauxText('group answer'), fauxText('direct answer')],
    extensions: [(api) => api.registerChannel(f.channel)],
  })
  await first.vela.startChannels()
  await f.deliver(input('group'))
  await f.deliver(
    input('direct', {
      channelId: 'direct',
      chatKind: 'direct',
      replyToId: 'service-id',
    }),
  )
  expect(
    f.runtime.scope(channelSessionId('fixture', 'project'))?.chatKind,
  ).toBe('group')
  expect(f.runtime.scope(channelSessionId('fixture', 'direct'))?.chatKind).toBe(
    'direct',
  )
  await first.cleanup({ keepDir: true })
  const restored = adapter()
  const second = createTestVela({
    cwd: first.cwd,
    responses: [fauxText('continued')],
    extensions: [(api) => api.registerChannel(restored.channel)],
  })
  try {
    await second.vela.startChannels()
    await restored.deliver(input('continue'))
    expect(
      restored.runtime.scope(channelSessionId('fixture', 'project'))?.chatKind,
    ).toBe('group')
  } finally {
    await second.cleanup()
    await rm(first.cwd, { recursive: true, force: true })
  }
})

test('submit acknowledges persisted admission before preparation or a reply completes', async () => {
  const held = latch()
  const entered = latch()
  const f = adapter('fixture', {
    async prepareMessage(message) {
      entered.release()
      await held.promise
      return message
    },
  })
  const t = createTestVela({
    responses: [fauxText('answer')],
    extensions: [(api) => api.registerChannel(f.channel)],
  })
  await t.vela.startChannels()
  try {
    const receipt = await f.runtime.submit(
      input('question', { replyToId: 'm1' }),
    )
    expect(receipt).toEqual({ sessionId: 'fixture-project' })
    await entered.promise
    expect(
      JSON.parse(await t.readData('channels/index.json')).records[0]
        .pendingMessageIds,
    ).toContain('m1')
    expect(t.model.calls).toHaveLength(0)
    expect(f.sent).toHaveLength(0)
  } finally {
    held.release()
  }
  await drainChannels(t.vela)
  expect(f.sent.map((message) => message.text)).toEqual(['answer'])
})

test('submit rejects unavailable scope and failed storage instead of claiming admission', async () => {
  const f = adapter('fixture', {
    canRecover: (message) => message.channelId !== 'disabled',
  })
  const t = createTestVela({
    responses: [],
    extensions: [(api) => api.registerChannel(f.channel)],
  })
  await t.vela.ready()
  await expect(f.runtime.submit(input('before start'))).rejects.toThrow(
    'not running',
  )
  await t.vela.startChannels()
  await expect(
    f.runtime.submit(input('disabled', { channelId: 'disabled' })),
  ).rejects.toThrow('not enabled')
  expect(t.exists('channels/index.json')).toBe(false)
  await mkdir(join(t.vela.dataDir, 'channels', 'index.json'), {
    recursive: true,
  })
  await expect(
    f.runtime.submit(input('cannot persist', { replyToId: 'm2' })),
  ).rejects.toThrow()
  await drainChannels(t.vela)
  expect(t.model.calls).toHaveLength(0)
  await rm(join(t.vela.dataDir, 'channels', 'index.json'), { recursive: true })
  await f.runtime.submit(input('!routines', { replyToId: 'restored' }))
  await drainChannels(t.vela)
  await t.vela.dispose()
  await expect(f.runtime.submit(input('after stop'))).rejects.toThrow(
    'not running',
  )
})

test('snapshots and session lookup stay channel-scoped and cannot mutate the directory', async () => {
  const a = adapter('first')
  const b = adapter('second')
  const t = createTestVela({
    responses: [fauxText('one'), fauxText('two')],
    extensions: [
      (api) => {
        api.registerChannel(a.channel)
        api.registerChannel(b.channel)
      },
    ],
  })
  await t.vela.startChannels()
  await a.deliver(input('hub'))
  await b.deliver(
    input('task', { topic: { rootId: 'root', threadId: 'thread' } }),
  )
  const snapshots = a.runtime.sessions('project')
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0]).toMatchObject({
    sessionId: 'first-project',
    chatId: 'project',
    chatKind: 'group',
    state: 'done',
  })
  snapshots[0]!.requester.name = 'Mutated'
  expect(a.runtime.sessions('project')[0]?.requester.name).toBe('Owner')
  expect(a.runtime.scope('second-project-root')).toBeUndefined()
  expect(a.runtime.session('second-project-root')).toBeUndefined()
  expect(a.runtime.sessions('unknown')).toEqual([])
})

test('run-scoped Stop cancels preparation and cannot affect the next run', async () => {
  const held = latch()
  const entered = latch()
  const f = adapter('fixture', {
    async prepareMessage(message) {
      if (message.text === 'first') {
        entered.release()
        await held.promise
      }
      return message
    },
  })
  const t = createTestVela({
    responses: [fauxHang()],
    extensions: [(api) => api.registerChannel(f.channel)],
  })
  await t.vela.startChannels()
  try {
    await f.runtime.submit(input('first', { replyToId: 'first' }))
    await entered.promise
    const runId = f.runtime.sessions('project')[0]?.runId
    expect(runId).toBeString()
    expect(await f.runtime.stop({ chatId: 'project' }, 'expired')).toBe(false)
    expect(await f.runtime.stop({ chatId: 'elsewhere' }, runId!)).toBe(false)
    expect(await f.runtime.stop({ chatId: 'project' }, runId!)).toBe(true)
    expect(await f.runtime.stop({ chatId: 'project' }, runId!)).toBe(false)
    held.release()
    await drainChannels(t.vela)
    expect(t.model.calls).toHaveLength(0)
    await f.runtime.submit(input('second', { replyToId: 'second' }))
    await until(() => t.model.calls.length === 1)
    const nextRun = f.runtime.sessions('project')[0]?.runId
    expect(nextRun).not.toBe(runId)
    expect(await f.runtime.stop({ chatId: 'project' }, runId!)).toBe(false)
    expect(await f.runtime.stop({ chatId: 'project' }, nextRun!)).toBe(true)
  } finally {
    held.release()
  }
  await drainChannels(t.vela)
  expect(f.runtime.sessions('project')[0]?.state).toBe('stopped')
})

test('Stop leaves later queued human input intact', async () => {
  const f = adapter()
  const t = createTestVela({
    responses: [fauxHang(), fauxText('second completed')],
    extensions: [(api) => api.registerChannel(f.channel)],
  })
  await t.vela.startChannels()
  await f.runtime.submit(input('first', { replyToId: 'first' }))
  await until(() => t.model.calls.length === 1)
  const runId = f.runtime.sessions('project')[0]!.runId!
  await f.runtime.submit(input('second', { replyToId: 'second' }))
  expect(await f.runtime.stop({ chatId: 'project' }, runId)).toBe(true)
  await drainChannels(t.vela)
  expect(f.sent.map((message) => message.text)).toContain('second completed')
  expect(t.model.calls).toHaveLength(2)
})

test('queued admission survives preparation Stop and resumes history after idle closing', async () => {
  const held = latch()
  const entered = latch()
  const f = adapter('fixture', {
    async prepareMessage(message) {
      if (message.text === 'first') {
        entered.release()
        await held.promise
      }
      return message
    },
  })
  const t = createTestVela({
    responses: [fauxText('queued answer'), fauxText('continued answer')],
    channelIdleMs: 0,
    extensions: [(api) => api.registerChannel(f.channel)],
  })
  await t.vela.startChannels()
  const outcomes: string[] = []
  f.runtime.onSession((update) => {
    if (update.run?.type === 'finished') outcomes.push(update.run.outcome)
  })
  try {
    await f.runtime.submit(input('first', { replyToId: 'first' }))
    await entered.promise
    const runId = f.runtime.sessions('project')[0]!.runId!
    await f.runtime.submit(input('queued input', { replyToId: 'second' }))
    expect(
      JSON.parse(await t.readData('channels/index.json')).records[0]
        .pendingMessageIds,
    ).toEqual(['first', 'second'])
    expect(await f.runtime.stop({ chatId: 'project' }, runId)).toBe(true)
  } finally {
    held.release()
  }
  await drainChannels(t.vela)
  expect(f.sent.map((message) => message.text)).toEqual([
    'Stopped the current run.',
    'queued answer',
  ])
  expect(outcomes).toEqual(['stopped', 'done'])
  await until(() => !t.vela.sessions().some((s) => s.id === 'fixture-project'))
  await f.runtime.submit(input('continue', { replyToId: 'third' }))
  await drainChannels(t.vela)
  expect(f.sent.at(-1)?.text).toBe('continued answer')
  expect(t.model.calls).toHaveLength(2)
  expect(JSON.stringify(t.model.calls[1]?.prompt)).toContain('queued input')
  expect(JSON.stringify(t.model.calls[1]?.prompt)).toContain('queued answer')
  expect(outcomes).toEqual(['stopped', 'done', 'done'])
})

test('Stop expires when model work settles even while its reply is still delivering', async () => {
  const held = latch()
  const sending = latch()
  const f = adapter('fixture', {
    async send() {
      sending.release()
      await held.promise
    },
  })
  const t = createTestVela({
    responses: [fauxText('finished')],
    extensions: [(api) => api.registerChannel(f.channel)],
  })
  await t.vela.startChannels()
  try {
    await f.runtime.submit(input('question'))
    await until(() => !!f.runtime.sessions('project')[0]?.runId)
    const runId = f.runtime.sessions('project')[0]!.runId!
    await sending.promise
    expect(await f.runtime.stop({ chatId: 'project' }, runId)).toBe(false)
    expect(f.runtime.sessions('project')[0]?.runId).toBeUndefined()
  } finally {
    held.release()
  }
  await drainChannels(t.vela)
})

test('Stop during session restoration prevents a later model run', async () => {
  const held = latch()
  const restoring = latch()
  const storage = memorySessionStorage()
  const f = adapter()
  const t = createTestVela({
    responses: [],
    sessionStorage: {
      ...storage,
      async load(id) {
        if (id === 'fixture-project') {
          restoring.release()
          await held.promise
        }
        return storage.load(id)
      },
    },
    extensions: [(api) => api.registerChannel(f.channel)],
  })
  await t.vela.startChannels()
  try {
    await f.runtime.submit(input('restore', { replyToId: 'restore' }))
    await restoring.promise
    const runId = f.runtime.sessions('project')[0]!.runId!
    expect(await f.runtime.stop({ chatId: 'project' }, runId)).toBe(true)
  } finally {
    held.release()
  }
  await drainChannels(t.vela)
  expect(t.model.calls).toHaveLength(0)
  expect(f.sent.map((message) => message.text)).toEqual([
    'Stopped the current run.',
  ])
  expect(f.runtime.sessions('project')[0]?.state).toBe('stopped')
})

test('Stop remains available while transport controls are preparing', async () => {
  const held = latch()
  const controls = latch()
  const f = adapter('fixture', {
    async startRun() {
      return {
        async event(update) {
          if (update.type === 'controls') {
            controls.release()
            await held.promise
          }
        },
        async finish() {},
      }
    },
  })
  const t = createTestVela({
    responses: [],
    extensions: [(api) => api.registerChannel(f.channel)],
  })
  await t.vela.startChannels()
  try {
    await f.runtime.submit(
      input('task', { topic: { rootId: 'root', threadId: 'thread' } }),
    )
    await controls.promise
    const runId = f.runtime.sessions('project')[0]?.runId
    expect(runId).toBeString()
    expect(
      await f.runtime.stop({ chatId: 'project', rootId: 'root' }, runId!),
    ).toBe(true)
  } finally {
    held.release()
  }
  await drainChannels(t.vela)
  expect(t.model.calls).toHaveLength(0)
  expect(f.runtime.sessions('project')[0]?.state).toBe('stopped')
})

test('a topic alone provides hub scope but never aliases a hub session', async () => {
  const f = adapter()
  const t = createTestVela({
    responses: [fauxText('topic result')],
    extensions: [(api) => api.registerChannel(f.channel)],
  })
  await t.vela.startChannels()
  await f.deliver(
    input('task', { topic: { rootId: 'root', threadId: 'thread' } }),
  )
  expect(f.runtime.session('fixture-project-root')?.id).toBe(
    'fixture-project-root',
  )
  expect(f.runtime.scope('fixture-project')?.chatKind).toBe('group')
  expect(f.runtime.session('fixture-project')).toBeUndefined()
})

test('status subscribers observe saved lines only for their channel without a hub model call', async () => {
  const a = adapter('first')
  const b = adapter('second')
  const t = createTestVela({
    responses: [fauxText('task result'), fauxText('another result')],
    extensions: [
      (api) => {
        api.registerChannel(a.channel)
        api.registerChannel(b.channel)
      },
    ],
  })
  await t.vela.startChannels()
  const lines: string[] = []
  const other: string[] = []
  const remove = a.runtime.onStatus((event) => {
    lines.push(event.text)
  })
  b.runtime.onStatus((event) => {
    other.push(event.text)
  })
  await a.deliver(
    input('task title', { topic: { rootId: 'task', threadId: 'task' } }),
  )
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('finished: task result')
  expect(other).toEqual([])
  expect(
    JSON.parse(await t.readData('channels/index.json')).notes['first-project'],
  ).toEqual(lines)
  expect(t.model.calls).toHaveLength(1)
  remove()
  await a.deliver(
    input('next task', { topic: { rootId: 'next', threadId: 'next' } }),
  )
  expect(lines).toHaveLength(1)
})
