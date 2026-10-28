import { afterEach, expect, spyOn, test } from 'bun:test'
import type { ChannelExtension as VelaExtension } from '@glows777/vela-channels'
import {
  fauxError,
  fauxHang,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { feishu } from '@glows777/vela-lark'
import { z } from 'zod'
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
  expect(fake.patches.at(-1)?.card.header.title.content).toBe('Stopped')
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
    request: import('../../packages/core/src/testing/faux.ts').FauxRequest,
  ) => {
    if (request.tools.includes('feishu_start_topic'))
      return request.toolResults.length
        ? fauxText('handed off')
        : fauxToolCall('feishu_start_topic', {
            title: 'investigate',
            brief: 'investigate',
          })
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

test('a failed card patch is visible once while delivered task success receives DONE', async () => {
  let release!: () => void
  const { fake, t, start } = setup(
    [fauxToolCall('hold_pause', {}), fauxText('result')],
    [
      function hold(api) {
        api.registerTool({
          name: 'pause',
          description: 'Wait',
          inputSchema: z.object({}),
          execute: async () => {
            await new Promise<void>((resolve) => {
              release = resolve
            })
            return 'ok'
          },
        })
      },
    ],
  )
  let patches = 0
  fake.transport.patchCard = async () => {
    patches++
    throw new Error('card permission denied')
  }
  await start()
  try {
    fake.deliver(topic())
    await until(() =>
      fake.sent.some((s) => s.text.includes('card permission denied')),
    )
    release()
    await until(() =>
      fake.reactions.some((r) => r.emoji === 'DONE' || r.emoji === 'CrossMark'),
    )
    expect(fake.reactions.at(-1)?.emoji).toBe('DONE')
    expect(
      fake.sent.filter((s) => s.text.includes('card permission denied')),
    ).toHaveLength(1)
    expect(fake.sent.at(-1)?.text).toBe('<at user_id="ou_alice"></at> result')
    expect(patches).toBe(1)
  } finally {
    release?.()
    await t.internals.gateway.stopAll()
  }
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
  expect(fake.patches.at(-1)?.card.header.title.content).toBe('Failed')
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
  const now = Date.now.bind(Date)
  let elapsed = 0
  const clock = spyOn(Date, 'now').mockImplementation(() => now() + elapsed)
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
    const previous = JSON.stringify(fake.patches.at(-1)?.card)
    elapsed += 15_000
    tick()
    await until(() => fake.patches.length > count)
    expect(JSON.stringify(fake.patches.at(-1)?.card)).not.toBe(previous)
    expect(fake.patches.at(-1)?.card.body.elements[0]?.content).toContain('15s')
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
    clock.mockRestore()
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

test('Stop finalizes an untagged steer still downloading its attachment', async () => {
  let release!: () => void
  let downloading = false
  const { fake, t, start } = setup([fauxHang('working')])
  const resource = fake.transport.getResource
  fake.resources.set('file', [Buffer.from('notes')])
  fake.transport.getResource = async (...args) => {
    downloading = true
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return resource(...args)
  }
  await start()
  try {
    fake.deliver(topic())
    await until(() => t.model.calls.length === 1)
    fake.deliver(
      feishuEvent(
        {
          message_id: 'steer',
          root_id: 'root',
          thread_id: 'thread',
          mentions: [],
          message_type: 'file',
          content: '{"file_key":"file","file_name":"notes.txt"}',
        },
        'ou_bob',
      ),
    )
    await until(() => downloading)
    fake.click(0, 'stop')
    release()
    await until(() =>
      fake.reactions.some(
        (r) => r.messageId === 'trigger' && r.emoji === 'CrossMark',
      ),
    )
    await t.internals.gateway.stopAll()
    expect(
      fake.reactions.find((r) => r.messageId === 'steer' && r.emoji === 'OnIt')
        ?.removed,
    ).toBe(true)
    expect(
      fake.reactions.filter(
        (r) => r.messageId === 'steer' && r.emoji === 'CrossMark',
      ),
    ).toHaveLength(1)
    expect(t.model.calls).toHaveLength(1)
  } finally {
    release?.()
    await t.internals.gateway.stopAll()
  }
})

test('a held bash call shows a bounded single-line command head', async () => {
  let release!: () => void
  const command = `printf 'checking logs\\n'\n# ${'context '.repeat(15)}`
  const { fake, t, start } = setup(
    [fauxToolCall('bash', { command }), fauxText('checked')],
    [
      function hold(api) {
        api.on('tool_call', async (event) => {
          if (event.toolName === 'bash')
            await new Promise<void>((resolve) => {
              release = resolve
            })
        })
      },
    ],
  )
  await start()
  try {
    fake.deliver(topic())
    await until(() => fake.patches.length > 0)
    const content = fake.patches[0]?.card.body.elements[0]?.content ?? ''
    expect(content).toContain("Running: bash — printf 'checking logs")
    expect(content.split(' — ')[1]?.length).toBeLessThanOrEqual(60)
    release()
    await until(() => fake.reactions.some((r) => r.emoji === 'DONE'))
    expect(fake.patches.at(-1)?.card.body.elements[0]?.content).toContain(
      "Finished: bash — printf 'checking logs",
    )
  } finally {
    release?.()
    await t.internals.gateway.stopAll()
  }
})

test('nested tools do not evict the parent summary and credential-bearing input is omitted', async () => {
  let release!: () => void
  const { fake, t, start } = setup(
    [
      fauxToolCall('hold_inspect', {
        query: 'token=private-value',
        password: 'another-secret',
      }),
      fauxText('done'),
    ],
    [
      function hold(api) {
        api.registerTool({
          name: 'inspect',
          description: 'Inspect using nested tools',
          inputSchema: z.object({ query: z.string(), password: z.string() }),
          execute: async (_input, context) => {
            for (let i = 0; i < 9; i++)
              await context?.executeTool?.('bash', {
                command: 'printf nested-detail',
              })
            await new Promise<void>((resolve) => {
              release = resolve
            })
            return 'ok'
          },
        })
      },
    ],
  )
  await start()
  try {
    fake.deliver(topic())
    await until(() => !!release && fake.patches.length > 0)
    const content = JSON.stringify(fake.patches.at(-1)?.card)
    expect(content).toContain('Running: holdinspect')
    expect(content).not.toContain('bash')
    expect(content).not.toContain('private-value')
    expect(content).not.toContain('another-secret')
    release()
    await until(() => fake.reactions.some((r) => r.emoji === 'DONE'))
  } finally {
    release?.()
    await t.internals.gateway.stopAll()
  }
})
