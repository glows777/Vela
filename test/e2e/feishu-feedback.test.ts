import { afterEach, expect, spyOn, test } from 'bun:test'
import { z } from 'zod'
import { feishu } from '../../src/extensions/feishu/index.ts'
import type { VelaExtension } from '../../src/extensions/types.ts'
import {
  fauxError,
  fauxHang,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux.ts'
import { fakeFeishu, feishuEvent } from '../support/feishu.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Feedback did not arrive')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
function setup(
  responses: NonNullable<Parameters<typeof createTestVela>[0]>['responses'],
  extensions: VelaExtension[] = [],
) {
  const fake = fakeFeishu()
  const t = createTestVela({
    responses,
    allowPendingResponses: true,
    extensions: [
      feishu({
        appId: 'bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
      ...extensions,
    ],
  })
  return {
    fake,
    t,
    start: async () => {
      await t.vela.ready()
      await t.vela.startChannels()
    },
  }
}
const topic = (message_id = 'trigger') =>
  feishuEvent({ message_id, root_id: 'root', thread_id: 'thread' })

test('acknowledges an admitted mention before name preparation and completes its reaction', async () => {
  const { fake, t, start } = setup([fauxText('answer')])
  const lookup = fake.transport.getSenderName
  let acknowledgedBeforeNames = false
  fake.transport.getSenderName = async (id) => {
    acknowledgedBeforeNames = fake.reactions.some(
      (r) => r.messageId === 'trigger' && r.emoji === 'OnIt',
    )
    return lookup(id)
  }
  await start()
  fake.deliver(topic())
  await until(() => fake.reactions.some((r) => r.emoji === 'DONE'))
  expect(acknowledgedBeforeNames).toBe(true)
  expect(fake.reactions.find((r) => r.emoji === 'OnIt')?.removed).toBe(true)
  expect(fake.sent.at(-1)?.text).toBe('<at user_id="ou_alice"></at> answer')
  expect(fake.patches.at(-1)?.messageId).toBe('card_1')
  await t.internals.gateway.stopAll()
})

test('one progress card follows a held tool and steers without replacing the requester', async () => {
  let release!: () => void
  let entered = false
  const { fake, t, start } = setup(
    [fauxToolCall('hold_pause', {}), fauxText('result')],
    [
      function hold(api) {
        api.registerTool({
          name: 'pause',
          description: 'Wait for release',
          inputSchema: z.object({}),
          execute: async () => {
            entered = true
            await new Promise<void>((resolve) => {
              release = resolve
            })
            return 'private raw output'
          },
        })
      },
    ],
  )
  await start()
  try {
    fake.deliver(topic())
    await until(() => entered)
    await until(() =>
      fake.patches.some((p) => JSON.stringify(p.card).includes('pause')),
    )
    fake.deliver(
      feishuEvent(
        {
          message_id: 'steer',
          root_id: 'root',
          thread_id: 'thread',
          mentions: [],
          content: '{"text":"also check X"}',
        },
        'ou_bob',
      ),
    )
    await until(() => t.eventsOf('channel_message').length === 2)
    release()
    await until(
      () => fake.reactions.filter((r) => r.emoji === 'DONE').length === 2,
    )
    expect(fake.cards).toHaveLength(1)
    expect(new Set(fake.patches.map((p) => p.messageId))).toEqual(
      new Set(['card_1']),
    )
    expect(JSON.stringify(fake.patches)).not.toContain('private raw output')
    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0]?.text).toBe('<at user_id="ou_alice"></at> result')
  } finally {
    release?.()
    await t.internals.gateway.stopAll()
  }
})

test('a model failure is visible in its topic and never receives a successful reaction', async () => {
  const { fake, t, start } = setup([
    fauxError('400 Bad Request: unavailable model'),
  ])
  await start()
  fake.deliver(topic())
  await until(() => fake.reactions.some((r) => r.emoji === 'CrossMark'))
  expect(
    fake.sent.some(
      (s) => s.messageId === 'trigger' && s.text.includes('unavailable model'),
    ),
  ).toBe(true)
  expect(fake.reactions.some((r) => r.emoji === 'DONE')).toBe(false)
  await t.internals.gateway.stopAll()
})

test('Stop finalizes the same card and reaction while retaining the topic for the next question', async () => {
  const { fake, t, start } = setup([fauxHang(), fauxText('continued')])
  await start()
  fake.deliver(topic())
  await until(() => t.model.calls.length === 1)
  fake.click(0, 'stop')
  await until(() => fake.reactions.some((r) => r.emoji === 'CrossMark'))
  expect(JSON.stringify(fake.patches.at(-1)?.card)).toContain('Stopped')
  fake.deliver(
    feishuEvent({
      message_id: 'next',
      root_id: 'root',
      thread_id: 'thread',
      mentions: [],
    }),
  )
  await until(() =>
    fake.reactions.some((r) => r.messageId === 'next' && r.emoji === 'DONE'),
  )
  expect(fake.sent.at(-1)?.text).toContain('continued')
  await t.internals.gateway.stopAll()
})

test('handoff keeps the original acknowledgement pending until the topic task finishes', async () => {
  let release!: () => void
  let entered = false
  const respond = (
    request: import('../../src/testing/faux.ts').FauxRequest,
  ) => {
    if (request.tools.includes('feishu_start_topic'))
      return request.toolResults.length
        ? fauxText('handed off')
        : fauxToolCall('feishu_start_topic', { task: 'investigate' })
    return request.toolResults.length
      ? fauxText('resolved')
      : fauxToolCall('hold_pause', {})
  }
  const { fake, t, start } = setup(Array(4).fill(respond), [
    function hold(api) {
      api.registerTool({
        name: 'pause',
        description: 'Wait',
        inputSchema: z.object({}),
        execute: async () => {
          entered = true
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return 'ok'
        },
      })
    },
  ])
  await start()
  try {
    fake.deliver(feishuEvent({ message_id: 'original' }))
    await until(() => entered && !t.vela.session('feishu-oc_group').isRunning)
    expect(fake.reactions).toEqual([
      { messageId: 'original', emoji: 'OnIt', id: 'reaction_0' },
    ])
    release()
    await until(() => fake.reactions.some((r) => r.emoji === 'DONE'))
    expect(fake.reactions.at(-1)?.messageId).toBe('original')
    expect(fake.sent.at(-1)).toEqual({
      messageId: 'topic_original',
      text: '<at user_id="ou_alice"></at> resolved',
    })
  } finally {
    release?.()
    await t.internals.gateway.stopAll()
  }
})

test('a failed card patch is visible and cannot be overwritten with a successful reaction', async () => {
  const { fake, t, start } = setup([fauxText('result')])
  fake.transport.patchCard = async () => {
    throw new Error('card permission denied')
  }
  await start()
  fake.deliver(topic())
  await until(() => fake.reactions.some((r) => r.emoji === 'CrossMark'))
  expect(fake.sent.some((s) => s.text.includes('card permission denied'))).toBe(
    true,
  )
  expect(
    fake.sent.some((s) => s.text === '<at user_id="ou_alice"></at> result'),
  ).toBe(true)
  expect(fake.reactions.some((r) => r.emoji === 'DONE')).toBe(false)
  await t.internals.gateway.stopAll()
})

test('a failed final send emits channel_error and leaves a failure reaction', async () => {
  const { fake, t, start } = setup([fauxText('result')])
  fake.failReply()
  await start()
  fake.deliver(topic())
  await until(() => fake.reactions.some((r) => r.emoji === 'CrossMark'))
  expect(
    t
      .eventsOf('channel_error')
      .some((e) => String(e.error).includes('reply failed')),
  ).toBe(true)
  expect(t.eventsOf('channel_reply')).toHaveLength(0)
  expect(fake.reactions.some((r) => r.emoji === 'DONE')).toBe(false)
  await t.internals.gateway.stopAll()
})

test('ignored top-level and unowned topic messages never get reactions or preparation', async () => {
  const { fake, t, start } = setup([])
  await start()
  fake.deliver(feishuEvent({ mentions: [] }))
  fake.deliver(
    feishuEvent({ mentions: [], root_id: 'unknown', thread_id: 'thread' }),
  )
  await t.internals.gateway.stopAll()
  expect(fake.reactions).toEqual([])
  expect(fake.nameCalls).toEqual([])
  expect(fake.topicHistoryCalls).toEqual([])
})

test('a quiet running topic refreshes on the 15 second heartbeat and clears it at completion', async () => {
  const schedule = globalThis.setInterval
  let tick!: () => void
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((
    callback: () => void,
    ms: number,
  ) => {
    const timer = schedule(callback, ms)
    if (ms === 15_000) {
      tick = callback
      heartbeat = timer
    }
    return timer
  }) as typeof setInterval)
  const clear = spyOn(globalThis, 'clearInterval')
  const { fake, t, start } = setup([fauxHang('still thinking')])
  try {
    await start()
    fake.deliver(topic())
    await until(() => t.model.calls.length === 1 && !!tick)
    tick()
    await until(() => fake.patches.length === 1)
    const count = fake.patches.length
    tick()
    await until(() => fake.patches.length > count)
    fake.click(0, 'stop')
    await until(() => fake.reactions.some((r) => r.emoji === 'CrossMark'))
    expect(clear).toHaveBeenCalledWith(heartbeat)
    expect(JSON.stringify(fake.patches.at(-1)?.card)).not.toContain('callback')
    const finalCount = fake.patches.length
    tick()
    await t.internals.gateway.stopAll()
    expect(fake.patches).toHaveLength(finalCount)
  } finally {
    await t.internals.gateway.stopAll()
    interval.mockRestore()
    clear.mockRestore()
  }
})

test('an in-flight patch drains before terminal feedback and high-frequency tool updates are bounded', async () => {
  let releaseTool!: () => void
  let releasePatch!: () => void
  let entered = false
  let patching = false
  let concurrent = 0
  let maximum = 0
  const starts: number[] = []
  const { fake, t, start } = setup(
    [fauxToolCall('hold_pause', {}), fauxText('result')],
    [
      function hold(api) {
        api.registerTool({
          name: 'pause',
          description: 'Wait',
          inputSchema: z.object({}),
          execute: async (_input, context) => {
            entered = true
            for (let i = 0; i < 100; i++)
              context?.onUpdate?.('private raw log'.repeat(5000))
            await new Promise<void>((resolve) => {
              releaseTool = resolve
            })
            return 'done'
          },
        })
      },
    ],
  )
  const patch = fake.transport.patchCard
  fake.transport.patchCard = async (id, card) => {
    starts.push(Date.now())
    maximum = Math.max(maximum, ++concurrent)
    if (!patching) {
      patching = true
      await new Promise<void>((resolve) => {
        releasePatch = resolve
      })
    }
    await patch(id, card)
    concurrent--
  }
  await start()
  try {
    fake.deliver(topic())
    await until(() => entered && patching)
    releaseTool()
    await until(() => t.eventsOf('agent_settled').length === 1)
    expect(fake.sent).toHaveLength(0)
    expect(fake.reactions.some((r) => r.emoji === 'DONE')).toBe(false)
    releasePatch()
    await until(() => fake.reactions.some((r) => r.emoji === 'DONE'))
    expect(maximum).toBe(1)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(240)
    expect(fake.patches).toHaveLength(2)
    for (const p of fake.patches) {
      expect(Buffer.byteLength(JSON.stringify(p.card))).toBeLessThan(30_000)
      expect(JSON.stringify(p.card)).not.toContain('private raw log')
      expect(p.card.config?.update_multi).toBe(true)
    }
    expect(JSON.stringify(fake.cards[0]?.card)).toContain('"update_multi":true')
    expect(JSON.stringify(fake.patches.at(-1)?.card)).not.toContain('callback')
  } finally {
    releaseTool?.()
    releasePatch?.()
    await t.internals.gateway.stopAll()
  }
})
