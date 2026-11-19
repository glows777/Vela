import { afterEach, expect, spyOn, test } from 'bun:test'
import { fauxText } from '@glows777/vela-core/testing'
import { type LarkHostEvent, LarkSubmitError, lark } from '@glows777/vela-lark'
import { fakeLark, historyMessage, larkEvent } from '../support/lark.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

const chatId = 'oc_group'
const group = 'lark-oc_group'
async function waitReply(
  t: Awaited<ReturnType<typeof setup>>['t'],
  text: string,
) {
  const deadline = Date.now() + 2000
  while (!t.eventsOf('channel_reply').some((event) => event.text === text)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${text}`)
    await Bun.sleep(5)
  }
}

const author = { id: 'desktop-alex', name: 'Alex' }

async function setup(
  responses: ReturnType<typeof fauxText>[],
  fake = fakeLark(),
) {
  const t = createTestVela({
    responses,
    extensions: [
      lark({
        appId: 'bot',
        chats: [{ id: chatId, readUntagged: false }, 'oc_other'],
        transport: fake.transport,
      }),
    ],
  })
  await t.vela.ready()
  const host = t.vela.channel('lark')
  const events: LarkHostEvent[] = []
  host.onEvent((event) => events.push(event))
  await t.vela.startChannels()
  return { t, host, fake, events }
}

test('SDK history pages follow the enabled group or its exact owned topic', async () => {
  const fake = fakeLark()
  type Options = Parameters<typeof fake.transport.searchMessages>[1]
  const calls: Options[] = []
  fake.transport.searchMessages = async (_chatId, options) => {
    calls.push(options)
    const rows = [
      historyMessage('new', 'ou_bob', 'new', '1250'),
      historyMessage('old', 'ou_alice', 'old', '500'),
    ].filter((row) => Number(row.create_time) < Number(options.endTime) * 1000)
    const offset = Number(options.pageToken ?? 0)
    const next = offset + options.limit
    return {
      items: rows.slice(offset, next),
      pageToken: next < rows.length ? String(next) : undefined,
    }
  }
  fake.topicHistory.push(
    [
      { ...historyMessage('root', 'ou_alice', 'root'), deleted: true },
      historyMessage('human', 'ou_alice', 'inside'),
      {
        ...historyMessage('reply', 'bot', 'answer'),
        sender: { id: 'bot', sender_type: 'app' },
      },
    ],
    [historyMessage('last', 'ou_bob', 'later')],
  )
  const { host, t } = await setup([fauxText('seed')], fake)
  await host.submit({
    channelId: chatId,
    senderId: 'ou_alice',
    senderName: 'Alice',
    text: 'seed',
    replyToId: 'seed_anchor',
    chatKind: 'group',
  })
  using clock = spyOn(Date, 'now')
  clock.mockReturnValueOnce(1750)
  const first = await host.messages({ chatId, sessionId: group, limit: 1 })
  expect(first.messages).toEqual([
    {
      id: 'new',
      sessionId: group,
      text: 'new',
      role: 'user',
      senderName: 'Bob',
      createdAt: '1970-01-01T00:00:01.250Z',
    },
  ])
  first.messages[0]!.text = 'edited'
  clock.mockReturnValueOnce(4750)
  const second = await host.messages({
    chatId,
    sessionId: group,
    cursor: first.nextCursor,
  })
  clock.mockRestore()
  expect(second.messages.map((m) => m.id)).toEqual(['old'])
  expect(calls[0]?.endTime).toBe('2')
  expect(calls[1]).toEqual({ ...calls[0]!, pageToken: '1' })
  expect(
    (await host.messages({ chatId, sessionId: group, limit: 1 })).messages[0]
      ?.text,
  ).toBe('new')

  t.model.push(fauxText('inside reply'))
  fake.deliver(
    larkEvent({ message_id: 'mention', root_id: 'root', thread_id: 'thread' }),
  )
  await waitReply(t, 'inside reply')
  const topic = host.sessions(chatId).find((s) => s.topic)!
  const a = await host.messages({
    chatId,
    sessionId: topic.sessionId,
    limit: 2,
  })
  expect(a.messages.map((m) => m.id)).toEqual(['human'])
  const b = await host.messages({
    chatId,
    sessionId: topic.sessionId,
    cursor: a.nextCursor,
  })
  expect(b.messages.map((m) => [m.id, m.role, m.senderName])).toEqual([
    ['reply', 'assistant', 'Vela'],
  ])
  const c = await host.messages({
    chatId,
    sessionId: topic.sessionId,
    cursor: b.nextCursor,
  })
  expect(c.messages.map((m) => m.id)).toEqual(['last'])
  expect(c.nextCursor).toBeUndefined()
  const historyReads = fake.topicHistoryCalls.length
  const sends = fake.sent.length
  await expect(
    host.messages({ chatId: 'oc_other', sessionId: topic.sessionId }),
  ).rejects.toThrow()
  await expect(
    host.messages({ chatId: 'oc_disabled', sessionId: group }),
  ).rejects.toThrow()
  await expect(
    host.submit({
      chatId: 'oc_other',
      sessionId: topic.sessionId,
      text: 'wrong',
      author,
    }),
  ).rejects.toThrow()
  await expect(
    host.submit({ chatId, sessionId: 'unowned', text: 'wrong', author }),
  ).rejects.toThrow()
  await expect(
    host.messages({
      chatId,
      sessionId: topic.sessionId,
      cursor: first.nextCursor,
    }),
  ).rejects.toThrow()
  expect(fake.topicHistoryCalls).toHaveLength(historyReads)
  expect(fake.sent).toHaveLength(sends)
})

test('SDK posts signed as the bot, emits history invalidations and follows the same run lifecycle', async () => {
  const { fake, host, events, t } = await setup([
    fauxText('new done'),
    fauxText('group done'),
    fauxText('one done'),
    fauxText('two done'),
  ])
  const runs: { sessionId: string; type: string }[] = []
  host.onSession(({ session, run }) => {
    if (run) runs.push({ sessionId: session.sessionId, type: run.type })
  })
  expect(events).toEqual([{ type: 'reset' }])
  const created = await host.submit({
    chatId,
    newTopic: { title: 'A task' },
    text: 'start it',
    author,
  })
  expect(fake.sent[0]).toEqual({ chatId, text: 'Alex: start it' })
  expect(fake.topics[0]).toEqual({
    messageId: created.messageId,
    title: 'A task',
  })
  expect(created.topic).toEqual({
    rootId: created.messageId,
    threadId: 'thread_sent_1',
  })
  await waitReply(t, 'new done')
  expect(events).toContainEqual({ type: 'history_changed', chatId })
  expect(events).toContainEqual({
    type: 'history_changed',
    chatId,
    sessionId: created.sessionId,
  })
  const before = events.length
  const echo = larkEvent({ message_id: created.messageId }, 'ou_bot')
  echo.sender.sender_type = 'app'
  fake.deliver(echo)
  fake.deliver(larkEvent({ mentions: [] }))
  expect(events).toHaveLength(before)

  const parent = await host.submit({
    chatId,
    sessionId: group,
    text: 'group input',
    author,
  })
  expect(parent.sessionId).toBe(group)
  await waitReply(t, 'group done')
  await Promise.all(
    ['one', 'two'].map((text) =>
      host.submit({
        chatId,
        sessionId: group,
        text,
        author,
      }),
    ),
  )
  await waitReply(t, 'two done')
  expect(t.eventsOf('channel_reply').map((e) => e.text)).toEqual([
    'new done',
    'group done',
    'one done',
    'two done',
  ])
  expect(fake.sent.map((m) => m.text)).toContain('Alex: group input')
  expect(t.model.calls[0]?.lastUserText).toContain('Alex: start it')
  // Finishing delivery can trail channel_reply. Separate sessions can
  // overlap; the queued inputs in the group must each finish before the next.
  for (let attempt = 0; runs.length < 8 && attempt < 200; attempt++)
    await Bun.sleep(5)
  const transitions = (sessionId: string) =>
    runs.filter((run) => run.sessionId === sessionId).map((run) => run.type)
  expect(transitions(created.sessionId)).toEqual(['started', 'finished'])
  expect(transitions(group)).toEqual(
    Array.from({ length: 3 }, () => ['started', 'finished']).flat(),
  )

  t.model.push(fauxText('continued'), fauxText('human response'))
  const continued = await host.submit({
    chatId,
    sessionId: created.sessionId,
    text: 'continue',
    author,
  })
  expect(continued.sessionId).toBe(created.sessionId)
  expect(fake.topics.at(-1)).toEqual({
    messageId: created.messageId,
    title: 'Alex: continue',
  })
  await waitReply(t, 'continued')
  const humanBase = events.length
  fake.deliver(
    larkEvent({
      root_id: created.topic.rootId,
      thread_id: created.topic.threadId,
      content: '{"text":"human message"}',
      mentions: [],
    }),
  )
  expect(events.slice(humanBase)).toContainEqual({
    type: 'history_changed',
    chatId,
    sessionId: created.sessionId,
  })
  await waitReply(t, 'human response')
  await t.internals.gateway.stopAll()
  await t.vela.startChannels()
  expect(events.at(-1)).toEqual({ type: 'reset' })
})

test('missing send receipt and failures after a receipt never retry or start the run', async () => {
  const { fake, host, t } = await setup([])
  const send = fake.transport.send
  fake.transport.send = async (...args) => {
    await send(...args)
  }
  const input = {
    chatId,
    newTopic: { title: 'A task' },
    text: 'start it',
    author,
  }
  await expect(host.submit(input)).rejects.toThrow(
    /may already have been posted/,
  )
  expect(fake.sent).toHaveLength(1)
  expect(fake.topics).toHaveLength(0)
  fake.transport.send = send
  fake.failReply()
  await expect(host.submit(input)).rejects.toThrow(/sent_2/)
  expect(fake.sent).toHaveLength(2)
  expect(host.sessions(chatId)).toEqual([])
  expect(t.model.calls).toEqual([])
})

test('if admission stops after posting, the SDK reports the posted message ID', async () => {
  const { fake, host, t } = await setup([])
  const send = fake.transport.send
  fake.transport.send = async (...args) => {
    const receipt = await send(...args)
    await t.internals.gateway.stopAll()
    return receipt
  }
  await expect(
    host.submit({ chatId, sessionId: group, text: 'stop after send', author }),
  ).rejects.toThrow(
    /sent_1 was posted, but submit did not complete: Channel is not running/,
  )
  expect(fake.sent).toHaveLength(1)
  expect(t.eventsOf('channel_reply')).toEqual([])
})

test('an incomplete topic receipt cannot admit an anchorless run', async () => {
  const { fake, host, t } = await setup([])
  const startTopic = fake.transport.startTopic
  fake.transport.startTopic = async (...args) => ({
    ...(await startTopic(...args)),
    messageId: '',
  })
  await expect(
    host.submit({
      chatId,
      author,
      text: 'new work',
      newTopic: { title: 'Work' },
    }),
  ).rejects.toThrow(/sent_1 was posted.*incomplete topic receipt/)
  expect(fake.sent).toHaveLength(1)
  expect(fake.topics).toHaveLength(1)
  expect(host.sessions(chatId)).toEqual([])
  expect(t.model.calls).toEqual([])
})

test('chats() lists every saved group before Lark connects', async () => {
  const t = createTestVela({
    responses: [],
    extensions: [
      lark({
        appId: 'bot',
        chats: [{ id: chatId }, 'oc_other'],
        transport: fakeLark().transport,
      }),
    ],
  })
  await t.vela.ready()
  const host = t.vela.channel('lark')
  // Saved configuration is the list, so it answers before Lark connects.
  expect(await host.chats()).toEqual([{ chatId }, { chatId: 'oc_other' }])
  await t.vela.startChannels()
  // A custom transport has no name lookup, so the groups keep their chat ids.
  expect(await host.chats()).toEqual([{ chatId }, { chatId: 'oc_other' }])
})

test('a failed signed submit says whether anything reached Lark', async () => {
  const { fake, host } = await setup([])
  const failure = async (submission: Promise<unknown>) => {
    try {
      await submission
    } catch (error) {
      if (error instanceof LarkSubmitError) return error
      throw error
    }
    throw new Error('expected the submission to fail')
  }

  const disabled = await failure(
    host.submit({ chatId: 'oc_disabled', sessionId: group, text: 'x', author }),
  )
  expect(disabled.outcome).toBe('not-sent')
  expect(disabled.messageId).toBeUndefined()
  expect(fake.sent).toEqual([])

  // A transport whose send returns no receipt leaves the outcome unknown.
  const send = fake.transport.send
  fake.transport.send = async (...args) => {
    await send(...args)
  }
  const uncertain = await failure(
    host.submit({
      chatId,
      newTopic: { title: 'A task' },
      text: 'start it',
      author,
    }),
  )
  expect(uncertain.outcome).toBe('uncertain')
  expect(uncertain.messageId).toBeUndefined()
  expect(fake.sent).toHaveLength(1)
  fake.transport.send = send

  // The signed message went out; opening the topic failed afterwards.
  fake.failReply()
  const posted = await failure(
    host.submit({
      chatId,
      newTopic: { title: 'Another' },
      text: 'more',
      author,
    }),
  )
  expect(posted.outcome).toBe('posted')
  expect(posted.messageId).toBe('sent_2')
  expect(fake.sent).toHaveLength(2)
})
