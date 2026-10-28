import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVela, type IncomingMessage } from '@glows777/vela'
import { channelSessionId } from '@glows777/vela-channels'
import { drainChannels } from '@glows777/vela-channels/testing'
import {
  createFauxModel,
  fauxHang,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { z } from 'zod'
import { fakeLark, larkEvent } from '../support/lark.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(
  options: {
    cwd?: string
    enabled?: Set<string>
    defaultTarget?: { channel: string; chatId: string }
    tools?: string[]
    permissions?: { [name: string]: 'deny' }
  } = {},
) {
  const cwd = options.cwd ?? (await mkdtemp(join(tmpdir(), 'vela-events-')))
  if (!options.cwd)
    cleanups.push(() => rm(cwd, { recursive: true, force: true }))
  const model = createFauxModel({ responses: [] })
  const enabled = options.enabled ?? new Set(['one', 'two'])
  const sent: {
    channel: string
    message: IncomingMessage | { text: string }
  }[] = []
  const logs: string[] = []
  const handlers = new Map<
    string,
    (msg: IncomingMessage) => void | Promise<void>
  >()
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let commandCalls = 0
  let sequence = 0
  const vela = createVela({
    cwd,
    dataDir: 'data',
    model,
    eventDefaultTarget: options.defaultTarget,
    logger: {
      debug() {},
      info: (s) => logs.push(s),
      warn: (s) => logs.push(s),
      error: (s) => logs.push(s),
    },
    extensions: [
      function gateTools(api) {
        api.registerCommand('explode', {
          description: 'Must never execute from an event',
          handler() {
            commandCalls++
          },
        })
        api.registerTool({
          name: 'wait',
          description: 'Hold human work',
          inputSchema: z.object({}),
          execute: async () => {
            entered.resolve()
            await gate.promise
            return 'released'
          },
        })
      },
      function chats(api) {
        for (const name of ['chat', 'other'])
          api.registerChannel({
            name,
            description: name,
            start() {},
            stop() {},
            onMessage(handler) {
              handlers.set(name, handler)
            },
            canRecover: (msg) => enabled.has(msg.channelId),
            sessionOptions: () => ({
              cwd,
              tools: options.tools,
              permissions: options.permissions,
            }),
            async send(message) {
              sent.push({ channel: name, message })
            },
          })
      },
    ],
  })
  cleanups.push(async () => {
    gate.resolve()
    await vela.dispose()
  })
  const topic = { rootId: 'root', threadId: 'thread' }
  async function human(
    text: string,
    chatId = 'one',
    inTopic = true,
    channel = 'chat',
  ) {
    await handlers.get(channel)!({
      channelId: chatId,
      senderId: 'alice',
      senderName: 'Alice',
      text,
      replyToId: `human-${++sequence}`,
      ...(inTopic ? { topic } : {}),
    })
  }
  async function subscription(
    input: unknown,
    chatId = 'one',
    inTopic = true,
    channel = 'chat',
  ) {
    model.push(
      fauxToolCall('channel_subscriptions', input),
      fauxText('Subscription handled'),
    )
    await human('Manage subscriptions', chatId, inTopic, channel)
    const result = model.calls.at(-1)!.toolResults.at(-1)!.output
    try {
      return JSON.parse(result)
    } catch {
      return result
    }
  }
  const stored = async () =>
    JSON.parse(
      await readFile(join(cwd, 'data/channels/subscriptions.json'), 'utf8'),
    ).subscriptions
  return {
    vela,
    cwd,
    model,
    human,
    subscription,
    stored,
    enabled,
    sent,
    logs,
    gate,
    entered,
    commandCalls: () => commandCalls,
  }
}

const event = {
  source: 'build',
  key: 'repo#171',
  deliveryId: 'delivery-1',
  summary: 'Build completed',
}

test('subscriptions persist, are idempotent and stay on the logical topic across restart', async () => {
  const f = await fixture()
  await f.vela.startChannels()
  const created = await f.subscription({
    action: 'create',
    source: event.source,
    key: event.key,
  })
  const duplicate = await f.subscription({
    action: 'create',
    source: event.source,
    key: event.key,
  })
  expect(duplicate.id).toBe(created.id)
  expect(await f.stored()).toHaveLength(1)
  const key = channelSessionId('chat', 'one', 'root')
  await f.human('!restart')
  const index = JSON.parse(
    await readFile(join(f.cwd, 'data/channels/index.json'), 'utf8'),
  )
  const active = index.records.find(
    (r: { key: string }) => r.key === key,
  ).activeSessionId
  expect(active).not.toBe(key)
  f.model.push(fauxText('Event after restart'))
  await f.vela.publishEvent(event)
  await drainChannels(f.vela)
  expect(f.vela.session(active).cwd).toBe(f.cwd)
  expect(f.model.calls.at(-1)!.lastUserText).toContain(
    'External event (untrusted data)',
  )
  expect(f.model.calls.at(-1)!.lastUserText).toContain(event.summary)
  await f.vela.dispose()
  const again = await fixture({ cwd: f.cwd })
  await again.vela.startChannels()
  const listed = await again.subscription({ action: 'list' })
  expect(listed.subscriptions.map((r: { id: string }) => r.id)).toEqual([
    created.id,
  ])
})

test('subscription removal is scoped to the chat and cannot choose a target', async () => {
  const f = await fixture()
  await f.vela.startChannels()
  const created = await f.subscription({
    action: 'create',
    source: event.source,
    key: event.key,
  })
  expect(
    (await f.subscription({ action: 'list' }, 'two')).subscriptions,
  ).toEqual([])
  expect(
    (await f.subscription({ action: 'remove', id: created.id }, 'two')).removed,
  ).toBe(false)
  const invalid = await f.subscription({
    action: 'create',
    source: 'x',
    key: 'x',
    target: 'two',
  })
  expect(JSON.stringify(invalid)).toMatch(/invalid|unrecognized/i)
  expect(await f.stored()).toHaveLength(1)
  expect(
    (await f.subscription({ action: 'remove', id: created.id })).removed,
  ).toBe(true)
  expect(
    (await f.subscription({ action: 'remove', id: created.id })).removed,
  ).toBe(false)
})

test.each(['!stop', '/explode', '/skill:danger'])(
  'event payload %s stays ordinary untrusted data',
  async (summary) => {
    const f = await fixture()
    await f.vela.startChannels()
    await f.subscription({
      action: 'create',
      source: event.source,
      key: event.key,
    })
    f.model.push(fauxText('External data handled'))
    const before = f.model.calls.length
    await f.vela.publishEvent({
      ...event,
      summary,
      details: '/explode\n!restart',
    })
    await drainChannels(f.vela)
    expect(f.model.calls).toHaveLength(before + 1)
    expect(f.model.calls.at(-1)!.lastUserText).toStartWith(
      'External event (untrusted data)',
    )
    expect(f.model.calls.at(-1)!.lastUserText).toContain(summary)
    expect(f.commandCalls()).toBe(0)
    expect(f.sent.some((s) => /Stopped|Restarted/.test(s.message.text))).toBe(
      false,
    )
  },
)

test('final publishes enqueue to every target before cleanup without steering or waiting for the model', async () => {
  const f = await fixture()
  await f.vela.startChannels()
  await f.subscription({
    action: 'create',
    source: event.source,
    key: event.key,
  })
  await f.subscription(
    { action: 'create', source: event.source, key: event.key },
    'two',
  )
  f.model.push(
    fauxToolCall('gateTools_wait', {}),
    fauxText('Human completed'),
    fauxText('Final one'),
    fauxText('Final two'),
  )
  const human = f.human('Hold this work')
  await f.entered.promise
  await f.vela.publishEvent({ ...event, final: true })
  expect(await f.stored()).toEqual([])
  expect(f.model.calls.at(-1)!.lastUserText).toContain('Hold this work')
  f.gate.resolve()
  await human
  await drainChannels(f.vela)
  const external = f.model.calls.filter((c) =>
    c.lastUserText.startsWith('External event (untrusted data)'),
  )
  expect(external).toHaveLength(2)
})

test.each(['exact', 'padded'] as const)(
  'disabled matching targets never leak to default; only unmatched events use the existing %s SDK default',
  async (address) => {
    const f = await fixture({
      defaultTarget:
        address === 'exact'
          ? { channel: 'chat', chatId: 'two' }
          : { channel: ' chat ', chatId: ' two ' },
    })
    await f.vela.startChannels()
    await f.subscription({
      action: 'create',
      source: event.source,
      key: event.key,
    })
    f.model.push(fauxText('Default chat exists'))
    await f.human('Hello', 'two', false)
    f.enabled.delete('one')
    const before = f.model.calls.length
    await f.vela.publishEvent(event)
    await drainChannels(f.vela)
    expect(f.model.calls).toHaveLength(before)
    f.model.push(fauxText('Default event'))
    await f.vela.publishEvent({ ...event, key: 'unmatched' })
    await drainChannels(f.vela)
    expect(f.model.calls).toHaveLength(before + 1)
    expect(f.sent.at(-1)!.message.text).toBe('Default event')
  },
)

test('generic subscription visibility works on both channels, respects curated tools and hides from ordinary sessions', async () => {
  const f = await fixture()
  await f.vela.startChannels()
  await f.subscription({ action: 'list' }, 'one', true, 'other')
  expect(f.model.calls.at(-1)!.tools).toContain('channel_subscriptions')
  f.model.push(fauxText('Plain SDK'))
  await f.vela.session('plain').prompt('Hello')
  expect(f.model.calls.at(-1)!.tools).not.toContain('channel_subscriptions')
  const limited = await fixture({ tools: [], permissions: { bash: 'deny' } })
  await limited.vela.startChannels()
  limited.model.push(fauxText('Curated channel'))
  await limited.human('Hello')
  expect(limited.model.calls.at(-1)!.tools).toEqual([])
})

test('an interrupted external ordinary message recovers its own input instead of the previous human task', async () => {
  const first = await fixture()
  await first.vela.startChannels()
  await first.subscription({
    action: 'create',
    source: event.source,
    key: event.key,
  })
  first.model.push(fauxHang())
  const started = Promise.withResolvers<void>()
  first.vela.subscribe((e) => {
    if (e.type === 'agent_start') started.resolve()
  })
  await first.vela.publishEvent(event)
  await started.promise
  await first.vela.dispose()
  const again = await fixture({ cwd: first.cwd })
  again.model.push(fauxText('Recovered external input'))
  await again.vela.startChannels()
  await drainChannels(again.vela)
  expect(again.model.calls).toHaveLength(1)
  expect(again.model.calls[0]!.lastUserText).toStartWith(
    'External event (untrusted data)',
  )
  expect(again.model.calls[0]!.lastUserText).toContain(event.summary)
})

test('SDK publishing rejects before startup and after disposal', async () => {
  const f = await fixture()
  await expect(f.vela.publishEvent(event)).rejects.toThrow(/start|running/i)
  await f.vela.startChannels()
  await f.vela.dispose()
  await expect(f.vela.publishEvent(event)).rejects.toThrow(/stop|running/i)
})

test('malformed subscription state rejects startup before a transport connects', async () => {
  const f = await fixture()
  await mkdir(join(f.cwd, 'data/channels'), { recursive: true })
  await writeFile(
    join(f.cwd, 'data/channels/subscriptions.json'),
    '{"version":99,"subscriptions":[]}',
  )
  await expect(f.vela.startChannels()).rejects.toThrow(
    /Invalid channel subscriptions/,
  )
  expect(f.vela.runningChannels()).toEqual([])
})

test('subscription write failure is reported and never commits a phantom subscription', async () => {
  const f = await fixture()
  await f.vela.startChannels()
  const original = await f.subscription({
    action: 'create',
    source: 'one',
    key: 'original',
  })
  const path = join(f.cwd, 'data/channels/subscriptions.json')
  const committed = await readFile(path, 'utf8')
  await rm(path)
  await mkdir(path)
  const failed = await f.subscription({
    action: 'create',
    source: 'two',
    key: 'failed',
  })
  expect(JSON.stringify(failed)).toMatch(/EISDIR|ENOTDIR|directory/i)
  await rm(path, { recursive: true })
  await writeFile(path, committed)
  expect(
    (await f.subscription({ action: 'list' })).subscriptions.map(
      (r: { id: string }) => r.id,
    ),
  ).toEqual([original.id])
  f.model.push(fauxText('Original subscription still works'))
  await f.vela.publishEvent({ ...event, source: 'one', key: 'original' })
  await drainChannels(f.vela)
  expect(f.model.calls.at(-1)!.lastUserText).toContain(event.summary)
  await f.subscription({ action: 'create', source: 'three', key: 'later' })
  expect((await f.stored()).map((r: { key: string }) => r.key)).toEqual([
    'original',
    'later',
  ])
  expect((await f.stored())[0].id).toBe(original.id)
})

test('a permission deny blocks the subscription tool even with explicit selection', async () => {
  const f = await fixture({
    tools: ['channel_subscriptions'],
    permissions: { channel_subscriptions: 'deny' },
  })
  await f.vela.startChannels()
  const result = await f.subscription({
    action: 'create',
    source: event.source,
    key: event.key,
  })
  expect(JSON.stringify(result)).toMatch(
    /denied|disabled|unavailable|not available|not found|unknown/i,
  )
  expect(f.model.calls[0]!.tools).not.toContain('channel_subscriptions')
})

test.each(['group', 'topic'] as const)(
  'Lark %s external events use real reply anchors and keep the original requester',
  async (target) => {
    const cwd = await mkdtemp(join(tmpdir(), 'vela-events-lark-'))
    const fake = fakeLark()
    const model = createFauxModel({
      responses: [
        fauxToolCall('channel_subscriptions', {
          action: 'create',
          source: event.source,
          key: event.key,
        }),
        fauxText('Subscribed'),
        fauxText('External result'),
      ],
    })
    const vela = createVela({
      cwd,
      dataDir: 'data',
      model,
      extensions: [
        lark({
          owners: ['ou_alice'],
          chats: ['oc_group'],
          transport: fake.transport,
        }),
      ],
    })
    cleanups.push(
      () => rm(cwd, { recursive: true, force: true }),
      () => vela.dispose(),
    )
    await vela.startChannels()
    const done = Promise.withResolvers<void>()
    const unsubscribe = vela.subscribe((e) => {
      if (e.type === 'channel_reply' && e.text === 'Subscribed') done.resolve()
    })
    fake.deliver(
      larkEvent({
        ...(target === 'topic' ? { root_id: 'root', thread_id: 'thread' } : {}),
        content: '{"text":"Subscribe to this build"}',
      }),
    )
    await done.promise
    unsubscribe()
    await drainChannels(vela)
    const before = fake.sent.length
    const reactions = fake.reactions.length
    await vela.publishEvent(event)
    await drainChannels(vela)
    const sent = fake.sent.slice(before)
    expect(fake.reactions.slice(reactions)).toEqual([])
    if (target === 'group') {
      expect(sent[0]!.text).toStartWith('External event (untrusted data)')
      expect(sent[0]!.chatId).toBe('oc_group')
      expect(sent.at(-1)!.messageId).toBe(`sent_${before + 1}`)
    } else expect(sent.at(-1)!.messageId).toBe('root')
    expect(sent.at(-1)!.text).toContain('External result')
    expect(model.calls.at(-1)!.lastUserText).toStartWith(
      'External event (untrusted data)',
    )
    await vela.dispose()
    const index = JSON.parse(
      await readFile(join(cwd, 'data/channels/index.json'), 'utf8'),
    )
    expect(
      index.records.find((r: { rootId?: string }) =>
        target === 'group' ? !r.rootId : r.rootId === 'root',
      ).requester,
    ).toEqual({ id: 'ou_alice', name: 'Alice' })
  },
)

test.each(['rejected', 'missing receipt', 'index write failure'] as const)(
  'a %s Lark external input skips delivery without replying to the previous human',
  async (failure) => {
    const cwd = await mkdtemp(join(tmpdir(), 'vela-event-announcement-'))
    const fake = fakeLark()
    const logs: string[] = []
    const model = createFauxModel({
      responses: [
        fauxToolCall('channel_subscriptions', {
          action: 'create',
          source: event.source,
          key: event.key,
        }),
        fauxText('Subscribed'),
      ],
    })
    const vela = createVela({
      cwd,
      dataDir: 'data',
      model,
      logger: {
        debug() {},
        info() {},
        warn: (text) => logs.push(text),
        error: (text) => logs.push(text),
      },
      extensions: [
        lark({
          owners: ['ou_alice'],
          chats: ['oc_group'],
          transport: fake.transport,
        }),
      ],
    })
    cleanups.push(
      () => rm(cwd, { recursive: true, force: true }),
      () => vela.dispose(),
    )
    await vela.startChannels()
    const subscribed = Promise.withResolvers<void>()
    const off = vela.subscribe((e) => {
      if (e.type === 'channel_reply' && e.text === 'Subscribed')
        subscribed.resolve()
    })
    fake.deliver(
      larkEvent({
        message_id: 'om_human',
        content: '{"text":"Subscribe to this build"}',
      }),
    )
    await subscribed.promise
    off()
    await drainChannels(vela)
    const before = fake.sent.length
    const calls = model.calls.length
    const send = fake.transport.send
    const indexPath = join(cwd, 'data/channels/index.json')
    const indexContent = await readFile(indexPath, 'utf8')
    let announcements = 0
    fake.transport.send = async () => {
      announcements++
      if (failure === 'rejected') throw new Error('announcement send denied')
      if (failure === 'index write failure')
        return send('oc_group', 'Unexpected announcement')
      return undefined
    }
    if (failure === 'index write failure') {
      await rm(indexPath)
      await mkdir(indexPath)
    }
    try {
      await vela.publishEvent(event)
      await drainChannels(vela)
      expect(announcements).toBe(failure === 'index write failure' ? 0 : 1)
      expect(fake.sent.slice(before)).toEqual([])
      expect(model.calls).toHaveLength(calls)
      expect(logs.join('\n')).toMatch(
        failure === 'index write failure'
          ? /EISDIR|ENOTDIR/
          : /External event skipped/,
      )
      if (failure === 'rejected')
        expect(logs.join('\n')).toContain('announcement send denied')
      if (failure !== 'index write failure') {
        const index = JSON.parse(
          await readFile(join(cwd, 'data/channels/index.json'), 'utf8'),
        )
        expect(index.records[0].pendingMessageIds).toEqual([])
      }
    } finally {
      if (failure === 'index write failure') {
        await rm(indexPath, { recursive: true })
        await writeFile(indexPath, indexContent)
      }
      fake.transport.send = send
      model.push(fauxText('New event after transport recovery'))
      await vela.publishEvent({ ...event, deliveryId: 'next-delivery' })
      await drainChannels(vela)
    }
    expect(fake.sent.at(-1)!.messageId).not.toBe('om_human')
    expect(fake.sent.at(-1)!.text).toContain(
      'New event after transport recovery',
    )
  },
)

test('a human input still receives its own admission-write error reply', async () => {
  const f = await fixture()
  await f.vela.startChannels()
  f.model.push(fauxText('Original human result'))
  await f.human('First human task')
  const path = join(f.cwd, 'data/channels/index.json')
  const committed = await readFile(path, 'utf8')
  await rm(path)
  await mkdir(path)
  const before = f.sent.length
  try {
    await f.human('New human task')
    expect(f.sent.slice(before).map((s) => s.message)).toEqual([
      expect.objectContaining({
        replyToId: 'human-2',
        text: expect.stringContaining("Couldn't update task feedback:"),
      }),
    ])
    expect(f.model.calls).toHaveLength(1)
  } finally {
    await rm(path, { recursive: true })
    await writeFile(path, committed)
    f.model.push(fauxText('After storage recovery'))
    await f.human('New request after recovery')
  }
})
