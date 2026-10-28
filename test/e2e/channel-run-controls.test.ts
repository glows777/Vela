import { afterEach, expect, test } from 'bun:test'
import { fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import type { LarkHistoryMessage } from '@glows777/vela-lark'
import { lark } from '@glows777/vela-lark'
import { z } from 'zod'
import { messageTime } from '../../packages/lark/src/history.ts'
import { fakeLark, historyMessage, larkEvent } from '../support/lark.ts'
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
  const deadline = Date.now() + 1000
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for run control')
    await Bun.sleep(1)
  }
}

/** `[HH:MM] ` for a Lark create_time in the machine's local time */
const at = (ms: string) => `[${messageTime(ms)}] `

async function runningChat(dm = false, history: LarkHistoryMessage[] = []) {
  const fake = fakeLark()
  fake.history.push(...history)
  const held = latch()
  const entered = latch()
  const t = createTestVela({
    allowPendingResponses: true,
    responses: [
      fauxToolCall('hold_pause', {}),
      (request) =>
        fauxText(
          request.lastUserText.includes('blue')
            ? 'Alice and Bob: use blue'
            : 'first answer',
        ),
      fauxText('queued answer'),
      fauxText('later answer'),
    ],
    extensions: [
      lark({
        appId: 'cli_bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
      function hold(api) {
        api.registerTool({
          name: 'pause',
          description: 'Wait for the user action',
          inputSchema: z.object({}),
          execute: async (_input, context) => {
            entered.release()
            await Promise.race([
              held.promise,
              new Promise<void>((resolve) =>
                context?.signal?.addEventListener('abort', () => resolve(), {
                  once: true,
                }),
              ),
            ])
            return 'released'
          },
        })
      },
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  const chat = dm ? { chat_id: 'oc_dm', chat_type: 'p2p', mentions: [] } : {}
  fake.deliver(
    larkEvent({
      ...chat,
      message_id: 'first',
      create_time: '3000',
      content: '{"text":"original question"}',
    }),
  )
  await entered.promise
  fake.deliver(
    larkEvent(
      {
        ...chat,
        message_id: 'second',
        create_time: '5000',
        content: '{"text":"use blue"}',
      },
      dm ? 'ou_alice' : 'ou_bob',
    ),
  )
  return { ...fake, t, release: held.release }
}

test('a second @ shows Queue (default), Steer and Stop before the current run ends; no click preserves ordered replies', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    expect(f.cards[0]).toMatchObject({
      chatId: 'oc_group',
      replyToId: 'second',
    })
    const rendered = JSON.stringify(f.cards[0]?.card)
    for (const label of ['Queue', 'default', 'Steer', 'Stop'])
      expect(rendered).toContain(label)
    expect(f.sent).toEqual([])
    expect(f.t.model.calls).toHaveLength(1)
  } finally {
    f.release()
  }
  await until(() => f.sent.length === 2)
  expect(f.sent).toEqual([
    { messageId: 'first', text: 'first answer' },
    { messageId: 'second', text: 'queued answer' },
  ])
  expect(JSON.stringify(f.t.model.calls[2]?.prompt)).toContain('first answer')
})

test('Queue explicitly keeps one reply for each message and consumes the choice once', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    expect(f.click(0, 'queue')).toMatchObject({ toast: { type: 'success' } })
    expect(f.click(0, 'steer')).toMatchObject({ toast: { type: 'info' } })
  } finally {
    f.release()
  }
  await until(() => f.sent.length === 2)
  expect(f.t.eventsOf('agent_start')).toHaveLength(2)
  expect(f.t.eventsOf('queue_update')).toEqual([])
})

test('Steer joins the active run with both named questions and sends one combined reply to its original trigger', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    expect(f.click(0, 'steer')).toMatchObject({ toast: { type: 'success' } })
    await until(() =>
      f.t
        .eventsOf('queue_update')
        .some((event) => event.steering.includes(`${at('5000')}Bob: use blue`)),
    )
    expect(f.sent).toEqual([])
  } finally {
    f.release()
  }
  await until(() => f.sent.length >= 1)
  await f.t.vela.dispose()
  expect(f.sent).toEqual([
    { messageId: 'first', text: 'Alice and Bob: use blue' },
  ])
  expect(f.t.model.calls).toHaveLength(2)
  expect(JSON.stringify(f.t.model.calls[1]?.prompt)).toContain(
    'Alice: original question',
  )
  expect(f.t.model.calls[1]?.lastUserText).toBe(`${at('5000')}Bob: use blue`)
  expect(f.t.eventsOf('agent_start')).toHaveLength(1)
  expect(f.t.eventsOf('channel_message').map((event) => event.text)).toEqual([
    `${at('3000')}Alice: original question`,
    `${at('5000')}Bob: use blue`,
  ])
  expect(await f.t.readData('sessions/lark-oc_group.jsonl')).toContain(
    'Bob: use blue',
  )
})

test('Stop aborts the active run, visibly confirms on the second message, and does not run that message later', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    expect(f.click(0, 'stop')).toMatchObject({ toast: { type: 'success' } })
    await until(() => f.sent.length >= 1)
    expect(f.sent).toEqual([
      { messageId: 'second', text: 'Stopped the current run.' },
    ])
    expect(f.t.eventsOf('agent_end').at(-1)?.reason).toBe('aborted')
    expect(f.t.vela.session('lark-oc_group').isRunning).toBe(false)
    expect(f.t.model.calls).toHaveLength(1)
    f.deliver(
      larkEvent({ message_id: 'later', content: '{"text":"continue"}' }),
    )
    await until(() => f.sent.length === 2)
    expect(f.sent[1]?.messageId).toBe('later')
  } finally {
    f.release()
  }
})

test('duplicate Steer delivery cannot duplicate the input or its answer', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    f.click(0, 'steer')
    expect(f.click(0, 'steer')).toMatchObject({ toast: { type: 'info' } })
    await until(() =>
      f.t.eventsOf('queue_update').some((event) => event.steering.length === 1),
    )
  } finally {
    f.release()
  }
  await until(() => f.sent.length >= 1)
  await f.t.vela.dispose()
  expect(f.sent).toHaveLength(1)
  expect(f.t.model.calls).toHaveLength(2)
  expect(f.t.eventsOf('channel_message')).toHaveLength(2)
})

test('malformed values, wrong chats and missing operators cannot steer or stop an enabled shared chat', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    for (const value of [
      undefined,
      null,
      'stop',
      {},
      { action: 'stop', token: 'invented' },
    ]) {
      expect(
        f.callback({
          operator: { open_id: 'ou_bob' },
          context: { open_chat_id: 'oc_group' },
          action: { value },
        }),
      ).toMatchObject({ toast: { type: 'info' } })
    }
    expect(
      f.click(0, 'stop', { context: { open_chat_id: 'oc_other' } }),
    ).toMatchObject({ toast: { type: 'info' } })
    expect(f.click(0, 'stop', { operator: {} })).toMatchObject({
      toast: { type: 'info' },
    })
    expect(f.t.vela.session('lark-oc_group').isRunning).toBe(true)
    expect(f.click(0, 'steer')).toMatchObject({ toast: { type: 'success' } })
    await until(() =>
      f.t.eventsOf('queue_update').some((event) => event.steering.length === 1),
    )
  } finally {
    f.release()
  }
  await until(() => f.sent.length === 1)
})

test('a card from a completed run cannot abort or steer the next run in the same chat', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
  } finally {
    f.release()
  }
  await until(() => f.sent.length === 2)
  const idle = f.t.vela.session('lark-oc_group')
  f.t.model.push({ text: 'busy again', hang: true })
  // Consume the remaining scripted answers before starting the controlled next run.
  await idle.prompt('next')
  const running = idle.prompt('hold next')
  await until(() => idle.isRunning)
  try {
    expect(f.click(0, 'stop')).toMatchObject({ toast: { type: 'info' } })
    expect(f.click(0, 'steer')).toMatchObject({ toast: { type: 'info' } })
    expect(idle.isRunning).toBe(true)
  } finally {
    await idle.abort()
    await running.catch(() => {})
  }
})

test('a run finishing during Steer history lookup keeps the input queued and never starts a separate steer run', async () => {
  const f = await runningChat()
  const preparing = latch()
  const prepared = latch()
  try {
    await until(() => f.cards.length === 1)
    f.transport.listMessages = async () => {
      preparing.release()
      await prepared.promise
      return []
    }
    f.click(0, 'steer')
    await preparing.promise
    f.release()
    await until(() => f.sent.length === 1)
  } finally {
    prepared.release()
    f.release()
  }
  await until(() => f.sent.length === 2)
  expect(f.sent.map((reply) => reply.messageId)).toEqual(['first', 'second'])
  expect(f.t.eventsOf('agent_start')).toHaveLength(2)
  expect(f.t.eventsOf('queue_update')).toEqual([])
})

test('card send failure leaves the second message queued and does not discard either reply', async () => {
  const f = fakeLark()
  let cardAttempts = 0
  f.transport.sendCard = async () => {
    cardAttempts++
    throw new Error('card send failed')
  }
  const gate = latch()
  const entered = latch()
  const t = createTestVela({
    responses: [
      fauxToolCall('hold_pause', {}),
      fauxText('one'),
      fauxText('two'),
    ],
    extensions: [
      lark({ chats: ['oc_group'], transport: f.transport }),
      function hold(api) {
        api.registerTool({
          name: 'pause',
          description: 'wait',
          inputSchema: z.object({}),
          execute: async () => {
            entered.release()
            await gate.promise
            return 'ok'
          },
        })
      },
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  f.deliver(larkEvent({ message_id: 'one' }))
  await entered.promise
  f.deliver(larkEvent({ message_id: 'two' }))
  gate.release()
  await until(() => f.sent.length === 2)
  expect(cardAttempts).toBe(1)
  expect(f.sent.map((reply) => reply.text)).toEqual(['one', 'two'])
})

test('owner DM cards use normal sends and a non-owner callback cannot control that private run', async () => {
  const f = await runningChat(true)
  try {
    await until(() => f.cards.length === 1)
    expect(f.cards[0]).toMatchObject({ chatId: 'oc_dm', replyToId: undefined })
    expect(f.click(0, 'stop')).toMatchObject({ toast: { type: 'info' } })
    expect(f.t.vela.session('lark-oc_dm').isRunning).toBe(true)
    expect(
      f.click(0, 'stop', { operator: { open_id: 'ou_alice' } }),
    ).toMatchObject({ toast: { type: 'success' } })
    await until(() => f.sent.length === 1)
    expect(f.sent).toEqual([
      { chatId: 'oc_dm', text: 'Stopped the current run.' },
    ])
    expect(f.t.model.calls).toHaveLength(1)
  } finally {
    f.release()
  }
})

test('Stop consumes only its own trigger and preserves the other queued message', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    const afterStop = larkEvent({
      message_id: 'third',
      content: '{"text":"after stop"}',
    })
    f.deliver(afterStop)
    await until(() => f.cards.length === 2)
    f.click(0, 'stop')
    await until(() => f.sent.length === 2)
    expect(f.sent[0]).toEqual({
      messageId: 'second',
      text: 'Stopped the current run.',
    })
    expect(f.sent[1]?.messageId).toBe('third')
    expect(f.t.model.calls).toHaveLength(2)
    expect(f.t.model.calls[1]?.lastUserText).toBe(
      `${at(afterStop.message.create_time!)}Alice: after stop`,
    )
    expect(
      f.t
        .eventsOf('channel_message')
        .some((message) => message.text.includes('use blue')),
    ).toBe(false)
    expect(f.click(1, 'stop')).toMatchObject({ toast: { type: 'info' } })
  } finally {
    f.release()
  }
})

test('any own-app message, including a control card, bounds Lark history during Steer', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    f.history.push(
      {
        ...historyMessage('control', 'cli_bot', 'control card', '4000'),
        msg_type: 'interactive',
        sender: { id: 'cli_bot', sender_type: 'app' },
      },
      historyMessage('context', 'ou_alice', 'keep this context', '3500'),
      {
        ...historyMessage('old_answer', 'cli_bot', 'old answer', '1000'),
        sender: { id: 'cli_bot', sender_type: 'app' },
      },
      historyMessage('stale', 'ou_alice', 'exclude this context', '500'),
    )
    f.click(0, 'steer')
    await until(() =>
      f.t.eventsOf('queue_update').some((event) => event.steering.length === 1),
    )
  } finally {
    f.release()
  }
  await until(() => f.sent.length === 1)
  expect(f.t.model.calls[1]?.lastUserText).not.toContain('keep this context')
  expect(f.t.model.calls[1]?.lastUserText).not.toContain('exclude this context')
})

test('Stop discards an accepted steer from the cancelled run without leaking it into the next independent task', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    f.click(0, 'steer')
    await until(
      () => f.t.vela.session('lark-oc_group').queue.steering.length === 1,
    )
    f.deliver(larkEvent({ message_id: 'stop', content: '{"text":"cancel"}' }))
    await until(() => f.cards.length === 2)
    f.click(1, 'stop')
    await until(() => f.sent.length === 1)
    expect(f.t.vela.session('lark-oc_group').queue).toEqual({
      steering: [],
      followUp: [],
    })
    const independent = larkEvent({
      message_id: 'independent',
      content: '{"text":"new independent task"}',
    })
    f.deliver(independent)
    await until(() => f.sent.length === 2)
    expect(f.t.model.calls).toHaveLength(2)
    expect(f.t.model.calls[1]?.lastUserText).toBe(
      `${at(independent.message.create_time!)}Alice: new independent task`,
    )
    expect(f.sent.map((reply) => reply.messageId)).toEqual([
      'stop',
      'independent',
    ])
  } finally {
    f.release()
  }
})

test('Stop also cancels a Steer whose input hook finishes while the aborted tool is still cleaning up', async () => {
  const f = fakeLark()
  const entered = latch()
  const held = latch()
  const hookEntered = latch()
  const hookHeld = latch()
  const t = createTestVela({
    allowPendingResponses: true,
    responses: [
      fauxToolCall('hold_pause', {}),
      fauxText('independent answer'),
      fauxText('stale answer'),
    ],
    extensions: [
      lark({ chats: ['oc_group'], transport: f.transport }),
      function hold(api) {
        api.registerTool({
          name: 'pause',
          description: 'wait for cleanup',
          inputSchema: z.object({}),
          execute: async () => {
            entered.release()
            await held.promise
            return 'cleaned up'
          },
        })
        api.on('input', async (event) => {
          if (
            event.text.endsWith('Bob: use blue') &&
            event.streamingBehavior === 'steer'
          ) {
            hookEntered.release()
            await hookHeld.promise
          }
        })
      },
    ],
  })
  await t.vela.ready()
  await t.vela.startChannels()
  try {
    f.deliver(larkEvent({ message_id: 'first' }))
    await entered.promise
    f.deliver(
      larkEvent(
        { message_id: 'second', content: '{"text":"use blue"}' },
        'ou_bob',
      ),
    )
    await until(() => f.cards.length === 1)
    f.click(0, 'steer')
    await hookEntered.promise
    f.deliver(larkEvent({ message_id: 'stop' }))
    await until(() => f.cards.length === 2)
    f.click(1, 'stop')
    hookHeld.release()
    await until(
      () =>
        t.eventsOf('queue_update').some((event) => event.steering.length > 0) ||
        t.eventsOf('channel_error').length > 0,
    )
    held.release()
    await until(
      () =>
        f.sent.length >= 1 &&
        // biome-ignore lint/complexity/useLiteralKeys: bracket access reads a private ChannelGateway field; dot access does not typecheck
        !t.internals.gateway['queues'].has('lark-oc_group'),
    )
    expect(t.vela.session('lark-oc_group').queue).toEqual({
      steering: [],
      followUp: [],
    })
    expect(t.model.calls).toHaveLength(1)
    expect(f.sent).toEqual([
      { messageId: 'stop', text: 'Stopped the current run.' },
    ])
    const independent = larkEvent({
      message_id: 'independent',
      content: '{"text":"new task"}',
    })
    f.deliver(independent)
    await until(() => f.sent.length === 2)
    expect(t.model.calls).toHaveLength(2)
    expect(t.model.calls[1]?.lastUserText).toBe(
      `${at(independent.message.create_time!)}Alice: new task`,
    )
  } finally {
    hookHeld.release()
    held.release()
  }
})

for (const peerTime of ['4500', '3000']) {
  test(`Steer excludes the active trigger and older context but retains later discussion (peer time ${peerTime})`, async () => {
    const earlier = historyMessage(
      'earlier',
      'ou_bob',
      'context already read',
      '2500',
    )
    const f = await runningChat(false, [earlier])
    try {
      await until(() => f.cards.length === 1)
      expect(f.t.model.calls[0]?.lastUserText).toBe(
        `[Chat since last reply]\n${at('2500')}Bob: context already read` +
          `\n\n[Question]\n${at('3000')}Alice: original question`,
      )
      f.history.unshift(
        historyMessage('second', 'ou_bob', 'use blue', '5000'),
        historyMessage(
          'discussion',
          'ou_alice',
          'keep the new detail',
          peerTime,
        ),
        historyMessage('first', 'ou_alice', 'original question', '3000'),
      )
      f.click(0, 'steer')
      await until(
        () => f.t.vela.session('lark-oc_group').queue.steering.length === 1,
      )
    } finally {
      f.release()
    }
    await until(() => f.sent.length === 1)
    expect(f.t.model.calls[1]?.lastUserText).toBe(
      `[Chat since last reply]\n${at(peerTime)}Alice: keep the new detail` +
        `\n\n[Question]\n${at('5000')}Bob: use blue`,
    )
    const users = f.t.model.calls[1]?.prompt.filter(
      (message) => message.role === 'user',
    )
    const content = JSON.stringify(users)
    expect(content.split('original question')).toHaveLength(2)
    expect(content.split('context already read')).toHaveLength(2)
    expect(f.t.eventsOf('agent_start')).toHaveLength(1)
    expect(f.sent[0]?.messageId).toBe('first')
  })
}

test('a delayed Steer whose service time precedes the active trigger still supplies its named question', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    f.click(0, 'queue')
    f.deliver(
      larkEvent(
        {
          message_id: 'delayed',
          create_time: '2000',
          content: '{"text":"delayed correction"}',
        },
        'ou_bob',
      ),
    )
    await until(() => f.cards.length === 2)
    f.history.push(
      historyMessage('first', 'ou_alice', 'original question', '3000'),
      historyMessage('delayed', 'ou_bob', 'delayed correction', '2000'),
      historyMessage('older', 'ou_alice', 'older context', '1000'),
    )
    f.click(1, 'steer')
    await until(
      () => f.t.vela.session('lark-oc_group').queue.steering.length === 1,
    )
  } finally {
    f.release()
  }
  await until(() => f.sent.length === 2)
  expect(f.t.model.calls[1]?.lastUserText).toBe(
    `${at('2000')}Bob: delayed correction`,
  )
  expect(f.sent.map((reply) => reply.messageId)).toEqual(['first', 'second'])
})

test('Queue immediately followed by Stop on another card keeps the explicitly queued message', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    f.deliver(
      larkEvent({ message_id: 'stop', content: '{"text":"stop this run"}' }),
    )
    await until(() => f.cards.length === 2)
    f.click(0, 'queue')
    f.click(1, 'stop')
    await until(
      () =>
        f.sent.length >= 1 &&
        // biome-ignore lint/complexity/useLiteralKeys: bracket access reads a private ChannelGateway field; dot access does not typecheck
        !f.t.internals.gateway['queues'].has('lark-oc_group'),
    )
    expect(f.sent.map((reply) => reply.messageId)).toEqual(['stop', 'second'])
    expect(f.t.model.calls).toHaveLength(2)
    expect(f.t.model.calls[1]?.lastUserText).toBe(`${at('5000')}Bob: use blue`)
  } finally {
    f.release()
  }
})

test('run cards use the Card 2.0 callback schema for the subscribed card.action.trigger event', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    const card = f.cards[0]!.card
    expect(card.schema).toBe('2.0')
    const columns = card.body.elements.flatMap(
      (element) => element.columns ?? [],
    )
    expect(columns).toHaveLength(3)
    const callbacks = columns
      .flatMap((column) => column.elements)
      .flatMap((button) => button.behaviors)
    expect(
      callbacks.map((callback) => [callback.type, callback.value.action]),
    ).toEqual([
      ['callback', 'queue'],
      ['callback', 'steer'],
      ['callback', 'stop'],
    ])
    expect(
      new Set(callbacks.map((callback) => callback.value.token)).size,
    ).toBe(1)
    expect(f.click(0, 'steer')).toMatchObject({ toast: { type: 'success' } })
    await until(
      () => f.t.vela.session('lark-oc_group').queue.steering.length === 1,
    )
  } finally {
    f.release()
  }
  await until(() => f.sent.length === 1)
  expect(f.sent).toEqual([
    { messageId: 'first', text: 'Alice and Bob: use blue' },
  ])
})
