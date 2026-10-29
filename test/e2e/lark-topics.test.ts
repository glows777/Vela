import { afterEach, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileSessionStorage, silentLogger } from '@glows777/vela-core'
import { fauxHang, fauxText } from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { fakeLark, historyMessage, larkEvent } from '../support/lark.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

async function until(condition: () => boolean) {
  const deadline = Date.now() + 1000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for topic')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

test('Lark mentions in two topics run concurrently with separate transcripts', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    responses: [fauxHang('working A'), fauxHang('working B')],
    allowPendingResponses: true,
    extensions: [
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  const first = larkEvent({
    message_id: 'trigger_a',
    content: '{"text":"task alpha"}',
  })
  Object.assign(first.message, { root_id: 'root_a', thread_id: 'thread_a' })
  const second = larkEvent({
    message_id: 'trigger_b',
    content: '{"text":"task beta"}',
  })
  Object.assign(second.message, { root_id: 'root_b', thread_id: 'thread_b' })
  try {
    fake.deliver(first)
    await until(() => t.model.calls.length === 1)
    fake.deliver(second)
    await until(() => t.model.calls.length === 2)
    const transcript = (index: number) =>
      t.model.calls[index]!.prompt.filter(
        (message) => message.role !== 'system',
      )
    // The topic context lists other topics; transcripts stay separate.
    expect(JSON.stringify(transcript(0))).not.toContain('task beta')
    expect(JSON.stringify(transcript(1))).not.toContain('task alpha')
    const sessions = t.vela
      .sessions()
      .filter((session) => session.channel === 'lark')
    expect(sessions).toHaveLength(2)
    expect(sessions.every((session) => session.isRunning)).toBe(true)
  } finally {
    await t.internals.gateway.stopAll()
  }
})

test('with readUntagged off, top-level Lark attachments are dropped before preparation or content logging', async () => {
  const fake = fakeLark()
  const logs: string[] = []
  const t = createTestVela({
    responses: [],
    logger: {
      ...silentLogger,
      info: (line) => logs.push(line),
      warn: (line) => logs.push(line),
    },
    extensions: [
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: [{ id: 'oc_group', readUntagged: false }],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(
    larkEvent({
      mentions: [],
      message_type: 'file',
      content: '{"file_key":"private-key","file_name":"private-name"}',
    }),
  )
  await t.internals.gateway.stopAll()
  expect(fake.nameCalls).toEqual([])
  expect(fake.historyCalls).toEqual([])
  expect(fake.resourceCalls).toEqual([])
  expect(t.model.calls).toEqual([])
  expect(
    t.vela.sessions().filter((session) => session.channel === 'lark'),
  ).toEqual([])
  expect(logs.join('\n')).not.toContain('private-')
})

test.each([false, true])(
  'a running topic reply steers without rereading history or Queue/Steer cards (mentioned=%s)',
  async (mentioned) => {
    const fake = fakeLark()
    const t = createTestVela({
      responses: [fauxHang('working')],
      extensions: [
        lark({
          appId: 'bot',
          owners: ['ou_alice'],
          chats: ['oc_group'],
          transport: fake.transport,
        }),
      ],
    })
    await t.vela.ready()
    await t.vela.startChannels()
    try {
      fake.deliver(
        larkEvent({
          root_id: 'root',
          thread_id: 'thread',
          content: '{"text":"original task"}',
        }),
      )
      await until(() => t.model.calls.length === 1)
      fake.topicHistoryCalls.length = 0
      fake.deliver(
        larkEvent(
          {
            root_id: 'root',
            thread_id: 'thread',
            mentions: mentioned
              ? [{ key: '@_user_1', id: { open_id: 'ou_bot' } }]
              : [],
            content: '{"text":"use blue"}',
          },
          'ou_bob',
        ),
      )
      await until(() =>
        t
          .eventsOf('queue_update')
          .some((event) =>
            event.steering.some((text) => text.includes('use blue')),
          ),
      )
      expect(fake.topicHistoryCalls).toEqual([])
      expect(fake.cards).toHaveLength(1)
      expect(JSON.stringify(fake.cards[0])).not.toContain('Queue')
      expect(JSON.stringify(fake.cards[0])).not.toContain('Steer')
      expect(t.eventsOf('agent_start')).toHaveLength(1)
    } finally {
      await t.internals.gateway.stopAll()
    }
  },
)

test('a topic mention reads every history page by thread ID including earlier bot answers', async () => {
  const fake = fakeLark()
  fake.topicHistory.push(
    Array.from({ length: 50 }, (_, index) =>
      historyMessage(`old_${index}`, 'ou_alice', `fact ${index}`),
    ),
    [
      {
        ...historyMessage('bot_answer', 'bot', 'earlier answer'),
        sender: { id: 'bot', sender_type: 'app' },
      },
      historyMessage('trigger', 'ou_bob', 'current question'),
    ],
  )
  const t = createTestVela({
    responses: [fauxText('done')],
    extensions: [
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(
    larkEvent(
      {
        message_id: 'trigger',
        root_id: 'root',
        thread_id: 'thread',
        content: '{"text":"current question"}',
      },
      'ou_bob',
    ),
  )
  await until(() => fake.sent.length === 1)
  expect(fake.topicHistoryCalls).toEqual([
    { threadId: 'thread', pageToken: undefined },
    { threadId: 'thread', pageToken: '1' },
  ])
  expect(fake.historyCalls).toEqual([])
  const input = t.model.calls[0]!.lastUserText
  expect(input).toContain('fact 0')
  expect(input).toContain('fact 49')
  expect(input).toContain('earlier answer')
  expect(input.match(/current question/g)).toHaveLength(1)
})

test('topic history permission failure is visible and does not run with partial context', async () => {
  const fake = fakeLark()
  fake.failHistory()
  const t = createTestVela({
    responses: [],
    extensions: [
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(larkEvent({ root_id: 'root', thread_id: 'thread' }))
  await until(() => fake.sent.length === 1)
  expect(fake.sent[0]!.text).toContain('history permission denied')
  expect(fake.sent[0]!.text).toContain('im:message.group_msg')
  expect(t.model.calls).toEqual([])
})

test('a topic answer does not advance the top-level group history boundary', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    responses: [fauxText('topic done'), fauxText('group done')],
    extensions: [
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(larkEvent({ root_id: 'root', thread_id: 'thread' }))
  await until(() => fake.sent.length === 1)
  fake.history.push(
    historyMessage('discussion', 'ou_bob', 'top-level context', '1000'),
  )
  fake.deliver(larkEvent({ content: '{"text":"summarize the discussion"}' }))
  await until(() => fake.sent.length === 2)
  expect(t.model.calls[1]?.lastUserText).toContain('top-level context')
})

test('unowned untagged topics serialize admission without preparation, saves or empty files', async () => {
  const fake = fakeLark()
  const logs: string[] = []
  let storage: ReturnType<typeof fileSessionStorage>
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let loads = 0
  let activeLoads = 0
  let maximumLoads = 0
  let saves = 0
  const t = createTestVela({
    responses: [],
    logger: {
      ...silentLogger,
      info: (line) => logs.push(line),
      warn: (line) => logs.push(line),
      error: (line) => logs.push(line),
    },
    sessionStorage: {
      load: async (id) => {
        loads++
        maximumLoads = Math.max(maximumLoads, ++activeLoads)
        await held
        try {
          return await storage.load(id)
        } finally {
          activeLoads--
        }
      },
      append: async (id, entries) => {
        saves++
        await storage.append(id, entries)
      },
    },
    extensions: [
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  const directory = join(t.cwd, 'probe-storage')
  storage = fileSessionStorage(directory)
  await t.vela.ready()
  await t.vela.startChannels()
  const input = {
    mentions: [],
    root_id: 'unknown',
    thread_id: 'thread',
    message_type: 'file',
    content: '{"file_key":"private-key","file_name":"private-name"}',
  }
  try {
    fake.deliver(larkEvent(input))
    fake.deliver(larkEvent(input, 'ou_bob'))
    await until(() => loads === 1)
    expect(fake.nameCalls).toEqual([])
    expect(fake.topicHistoryCalls).toEqual([])
    expect(fake.resourceCalls).toEqual([])
    expect(t.model.calls).toEqual([])
  } finally {
    release()
  }
  await until(() => loads === 2 && t.vela.sessions().length === 1)
  expect(maximumLoads).toBe(1)
  expect(saves).toBe(0)
  expect(existsSync(directory)).toBe(false)
  expect(existsSync(join(t.vela.dataDir, 'channels', 'lark-oc_group'))).toBe(
    false,
  )
  expect(fake.nameCalls).toEqual([])
  expect(fake.topicHistoryCalls).toEqual([])
  expect(fake.resourceCalls).toEqual([])
  expect(fake.sent).toEqual([])
  expect(logs.join('\n')).not.toContain('private-')
})

test('untagged replies resume a persisted topic after restart and idle replies start the next run', async () => {
  const firstFake = fakeLark()
  const first = createTestVela({
    responses: [fauxText('remembered')],
    extensions: [
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: firstFake.transport,
      }),
    ],
  })
  await first.vela.ready()
  await first.vela.startChannels()
  firstFake.deliver(
    larkEvent({
      root_id: 'root',
      thread_id: 'thread',
      content: '{"text":"remember cobalt"}',
    }),
  )
  await until(() => firstFake.sent.length === 1)
  await first.cleanup({ keepDir: true })
  const fake = fakeLark()
  const second = createTestVela({
    cwd: first.cwd,
    responses: [fauxText('cobalt'), fauxText('next answer')],
    extensions: [
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  try {
    await second.vela.ready()
    await second.vela.startChannels()
    fake.deliver(
      larkEvent(
        {
          mentions: [],
          root_id: 'root',
          thread_id: 'thread',
          content: '{"text":"what color?"}',
        },
        'ou_bob',
      ),
    )
    await until(() => fake.sent.length === 1)
    expect(JSON.stringify(second.model.calls[0]?.prompt)).toContain(
      'remember cobalt',
    )
    fake.deliver(
      larkEvent({
        mentions: [],
        root_id: 'root',
        thread_id: 'thread',
        content: '{"text":"next question"}',
      }),
    )
    await until(() => fake.sent.length === 2)
    expect(second.eventsOf('agent_start')).toHaveLength(2)
    expect(fake.topicHistoryCalls).toEqual([])
  } finally {
    await second.cleanup()
    rmSync(first.cwd, { recursive: true, force: true })
  }
})

test('topic Stop affects only its run, expires, and preserves context for the next message', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    responses: [fauxHang('A'), fauxHang('B'), fauxText('continued')],
    allowPendingResponses: true,
    extensions: [
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  try {
    fake.deliver(
      larkEvent({
        root_id: 'root_a',
        thread_id: 'thread_a',
        content: '{"text":"task alpha"}',
      }),
    )
    await until(() => t.model.calls.length === 1)
    fake.deliver(
      larkEvent({
        root_id: 'root_b',
        thread_id: 'thread_b',
        content: '{"text":"task beta"}',
      }),
    )
    await until(() => t.model.calls.length === 2)
    await until(() => fake.cards.length === 2)
    expect(fake.click(0, 'stop')).toMatchObject({ toast: { type: 'success' } })
    await until(() =>
      fake.sent.some((message) => message.text.includes('Stopped')),
    )
    expect(
      t.vela.sessions().filter((session) => session.isRunning),
    ).toHaveLength(1)
    expect(fake.click(0, 'stop')).toMatchObject({ toast: { type: 'info' } })
    fake.deliver(
      larkEvent({
        mentions: [],
        root_id: 'root_a',
        thread_id: 'thread_a',
        content: '{"text":"continue alpha"}',
      }),
    )
    await until(() =>
      fake.sent.some(
        (message) => message.text === '<at user_id="ou_alice"></at> continued',
      ),
    )
    const transcript = t.model.calls[2]?.prompt.filter(
      (message) => message.role !== 'system',
    )
    expect(JSON.stringify(transcript)).toContain('task alpha')
    expect(JSON.stringify(transcript)).not.toContain('task beta')
  } finally {
    await t.internals.gateway.stopAll()
  }
})

test('a failed topic Stop-card send reports its cause without starting uncontrolled work', async () => {
  const fake = fakeLark()
  fake.transport.sendCard = async () => {
    throw new Error('card permission denied')
  }
  const t = createTestVela({
    responses: [],
    extensions: [
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(larkEvent({ root_id: 'root', thread_id: 'thread' }))
  await until(() => t.eventsOf('channel_error').length === 1)
  expect(fake.sent[0]?.text).toContain('card permission denied')
  expect(t.model.calls).toEqual([])
})

test('an explicit mention in an owned topic uses stored context without reinjecting platform history', async () => {
  const fake = fakeLark()
  const t = createTestVela({
    responses: [fauxText('earlier answer'), fauxText('next answer')],
    extensions: [
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(
    larkEvent({
      root_id: 'root',
      thread_id: 'thread',
      content: '{"text":"first question"}',
    }),
  )
  await until(() => fake.sent.length === 1)
  fake.topicHistoryCalls.length = 0
  fake.deliver(
    larkEvent({
      root_id: 'root',
      thread_id: 'thread',
      content: '{"text":"follow-up mention"}',
    }),
  )
  await until(() => fake.sent.length === 2)
  expect(fake.topicHistoryCalls).toEqual([])
  expect(t.model.calls[1]?.lastUserText).not.toContain('[Topic history]')
  expect(JSON.stringify(t.model.calls[1]?.prompt)).toContain('earlier answer')
})

test('first topic entry excludes later history replies which arrive through their own events', async () => {
  const fake = fakeLark()
  fake.topicHistory.push([
    historyMessage('earlier', 'ou_alice', 'earlier context', '1000'),
    historyMessage('peer', 'ou_bob', 'same millisecond context', '2000'),
    historyMessage('later', 'ou_bob', 'later instruction', '3000'),
  ])
  const t = createTestVela({
    responses: [fauxText('first answer'), fauxText('later answer')],
    extensions: [
      lark({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(
    larkEvent({
      message_id: 'trigger',
      root_id: 'root',
      thread_id: 'thread',
      create_time: '2000',
      content: '{"text":"initial task"}',
    }),
  )
  await until(() => fake.sent.length === 1)
  expect(t.model.calls[0]?.lastUserText).not.toContain('later instruction')
  expect(t.model.calls[0]?.lastUserText).toContain('same millisecond context')
  fake.deliver(
    larkEvent(
      {
        mentions: [],
        message_id: 'later',
        root_id: 'root',
        thread_id: 'thread',
        create_time: '3000',
        content: '{"text":"later instruction"}',
      },
      'ou_bob',
    ),
  )
  await until(() => fake.sent.length === 2)
  expect(
    JSON.stringify(t.model.calls[1]?.prompt).match(/later instruction/g),
  ).toHaveLength(1)
})
