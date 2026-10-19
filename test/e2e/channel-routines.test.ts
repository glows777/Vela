import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ChannelDirectory } from '../../src/channels/directory.ts'
import { channelSessionId } from '../../src/channels/session-id.ts'
import { feishu } from '../../src/extensions/feishu/index.ts'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { VelaSession } from '../../src/vela-session.ts'
import { fakeFeishu, feishuEvent } from '../support/feishu.ts'
import { RoutineClock } from '../support/routine-clock.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

function setup(cwd?: string, chats = ['oc_group']) {
  const fake = fakeFeishu()
  const logs: string[] = []
  const t = createTestVela({
    cwd,
    allowPendingResponses: true,
    logger: {
      debug() {},
      info: (s) => logs.push(s),
      warn: (s) => logs.push(s),
      error: (s) => logs.push(s),
    },
    extensionConfig: { feishu: { timezone: 'UTC' } },
    extensions: [
      feishu({ owners: ['ou_alice'], chats, transport: fake.transport }),
    ],
  })
  const clock = new RoutineClock()
  if (t.internals.gateway.routines) t.internals.gateway.routines.clock = clock
  const path = t.dataPath('channels/routines.json')
  async function seed(
    schedule: { at: string } | { time: string; days?: string[] },
    target: 'topic' | 'group' | 'direct' = 'topic',
  ) {
    const directory = new ChannelDirectory(t.vela.dataDir)
    await directory.load()
    const key = channelSessionId(
      'feishu',
      'oc_group',
      target === 'topic' ? 'root' : undefined,
    )
    await directory.admit(key, 'feishu', {
      channelId: 'oc_group',
      senderId: 'ou_alice',
      senderName: 'Alice',
      text: 'Original task',
      replyToId: target === 'direct' ? undefined : 'original',
      ...(target === 'topic'
        ? { topic: { rootId: 'root', threadId: 'thread' } }
        : {}),
    })
    await directory.forget(key, ['original'])
    await mkdir(join(t.vela.dataDir, 'channels'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        routines: [
          {
            id: 'reminder',
            channel: 'feishu',
            chatId: 'oc_group',
            targetKey: key,
            creator: { id: 'ou_bob', name: 'Bob' },
            message: 'Review the report',
            schedule,
            createdAt: '2026-01-05T08:00:00.000Z',
            lastFiredAt: null,
          },
        ],
      }),
    )
    return key
  }
  const stored = async () => JSON.parse(await readFile(path, 'utf8')).routines
  async function advance(at: string) {
    clock.advance(at)
    await t.internals.gateway.routines.drain()
  }
  return { t, fake, clock, logs, path, seed, stored, advance }
}

test.each(['routine', 'human'] as const)(
  'a routine preserves the original topic requester and recovers the %s run recipient',
  async (recovering) => {
    const first = setup()
    const key = channelSessionId('feishu', 'oc_group', 'root')
    const topic = { root_id: 'root', thread_id: 'thread' }
    async function deliver(text: string, answer: string) {
      const done = Promise.withResolvers<void>()
      const unsubscribe = first.t.vela.subscribe((event) => {
        if (event.type === 'channel_reply' && event.text === answer)
          done.resolve()
      })
      first.fake.deliver(
        feishuEvent({ ...topic, content: JSON.stringify({ text }) }),
      )
      try {
        await done.promise
      } finally {
        unsubscribe()
      }
    }
    first.t.model.push(fauxText('Original result'))
    await first.t.vela.startChannels()
    await deliver('Investigate the original task', 'Original result')
    await first.t.internals.gateway.routines.create({
      channel: 'feishu',
      chatId: 'oc_group',
      targetKey: key,
      creator: { id: 'ou_bob', name: 'Bob' },
      message: 'Review the report',
      schedule: { at: '2026-01-05T09:00:00.000Z' },
    })
    first.t.model.push(fauxText('Reminder result'))
    if (recovering === 'routine') first.fake.failReply()
    await first.advance('2026-01-05T09:00:00Z')
    let overviewRequester: unknown
    if (recovering === 'human') {
      first.t.model.push(
        fauxToolCall('feishu_list_topics', {}),
        fauxText('Overview'),
      )
      const overviewDone = Promise.withResolvers<void>()
      const unsubscribe = first.t.vela.subscribe((event) => {
        if (event.type === 'channel_reply' && event.text === 'Overview')
          overviewDone.resolve()
      })
      first.fake.deliver(
        feishuEvent({ content: '{"text":"List this group\u0027s topics"}' }),
      )
      await overviewDone.promise
      unsubscribe()
      overviewRequester = JSON.parse(
        first.t.model.calls.at(-1)!.toolResults.at(-1)!.output,
      ).topics[0].requester
      first.fake.failReply()
      first.t.model.push(fauxText('Human follow-up'))
      const failed = Promise.withResolvers<void>()
      const unsubscribeFailure = first.t.vela.subscribe((event) => {
        if (event.type === 'channel_error' && event.senderId === 'ou_alice')
          failed.resolve()
      })
      first.fake.deliver(
        feishuEvent({
          ...topic,
          content: '{"text":"Continue my original task"}',
        }),
      )
      await failed.promise
      unsubscribeFailure()
    }
    await first.t.cleanup({ keepDir: true })
    const second = setup(first.t.cwd)
    second.clock.advance('2026-01-05T10:00:00Z')
    const answer =
      recovering === 'routine' ? 'Reminder result' : 'Human follow-up'
    const recovered = Promise.withResolvers<void>()
    const reply = second.fake.transport.reply
    second.fake.transport.reply = async (id, text) => {
      const result = await reply(id, text)
      if (text.includes(answer)) recovered.resolve()
      return result
    }
    await second.t.vela.startChannels()
    await recovered.promise
    await second.t.cleanup({ keepDir: true })
    const directory = new ChannelDirectory(second.t.vela.dataDir)
    await directory.load()
    expect({
      requester: directory.get(key)!.requester,
      ...(recovering === 'human' ? { overviewRequester } : {}),
      reply: second.fake.sent.find((message) => message.text.includes(answer))
        ?.text,
    }).toEqual({
      requester: { id: 'ou_alice', name: 'Alice' },
      ...(recovering === 'human'
        ? { overviewRequester: { id: 'ou_alice', name: 'Alice' } }
        : {}),
      reply: `<at user_id="${recovering === 'routine' ? 'ou_bob' : 'ou_alice'}"></at> ${answer}`,
    })
    expect(second.t.model.calls).toHaveLength(0)
  },
)

test.each(['topic', 'group', 'direct'] as const)(
  'a one-off fires once into its %s and mentions its creator',
  async (target) => {
    const r = setup()
    const key = await r.seed({ at: '2026-01-05T09:00:00.000Z' }, target)
    r.t.model.push(fauxText('Review reminder'))
    await r.t.vela.startChannels()
    await r.advance('2026-01-05T08:59:59Z')
    expect(r.t.model.calls).toHaveLength(0)
    await r.advance('2026-01-05T09:00:00Z')
    expect(r.fake.sent.at(-1)).toMatchObject({
      ...(target === 'direct'
        ? { chatId: 'oc_group' }
        : { messageId: target === 'topic' ? 'root' : 'sent_1' }),
      text: '<at user_id="ou_bob"></at> Review reminder',
    })
    expect(r.fake.sent).toHaveLength(target === 'group' ? 2 : 1)
    if (target === 'group') {
      expect(r.fake.sent[0]).toEqual({
        chatId: 'oc_group',
        text: '⏰ Review the report (set by Bob)',
      })
    }
    expect(r.t.model.calls).toHaveLength(1)
    expect(r.t.model.calls[0]!.lastUserText).toContain(
      'Scheduled wake-up reminder',
    )
    expect(r.t.model.calls[0]!.lastUserText).toContain(
      '2026-01-05T09:00:00.000Z (UTC)',
    )
    expect(await r.stored()).toEqual([])
    const entries = r.t.vela.session(key).getEntries()
    expect(
      entries.filter(
        (e) => e.type === 'custom' && e.customType === 'channel.input',
      ),
    ).toHaveLength(1)
    await r.advance('2026-01-07T09:00:00Z')
    expect(r.t.model.calls).toHaveLength(1)
  },
)

test('recurrence survives process and logical topic restart and realigns saved markers', async () => {
  const first = setup()
  const key = await first.seed({ time: '09:00', days: ['mon', 'tue'] })
  first.t.model.push(fauxText('Monday'))
  await first.t.vela.startChannels()
  await first.advance('2026-01-05T09:00:00Z')
  // Simulate a session save succeeding before its watermark write was committed.
  const records = await first.stored()
  records[0].lastFiredAt = null
  await writeFile(first.path, JSON.stringify({ version: 1, routines: records }))
  await first.t.cleanup({ keepDir: true })
  const second = setup(first.t.cwd)
  second.clock.advance('2026-01-05T10:00:00Z')
  await second.t.vela.startChannels()
  await second.t.internals.gateway.routines.drain()
  expect(second.t.model.calls).toHaveLength(0)
  expect((await second.stored())[0].lastFiredAt).toBe(
    '2026-01-05T09:00:00.000Z',
  )
  await second.t.internals.gateway.handleIncoming('feishu', {
    channelId: 'oc_group',
    senderId: 'ou_alice',
    senderName: 'Alice',
    text: '!restart',
    replyToId: 'restart',
    topic: { rootId: 'root', threadId: 'thread' },
  })
  second.t.model.push(fauxText('Tuesday'))
  await second.advance('2026-01-06T09:00:00Z')
  const directory = new ChannelDirectory(second.t.vela.dataDir)
  await directory.load()
  const physical = directory.sessionId(key)
  expect(physical).not.toBe(key)
  expect(second.t.vela.session(physical).cwd).toContain(
    `${channelSessionId('feishu', 'oc_group')}/workspace`,
  )
  expect(second.fake.sent.at(-1)?.text).toContain('ou_bob')
  expect(second.t.model.calls).toHaveLength(1)
})

test('a cancelled routine does not fire', async () => {
  const r = setup()
  await r.seed({ time: '09:00' })
  await r.t.vela.startChannels()
  await r.t.internals.gateway.routines.cancel('feishu', 'oc_group', 'reminder')
  await r.advance('2026-01-05T09:00:00Z')
  expect(r.t.model.calls).toHaveLength(0)
  expect(r.fake.sent).toHaveLength(0)
  expect(await r.stored()).toEqual([])
})

test.each([{ time: '09:00' }, { at: '2026-01-05T09:00:00.000Z' }])(
  'missed %j wakes once with a late notice, not once per missed occurrence',
  async (schedule) => {
    const r = setup()
    await r.seed(schedule, 'group')
    r.clock.advance('2026-01-08T10:00:00Z')
    r.t.model.push(fauxText('Late reminder'))
    await r.t.vela.startChannels()
    await r.t.internals.gateway.routines.drain()
    expect(r.t.model.calls).toHaveLength(1)
    expect(r.t.model.calls[0]!.lastUserText).toContain('late by')
    expect(r.fake.sent[0]).toEqual({
      chatId: 'oc_group',
      text: `⏰ Review the report (set by Bob; late by ${'at' in schedule ? 262800 : 3600} seconds)`,
    })
    expect(r.fake.sent.some((m) => m.text.includes('send it again'))).toBe(
      false,
    )
    await r.advance('2026-01-08T11:00:00Z')
    expect(r.t.model.calls).toHaveLength(1)
  },
)

test('a disabled chat retains its routine and logs only once per startup', async () => {
  const r = setup(undefined, [])
  await r.seed({ time: '09:00' })
  r.clock.advance('2026-01-06T10:00:00Z')
  await r.t.vela.startChannels()
  await r.t.internals.gateway.routines.drain()
  await r.advance('2026-01-07T09:00:00Z')
  expect(r.t.model.calls).toHaveLength(0)
  expect(r.fake.sent).toHaveLength(0)
  expect(await r.stored()).toHaveLength(1)
  expect(
    r.logs.filter((s) => s.includes('Routine') && s.includes('disabled')),
  ).toHaveLength(1)
})

test('a routine queues behind a running topic without steering and mentions its own creator', async () => {
  const r = setup()
  const key = await r.seed({ at: '2026-01-05T09:00:00.000Z' })
  let release!: () => void
  let entered!: () => void
  const inside = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  r.t.internals.registry.register({
    name: 'held',
    description: 'Hold work',
    inputSchema: z.object({}),
    execute: async () => {
      entered()
      await held
      return 'finished'
    },
  })
  r.t.model.push(
    fauxToolCall('held', {}),
    fauxText('Original answer'),
    fauxText('Routine answer'),
  )
  await r.t.vela.startChannels()
  const running = r.t.internals.gateway.handleIncoming('feishu', {
    channelId: 'oc_group',
    senderId: 'ou_alice',
    senderName: 'Alice',
    text: 'Original work',
    replyToId: 'original',
    topic: { rootId: 'root', threadId: 'thread' },
  })
  await inside
  r.clock.advance('2026-01-05T09:00:00Z')
  await Promise.resolve()
  expect(r.t.vela.session(key).queue.steering).toEqual([])
  release()
  await running
  await r.t.internals.gateway.routines.drain()
  expect(r.fake.sent.map((m) => m.text)).toEqual([
    '<at user_id="ou_alice"></at> Original answer',
    '<at user_id="ou_bob"></at> Routine answer',
  ])
  expect(r.t.model.calls).toHaveLength(3)
})

test('a malformed routine file rejects startup with its path', async () => {
  const r = setup()
  await mkdir(join(r.t.vela.dataDir, 'channels'), { recursive: true })
  await writeFile(r.path, '{broken')
  await expect(r.t.vela.startChannels()).rejects.toThrow(r.path)
})

test('a failed input save leaves the watermark unchanged and schedules only a future occurrence', async () => {
  const r = setup()
  await r.seed({ time: '09:00' })
  r.t.model.push(fauxText('Reminder'))
  await r.t.vela.startChannels()
  const save = VelaSession.prototype.save
  const spy = spyOn(VelaSession.prototype, 'save').mockImplementation(function (
    this: VelaSession,
  ) {
    if (
      this.getEntries().some(
        (e) =>
          e.type === 'custom' &&
          e.customType === 'channel.input' &&
          (e.data as { routine?: unknown })?.routine,
      )
    )
      return Promise.reject(new Error('simulated routine save failure'))
    return save.call(this)
  })
  try {
    await r.advance('2026-01-05T09:00:00Z')
    expect((await r.stored())[0].lastFiredAt).toBeNull()
    await r.advance('2026-01-05T09:01:00Z')
    expect(r.t.model.calls).toHaveLength(1)
    expect(r.logs.join('\n')).toContain('simulated routine save failure')
  } finally {
    spy.mockRestore()
  }
})
