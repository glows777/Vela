import { afterEach, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import {
  type ChannelDefinition,
  type ChannelRuntime,
  type ChannelSessionUpdate,
  type ChannelStatusLine,
  channelSessionId,
  local,
} from '@glows777/vela-channels'
import { drainChannels } from '@glows777/vela-channels/testing'
import { fauxHang, fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { localStore } from '../support/compat-vela.ts'
import { fakeLark, larkEvent } from '../support/lark.ts'
import {
  freeLocalPort,
  LOCAL_TOKEN,
  LocalClient,
  type Project,
  sessionPath,
  until,
} from '../support/local.ts'
import { RoutineClock } from '../support/routine-clock.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

const input = {
  channelId: 'oc_group',
  senderId: 'ou_alice',
  senderName: 'Alice',
  text: 'host input',
  replyToId: 'host-anchor',
}

async function setup(
  responses: NonNullable<
    Parameters<typeof createTestVela>[0]
  >['responses'] = [],
) {
  const fake = fakeLark()
  const port = await freeLocalPort()
  const t = createTestVela({
    responses,
    extensions: [
      lark({
        owners: ['ou_alice'],
        chats: [{ id: 'oc_group', tools: [], readUntagged: false }, 'oc_other'],
        transport: fake.transport,
      }),
      local({ token: LOCAL_TOKEN, port }),
    ],
  })
  await t.vela.ready()
  return {
    t,
    fake,
    client: new LocalClient(`http://127.0.0.1:${port}`, LOCAL_TOKEN),
  }
}

test('host views reuse channel runtimes, observe detached transitions and status, and list all enabled chats without opening sessions', async () => {
  const { t, fake, client } = await setup([
    fauxToolCall('channel_wait_for_input', { reason: 'Choose a color' }),
    fauxText('Which color?'),
    fauxText('Second chat'),
    fauxText('Local answer'),
    fauxText('Follow-up done'),
  ])
  const host = t.vela.channel('lark')
  const localHost = t.vela.channel('local')
  expect(() => t.vela.channel('missing')).toThrow('Unknown channel')
  for (const hidden of [
    'scope',
    'session',
    'context',
    'topics',
    'topicCoverage',
    'dispatch',
    'waitForInput',
    'skipReply',
  ])
    expect(host).not.toHaveProperty(hidden)
  expect(t.vela.channels().map((channel) => channel.name)).toEqual([
    'lark',
    'local',
  ])
  expect(host.connection()).toEqual({ connected: false })
  const updates: ChannelSessionUpdate[] = []
  const status: ChannelStatusLine[] = []
  const localUpdates: ChannelSessionUpdate[] = []
  host.onSession(() => {
    throw new Error('observer failure')
  })
  host.onSession((update) => {
    update.session.requester.name = 'mutated'
  })
  const off = host.onSession((update) => updates.push(update))
  host.onStatus((line) => status.push(line))
  localHost.onSession((update) => localUpdates.push(update))
  await expect(host.submit(input)).rejects.toThrow('not running')
  await t.vela.startChannels()
  expect(host.connection()).toEqual({ connected: true })
  expect(localHost.connection()).toEqual({ connected: true })
  fake.deliver(
    larkEvent({ message_id: 'root', root_id: 'root', thread_id: 'thread' }),
  )
  await until(() =>
    host.sessions().some((session) => session.state === 'waiting'),
  )
  await drainChannels(t.vela)
  const waiting = host.sessions()[0]!
  expect(waiting).toMatchObject({
    topic: { rootId: 'root', threadId: 'thread' },
    waitingReason: 'Choose a color',
    requester: { name: 'Alice' },
  })
  expect(updates.some((update) => update.run?.type === 'started')).toBe(true)
  expect(updates.some((update) => update.run?.type === 'finished')).toBe(true)
  expect(status.length).toBeGreaterThan(0)
  const index = JSON.parse(
    await readFile(t.dataPath('channels/index.json'), 'utf8'),
  )
  expect(Object.values(index.notes).flat()).toContain(status.at(-1)!.text)
  await host.submit({ ...input, channelId: 'oc_other' })
  await drainChannels(t.vela)
  const project = await client.request<Project>('/v1/projects', { cwd: t.cwd })
  await client.request(`${sessionPath(project)}/messages`, {
    text: 'Local question',
  })
  await drainChannels(t.vela)
  expect(
    host
      .sessions()
      .map((session) => session.chatId)
      .sort(),
  ).toEqual(['oc_group', 'oc_other'])
  expect(host.sessions('oc_group')).toHaveLength(1)
  expect(localHost.sessions().map((session) => session.chatId)).toEqual([
    project.id,
  ])
  expect(
    localUpdates.every((update) => update.session.chatId === project.id),
  ).toBe(true)
  const count = t.vela.sessions().length
  const detached = host.sessions()
  detached[0]!.requester.name = 'changed'
  expect(host.sessions()[0]!.requester.name).toBe('Alice')
  expect(t.vela.sessions()).toHaveLength(count)
  const receipt = await host.submit({ ...input, topic: waiting.topic })
  expect(receipt.sessionId).toBe(waiting.sessionId)
  await drainChannels(t.vela)
  expect(fake.sent.at(-1)?.messageId).toBe('host-anchor')
  expect(host.sessions('oc_group')[0]!.waitingReason).toBeUndefined()
  off()
})

test('host rejects unknown, disabled and mismatched topic addresses before admission and preserves the input object', async () => {
  const { t, fake } = await setup([fauxText('owned'), fauxText('follow-up')])
  await t.vela.startChannels()
  const host = t.vela.channel('lark')
  const topic = { rootId: 'root', threadId: 'thread' }
  for (const msg of [
    { ...input, topic },
    { ...input, channelId: 'disabled' },
    { ...input, replyToId: undefined, chatKind: 'group' as const },
  ])
    await expect(host.submit(msg)).rejects.toThrow()
  expect(host.sessions()).toEqual([])
  expect(t.model.calls).toHaveLength(0)
  fake.deliver(
    larkEvent({ root_id: 'root', thread_id: 'thread', message_id: 'root' }),
  )
  await drainChannels(t.vela)
  await expect(
    host.submit({ ...input, topic: { ...topic, threadId: 'wrong' } }),
  ).rejects.toThrow('topic')
  await expect(
    host.submit({ ...input, channelId: 'oc_other', topic }),
  ).rejects.toThrow('topic')
  await expect(
    host.submit({ ...input, replyToId: undefined, topic }),
  ).rejects.toThrow('anchor')
  await expect(
    t.vela.channel('local').submit({ ...input, chatKind: 'group' }),
  ).rejects.toThrow('scope')
  const msg = { ...input, topic }
  await host.submit(msg)
  await drainChannels(t.vela)
  expect(msg).not.toHaveProperty('requireExistingSession')
  expect(msg).not.toHaveProperty('isNewTopic')
  expect(host.sessions()).toHaveLength(1)
})

test('host durable submission resolves before model completion and exact Stop preserves queued work', async () => {
  const { t } = await setup([fauxHang(), fauxHang()])
  await t.vela.startChannels()
  const host = t.vela.channel('lark')
  const receipt = await host.submit(input)
  expect(receipt.sessionId).toBe(channelSessionId('lark', 'oc_group'))
  await until(() => t.model.calls.length === 1)
  const firstRun = host.sessions()[0]!.runId!
  await host.submit({
    ...input,
    text: 'queued work',
    replyToId: 'second-anchor',
  })
  expect(await host.stop({ chatId: 'oc_group' }, 'expired')).toBe(false)
  expect(await host.stop({ chatId: 'oc_group' }, firstRun)).toBe(true)
  await until(() => t.model.calls.length === 2)
  const nextRun = host.sessions()[0]!.runId!
  expect(nextRun).not.toBe(firstRun)
  expect(t.model.calls[1]!.lastUserText).toContain('queued work')
  expect(await host.stop({ chatId: 'oc_group' }, firstRun)).toBe(false)
  expect(await host.stop({ chatId: 'oc_group' }, nextRun)).toBe(true)
  await drainChannels(t.vela)
  await t.vela.dispose()
  expect(host.connection()).toEqual({ connected: false })
  await expect(host.submit(input)).rejects.toThrow('not running')
  expect(await host.stop({ chatId: 'oc_group' }, nextRun)).toBe(false)
})

test('idle host routines retain existing schedules, attribution, per-chat isolation and model-only restrictions', async () => {
  const fake = fakeLark()
  let runtime!: ChannelRuntime
  const t = createTestVela({
    responses: [
      fauxText('first'),
      fauxText('second'),
      fauxText('other channel'),
    ],
    extensions: [
      lark({
        owners: ['ou_alice'],
        chats: ['oc_group', 'oc_other'],
        transport: fake.transport,
      }),
      (api) =>
        api.registerChannel({
          name: 'second',
          description: 'Second channel',
          start() {},
          stop() {},
          async send() {},
          connect(value) {
            runtime = value
          },
        }),
    ],
  })
  t.internals.gateway.routines.clock = new RoutineClock()
  await t.vela.startChannels()
  const host = t.vela.channel('lark')
  await host.submit(input)
  await drainChannels(t.vela)
  await host.submit({ ...input, channelId: 'oc_other' })
  await drainChannels(t.vela)
  const other = t.vela.channel('second')
  await other.submit(input)
  await drainChannels(t.vela)
  const target = { chatId: 'oc_group' }
  const value = {
    message: 'Review report',
    schedule: { at: '2026-01-05T09:00' },
    creator: { id: 'sdk-owner', name: 'SDK Owner' },
  }
  const routine = await host.routines.create(target, value)
  expect(routine.creator).toEqual(value.creator)
  expect(routine.nextRun).toBe('2026-01-05 09:00')
  expect(routine.targetKey).toBe(channelSessionId('lark', 'oc_group'))
  expect(host.routines.list(target).routines.map((item) => item.id)).toEqual([
    routine.id,
  ])
  expect(other.routines.list(target).routines).toEqual([])
  expect(await other.routines.cancel(target, routine.id)).toBe(false)
  expect(await host.routines.cancel({ chatId: 'oc_other' }, routine.id)).toBe(
    false,
  )
  await expect(
    host.routines.create({ chatId: 'missing' }, value),
  ).rejects.toThrow()
  await expect(
    host.routines.create({ chatId: 'oc_group', rootId: 'missing' }, value),
  ).rejects.toThrow()
  expect(() => host.routines.list({ chatId: 'missing' })).toThrow()
  expect(() =>
    runtime.routines.list(channelSessionId('second', 'oc_group')),
  ).toThrow('active')
  await expect(
    host.routines.create(target, {
      ...value,
      schedule: { at: '2020-01-01T09:00' },
    }),
  ).rejects.toThrow('future')
  expect(await host.routines.cancel(target, routine.id)).toBe(true)
  expect(await host.routines.cancel(target, routine.id)).toBe(false)
  expect(host.routines.list(target).routines).toEqual([])
  await t.vela.dispose()
  await expect(host.routines.create(target, value)).rejects.toThrow(
    'not running',
  )
})

test('connection fallback, exception isolation and disposal keep host state detached and prevent late updates', async () => {
  let stopped = 0
  const channels: ChannelDefinition[] = [
    {
      name: 'plain',
      description: '',
      start() {},
      stop() {
        stopped++
      },
      async send() {},
    },
    {
      name: 'disabled',
      description: '',
      start() {
        return false
      },
      stop() {},
      async send() {},
    },
    {
      name: 'failed',
      description: '',
      start() {
        throw new Error('secret-provider-token')
      },
      stop() {},
      async send() {},
    },
  ]
  const t = createTestVela({
    extensions: [
      (api) => {
        for (const channel of channels) api.registerChannel(channel)
      },
    ],
  })
  await t.vela.ready()
  const host = t.vela.channel('plain')
  const states: boolean[] = []
  host.onConnection(() => {
    throw new Error('observer failure')
  })
  host.onConnection((value) => {
    value.connected = false
  })
  host.onConnection((value) => states.push(value.connected))
  expect(states).toEqual([])
  await t.vela.startChannels()
  expect(states).toEqual([true])
  const value = host.connection()
  value.connected = false
  expect(host.connection()).toEqual({ connected: true })
  expect(t.vela.channel('disabled').connection()).toEqual({ connected: false })
  expect(t.vela.channel('failed').connection()).toMatchObject({
    connected: false,
    error: expect.any(String),
  })
  expect(JSON.stringify(t.vela.channel('failed').connection())).not.toContain(
    'secret-provider-token',
  )
  expect(t.vela.runningChannels()).toEqual(['plain'])
  await t.vela.dispose()
  expect(states).toEqual([true, false])
  expect(stopped).toBe(1)
})

test('disposal during channel startup cannot report a late connection or enable host mutations', async () => {
  let finish!: () => void
  let starting!: () => void
  const entered = new Promise<void>((resolve) => {
    starting = resolve
  })
  const t = createTestVela({
    extensions: [
      (api) =>
        api.registerChannel({
          name: 'slow',
          description: '',
          start: () =>
            new Promise<void>((resolve) => {
              finish = resolve
              starting()
            }),
          stop() {},
          async send() {},
        }),
    ],
  })
  await t.vela.ready()
  const host = t.vela.channel('slow')
  const states: boolean[] = []
  host.onConnection((value) => states.push(value.connected))
  const startup = t.vela.startChannels()
  await entered
  await t.vela.dispose()
  finish()
  await startup
  expect(host.connection()).toEqual({ connected: false })
  expect(t.vela.runningChannels()).toEqual([])
  expect(states).not.toContain(true)
  await expect(host.submit(input)).rejects.toThrow('not running')
})

test('disposal during Local storage loading prevents a late loopback listener', async () => {
  const port = await freeLocalPort()
  let channel!: ChannelDefinition
  let release!: () => void
  let entered!: () => void
  const loading = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const t = createTestVela({
    extensions: [
      (api) =>
        local({ token: LOCAL_TOKEN, port })({
          ...api,
          registerChannel(value) {
            channel = value
            const store = localStore(value)
            const load = store.load.bind(store)
            store.load = async () => {
              entered()
              await held
              await load()
            }
            api.registerChannel(value)
          },
        }),
    ],
  })
  await t.vela.ready()
  const host = t.vela.channel('local')
  const states: boolean[] = []
  host.onConnection((state) => states.push(state.connected))
  const startup = t.vela.startChannels()
  await loading
  try {
    await t.vela.dispose()
    release()
    await startup
    expect(host.connection()).toEqual({ connected: false })
    expect(t.vela.runningChannels()).toEqual([])
    expect(states).not.toContain(true)
    const acceptsConnection = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    expect(acceptsConnection).toBe(false)
    expect(t.model.calls).toHaveLength(0)
  } finally {
    release()
    await startup
    await channel.stop()
  }
})
