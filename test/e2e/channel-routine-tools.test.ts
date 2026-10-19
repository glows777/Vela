import { afterEach, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { channelSessionId } from '../../src/channels/session-id.ts'
import { feishu } from '../../src/extensions/feishu/index.ts'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { fakeFeishu, feishuEvent } from '../support/feishu.ts'
import { RoutineClock } from '../support/routine-clock.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for Feishu result')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
function setup() {
  const fake = fakeFeishu()
  const t = createTestVela({
    allowPendingResponses: true,
    extensionConfig: { feishu: { timezone: 'America/New_York' } },
    extensions: [
      feishu({
        owners: ['ou_alice'],
        chats: [{ id: 'oc_group', tools: [], readUntagged: false }, 'oc_other'],
        transport: fake.transport,
      }),
    ],
  })
  const clock = new RoutineClock()
  t.internals.gateway.routines.clock = clock
  let sequence = 0
  async function ask(
    input: unknown,
    overrides: Parameters<typeof feishuEvent>[0] = {},
    sender = 'ou_alice',
  ) {
    const answer = `Result ${++sequence}`
    t.model.push(fauxToolCall('feishu_routines', input), fauxText(answer))
    fake.deliver(
      feishuEvent(
        { ...overrides, content: JSON.stringify({ text: 'Manage reminders' }) },
        sender,
      ),
    )
    await until(() => fake.sent.some((m) => m.text.includes(answer)))
    return t.model.calls.at(-1)!.toolResults.at(-1)!.output
  }
  const topic = { root_id: 'root', thread_id: 'thread' }
  const stored = async () =>
    JSON.parse(await readFile(t.dataPath('channels/routines.json'), 'utf8'))
      .routines
  return { t, fake, clock, ask, topic, stored }
}

test('a member creates a local-time topic routine with mandatory tools, lists after restart, and another member cancels it', async () => {
  const r = setup()
  await r.t.vela.startChannels()
  const created = JSON.parse(
    await r.ask(
      {
        action: 'create',
        message: 'Review report',
        schedule: { at: '2026-01-05T09:00' },
      },
      r.topic,
    ),
  )
  expect(created.timezone).toBe('America/New_York')
  expect(created.nextRun).toBe('2026-01-05 09:00')
  expect(created.target).toContain('root')
  const [record] = await r.stored()
  expect(record.schedule).toEqual({ at: '2026-01-05T14:00:00.000Z' })
  expect(record.targetKey).toBe(channelSessionId('feishu', 'oc_group', 'root'))
  expect(record.creator).toEqual({ id: 'ou_alice', name: 'Alice' })
  r.fake.deliver(feishuEvent({ ...r.topic, content: '{"text":"!restart"}' }))
  await until(() => r.fake.sent.some((m) => m.text.includes('Restarted')))
  const listed = JSON.parse(await r.ask({ action: 'list' }, r.topic))
  expect(listed.routines[0].id).toBe(record.id)
  expect(listed.routines[0].target).toBe(created.target)
  expect(
    JSON.parse(await r.ask({ action: 'cancel', id: record.id }, {}, 'ou_bob'))
      .cancelled,
  ).toBe(true)
  expect(
    JSON.parse(await r.ask({ action: 'cancel', id: record.id }, {}, 'ou_bob'))
      .cancelled,
  ).toBe(false)
  const calls = r.t.model.calls.length
  r.clock.advance('2026-01-05T14:00:00Z')
  await r.t.internals.gateway.routines.drain()
  expect(r.t.model.calls).toHaveLength(calls)
  expect(await r.stored()).toEqual([])
})

test.each(['group', 'topic', 'direct'] as const)(
  '!routines in %s lists without model requests or user entries, with or without mentions',
  async (target) => {
    const r = setup()
    await r.t.vela.startChannels()
    const address =
      target === 'topic'
        ? r.topic
        : target === 'direct'
          ? { chat_type: 'p2p' }
          : {}
    const created = JSON.parse(
      await r.ask(
        {
          action: 'create',
          message: 'Daily report',
          schedule: { time: '09:00', days: ['mon', 'fri'] },
        },
        address,
      ),
    )
    const session = r.t.vela.session(
      channelSessionId(
        'feishu',
        'oc_group',
        target === 'topic' ? 'root' : undefined,
      ),
    )
    const before = {
      calls: r.t.model.calls.length,
      entries: session.getEntries().length,
    }
    for (const mentioned of [true, false]) {
      const count = r.fake.sent.length
      // A fallback answer lets an incorrect model path finish and fail the assertions.
      r.t.model.push(fauxText('Unexpected model request'))
      r.fake.deliver(
        feishuEvent({
          ...address,
          mentions: mentioned
            ? [{ key: '@_user_1', id: { open_id: 'ou_bot' } }]
            : [],
          content: JSON.stringify({
            text: mentioned ? '@_user_1 !routines' : '!routines',
          }),
        }),
      )
      await until(() => r.fake.sent.length > count)
      const text = r.fake.sent.at(-1)!.text
      for (const value of [
        created.id,
        'America/New_York',
        'mon,fri',
        '09:00',
        'Alice',
        created.target,
        '2026-01-05 09:00',
      ])
        expect(text).toContain(value)
      expect(r.t.model.calls).toHaveLength(before.calls)
      expect(session.getEntries()).toHaveLength(before.entries)
    }
  },
)

test('unmentioned !routines in an unowned topic and other discussion with passive intake disabled leave no writes', async () => {
  const r = setup()
  await r.t.vela.startChannels()
  r.fake.deliver(
    feishuEvent({ ...r.topic, mentions: [], content: '{"text":"!routines"}' }),
  )
  r.fake.deliver(
    feishuEvent({ mentions: [], content: '{"text":"!routines please"}' }),
  )
  await r.t.internals.gateway.stopAll()
  expect(r.t.model.calls).toHaveLength(0)
  expect(r.fake.sent).toEqual([])
  expect(r.t.exists('channels/index.json')).toBe(false)
})

test('listing while a topic runs neither stops nor steers the active run', async () => {
  const r = setup()
  const entered = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  r.t.internals.registry.register({
    name: 'held',
    description: 'Held work',
    inputSchema: z.object({}),
    execute: async () => {
      entered.resolve()
      await held.promise
      return 'done'
    },
  })
  await r.t.vela.startChannels()
  // This entry uses normal gateway routing with a controlled faux tool.
  r.t.model.push(fauxToolCall('held', {}), fauxText('Original answer'))
  const input = {
    channelId: 'oc_other',
    senderId: 'ou_alice',
    senderName: 'Alice',
    text: 'Work',
    replyToId: 'work',
    topic: { rootId: 'busy', threadId: 'thread_busy' },
  }
  const running = r.t.internals.gateway.handleIncoming('feishu', input)
  await entered.promise
  const session = r.t.vela.session(
    channelSessionId('feishu', 'oc_other', 'busy'),
  )
  const before = session.getEntries().length
  const cardsBefore = r.fake.cards.length
  const command = r.t.internals.gateway.handleIncoming('feishu', {
    ...input,
    text: '!routines',
    replyToId: 'listing',
  })
  try {
    await until(
      () =>
        r.fake.sent.some((m) => m.messageId === 'listing') ||
        r.fake.cards.length > cardsBefore ||
        session.queue.steering.length > 0,
    )
    expect(r.fake.sent.some((m) => m.messageId === 'listing')).toBe(true)
    expect(r.t.model.calls).toHaveLength(1)
    expect(session.getEntries()).toHaveLength(before)
    expect(session.queue.steering).toEqual([])
    expect(r.fake.cards).toHaveLength(cardsBefore)
  } finally {
    held.resolve()
    await Promise.all([running, command])
  }
})

test('routine tools enforce validation, a per-chat cap and same-chat cancellation without exposing other chats', async () => {
  const r = setup()
  await r.t.vela.startChannels()
  const created = JSON.parse(
    await r.ask({
      action: 'create',
      message: 'Daily',
      schedule: { time: '09:00' },
    }),
  )
  expect(
    JSON.parse(await r.ask({ action: 'list' }, { chat_id: 'oc_other' }))
      .routines,
  ).toEqual([])
  expect(
    JSON.parse(
      await r.ask(
        { action: 'cancel', id: created.id },
        { chat_id: 'oc_other' },
      ),
    ).cancelled,
  ).toBe(false)
  for (const schedule of [
    { at: '2026-01-04T09:00' },
    { at: '2026-02-30T09:00' },
    { time: '25:00' },
    { time: '09:00', days: ['wrong'] },
    { time: '09:00', days: [] },
  ]) {
    const output = await r.ask({
      action: 'create',
      message: 'Invalid',
      schedule,
    })
    expect(output).not.toContain('not found')
    expect(output).toMatch(/future|Invalid|invalid|match|small/)
  }
  const extra = await r.ask({
    action: 'create',
    message: 'Spoof',
    schedule: { time: '09:00' },
    chatId: 'oc_other',
    creator: { id: 'ou_bob' },
    targetKey: 'spoof',
  })
  expect(extra).toMatch(/Unrecognized|unrecognized/)
  const record = (await r.stored())[0]
  for (let i = 1; i < 20; i++)
    await r.t.internals.gateway.routines.create({
      ...record,
      message: `Routine ${i}`,
    })
  expect(
    await r.ask({
      action: 'create',
      message: 'Over cap',
      schedule: { time: '09:00' },
    }),
  ).toContain('20 routines')
  expect(await r.stored()).toHaveLength(20)
  r.t.model.push(
    fauxToolCall('feishu_routines', { action: 'list' }),
    fauxText('SDK done'),
  )
  await r.t.run('List channel routines')
  expect(r.t.model.calls.at(-1)!.toolResults.at(-1)!.output).toContain('active')
})

test.each([
  ['2026-03-08T02:30', '2026-03-08T07:30:00.000Z', '2026-03-08 03:30'],
  ['2026-11-01T01:30', '2026-11-01T05:30:00.000Z', '2026-11-01 01:30'],
])(
  'a local one-off %s uses the approved DST resolution and reports the saved time',
  async (at, utc, local) => {
    const r = setup()
    await r.t.vela.startChannels()
    const created = JSON.parse(
      await r.ask({
        action: 'create',
        message: 'DST reminder',
        schedule: { at },
      }),
    )
    expect((await r.stored())[0].schedule).toEqual({ at: utc })
    expect(created.scheduleText).toBe(local)
    expect(created.nextRun).toBe(local)
    r.t.model.push(fauxText('DST reminder result'))
    r.clock.advance(utc)
    await r.t.internals.gateway.routines.drain()
    expect(r.fake.sent.at(-1)!.text).toContain(
      '<at user_id="ou_alice"></at> DST reminder result',
    )
    expect(await r.stored()).toEqual([])
  },
)
