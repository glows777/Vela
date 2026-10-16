import { afterEach, expect, test } from 'bun:test'
import { z } from 'zod'
import { feishu } from '../../src/extensions/feishu/index.ts'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { fakeFeishu, feishuEvent } from '../support/feishu.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 1000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for run control')
    await Bun.sleep(1)
  }
}

async function runningChat(dm = false) {
  const fake = fakeFeishu()
  const held = latch()
  const entered = latch()
  const t = createTestVela({
    allowPendingResponses: true,
    responses: [
      fauxToolCall('hold_pause', {}),
      (request) => fauxText(request.lastUserText.includes('blue') ? 'Alice and Bob: use blue' : 'first answer'),
      fauxText('queued answer'),
      fauxText('later answer'),
    ],
    extensions: [
      feishu({ owners: ['ou_alice'], chats: ['oc_group'], transport: fake.transport }),
      function hold(api) {
        api.registerTool({
          name: 'pause', description: 'Wait for the user action', inputSchema: z.object({}),
          execute: async (_input, context) => {
            entered.release()
            await Promise.race([
              held.promise,
              new Promise<void>((resolve) => context?.signal?.addEventListener('abort', () => resolve(), { once: true })),
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
  fake.deliver(feishuEvent({ ...chat, message_id: 'first', content: '{"text":"original question"}' }))
  await entered.promise
  fake.deliver(feishuEvent({ ...chat, message_id: 'second', content: '{"text":"use blue"}' }, dm ? 'ou_alice' : 'ou_bob'))
  return { ...fake, t, release: held.release }
}

test('a second @ shows Queue (default), Steer and Stop before the current run ends; no click preserves ordered replies', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    expect(f.cards[0]).toMatchObject({ chatId: 'oc_group', replyToId: 'second' })
    const rendered = JSON.stringify(f.cards[0]?.card)
    for (const label of ['Queue', 'default', 'Steer', 'Stop']) expect(rendered).toContain(label)
    expect(f.sent).toEqual([])
    expect(f.t.model.calls).toHaveLength(1)
  } finally { f.release() }
  await until(() => f.sent.length === 2)
  expect(f.sent).toEqual([{ messageId: 'first', text: 'first answer' }, { messageId: 'second', text: 'queued answer' }])
  expect(JSON.stringify(f.t.model.calls[2]?.prompt)).toContain('first answer')
})

test('Queue explicitly keeps one reply for each message and consumes the choice once', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    expect(f.click(0, 'queue')).toMatchObject({ toast: { type: 'success' } })
    expect(f.click(0, 'steer')).toMatchObject({ toast: { type: 'info' } })
  } finally { f.release() }
  await until(() => f.sent.length === 2)
  expect(f.t.eventsOf('agent_start')).toHaveLength(2)
  expect(f.t.eventsOf('queue_update')).toEqual([])
})

test('Steer joins the active run with both named questions and sends one combined reply to its original trigger', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    expect(f.click(0, 'steer')).toMatchObject({ toast: { type: 'success' } })
    await until(() => f.t.eventsOf('queue_update').some((event) => event.steering.includes('Bob: use blue')))
    expect(f.sent).toEqual([])
  } finally { f.release() }
  await until(() => f.sent.length >= 1)
  await f.t.vela.dispose()
  expect(f.sent).toEqual([{ messageId: 'first', text: 'Alice and Bob: use blue' }])
  expect(f.t.model.calls).toHaveLength(2)
  expect(JSON.stringify(f.t.model.calls[1]?.prompt)).toContain('Alice: original question')
  expect(f.t.model.calls[1]?.lastUserText).toBe('Bob: use blue')
  expect(f.t.eventsOf('agent_start')).toHaveLength(1)
  expect(f.t.eventsOf('channel_message').map((event) => event.text)).toEqual(['Alice: original question', 'Bob: use blue'])
  expect(await f.t.readData('sessions/feishu-oc_group.jsonl')).toContain('Bob: use blue')
})

test('Stop aborts the active run, visibly confirms on the second message, and does not run that message later', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    expect(f.click(0, 'stop')).toMatchObject({ toast: { type: 'success' } })
    await until(() => f.sent.length >= 1)
    expect(f.sent).toEqual([{ messageId: 'second', text: 'Stopped the current run.' }])
    expect(f.t.eventsOf('agent_end').at(-1)?.reason).toBe('aborted')
    expect(f.t.vela.session('feishu-oc_group').isRunning).toBe(false)
    expect(f.t.model.calls).toHaveLength(1)
    f.deliver(feishuEvent({ message_id: 'later', content: '{"text":"continue"}' }))
    await until(() => f.sent.length === 2)
    expect(f.sent[1]?.messageId).toBe('later')
  } finally { f.release() }
})

test('duplicate Steer delivery cannot duplicate the input or its answer', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    f.click(0, 'steer')
    expect(f.click(0, 'steer')).toMatchObject({ toast: { type: 'info' } })
    await until(() => f.t.eventsOf('queue_update').some((event) => event.steering.length === 1))
  } finally { f.release() }
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
    for (const value of [undefined, null, 'stop', {}, { action: 'stop', token: 'invented' }]) {
      expect(f.callback({ operator: { open_id: 'ou_bob' }, context: { open_chat_id: 'oc_group' }, action: { value } })).toMatchObject({ toast: { type: 'info' } })
    }
    expect(f.click(0, 'stop', { context: { open_chat_id: 'oc_other' } })).toMatchObject({ toast: { type: 'info' } })
    expect(f.click(0, 'stop', { operator: {} })).toMatchObject({ toast: { type: 'info' } })
    expect(f.t.vela.session('feishu-oc_group').isRunning).toBe(true)
    expect(f.click(0, 'steer')).toMatchObject({ toast: { type: 'success' } })
    await until(() => f.t.eventsOf('queue_update').some((event) => event.steering.length === 1))
  } finally { f.release() }
  await until(() => f.sent.length === 1)
})

test('a card from a completed run cannot abort or steer the next run in the same chat', async () => {
  const f = await runningChat()
  try { await until(() => f.cards.length === 1) } finally { f.release() }
  await until(() => f.sent.length === 2)
  const idle = f.t.vela.session('feishu-oc_group')
  f.t.model.push({ text: 'busy again', hang: true })
  // Consume the remaining scripted answers before starting the controlled next run.
  await idle.prompt('next')
  const running = idle.prompt('hold next')
  await until(() => idle.isRunning)
  try {
    expect(f.click(0, 'stop')).toMatchObject({ toast: { type: 'info' } })
    expect(f.click(0, 'steer')).toMatchObject({ toast: { type: 'info' } })
    expect(idle.isRunning).toBe(true)
  } finally { await idle.abort(); await running.catch(() => {}) }
})

test('a run finishing during Steer history lookup keeps the input queued and never starts a separate steer run', async () => {
  const f = await runningChat()
  const preparing = latch()
  const prepared = latch()
  try {
    await until(() => f.cards.length === 1)
    f.transport.listMessages = async () => { preparing.release(); await prepared.promise; return [] }
    f.click(0, 'steer')
    await preparing.promise
    f.release()
    await until(() => f.sent.length === 1)
  } finally { prepared.release(); f.release() }
  await until(() => f.sent.length === 2)
  expect(f.sent.map((reply) => reply.messageId)).toEqual(['first', 'second'])
  expect(f.t.eventsOf('agent_start')).toHaveLength(2)
  expect(f.t.eventsOf('queue_update')).toEqual([])
})

test('card send failure leaves the second message queued and does not discard either reply', async () => {
  const f = fakeFeishu()
  let cardAttempts = 0
  f.transport.sendCard = async () => { cardAttempts++; throw new Error('card send failed') }
  const gate = latch()
  const entered = latch()
  const t = createTestVela({
    responses: [fauxToolCall('hold_pause', {}), fauxText('one'), fauxText('two')],
    extensions: [feishu({ chats: ['oc_group'], transport: f.transport }), function hold(api) {
      api.registerTool({ name: 'pause', description: 'wait', inputSchema: z.object({}), execute: async () => { entered.release(); await gate.promise; return 'ok' } })
    }],
  })
  await t.vela.ready(); await t.vela.startChannels()
  f.deliver(feishuEvent({ message_id: 'one' }))
  await entered.promise
  f.deliver(feishuEvent({ message_id: 'two' }))
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
    expect(f.t.vela.session('feishu-oc_dm').isRunning).toBe(true)
    expect(f.click(0, 'stop', { operator: { open_id: 'ou_alice' } })).toMatchObject({ toast: { type: 'success' } })
    await until(() => f.sent.length === 1)
    expect(f.sent).toEqual([{ chatId: 'oc_dm', text: 'Stopped the current run.' }])
    expect(f.t.model.calls).toHaveLength(1)
  } finally { f.release() }
})

test('Stop consumes only its own trigger and preserves the other queued message', async () => {
  const f = await runningChat()
  try {
    await until(() => f.cards.length === 1)
    f.deliver(feishuEvent({ message_id: 'third', content: '{"text":"after stop"}' }))
    await until(() => f.cards.length === 2)
    f.click(0, 'stop')
    await until(() => f.sent.length === 2)
    expect(f.sent[0]).toEqual({ messageId: 'second', text: 'Stopped the current run.' })
    expect(f.sent[1]?.messageId).toBe('third')
    expect(f.t.model.calls).toHaveLength(2)
    expect(f.t.model.calls[1]?.lastUserText).toBe('Alice: after stop')
    expect(f.t.eventsOf('channel_message').some((message) => message.text.includes('use blue'))).toBe(false)
    expect(f.click(1, 'stop')).toMatchObject({ toast: { type: 'info' } })
  } finally { f.release() }
})
