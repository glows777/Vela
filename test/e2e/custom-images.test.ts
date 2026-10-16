import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { CustomMessage } from '../../src/extensions/types.ts'
import { imageMetadata } from '../../src/images/metadata.ts'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

const oversized = () => ({
  type: 'image' as const,
  data: readFileSync(
    new URL('../fixtures/images/wide.png', import.meta.url),
  ).toString('base64'),
  mimeType: 'image/png',
})
const custom = (customType = 'picture'): CustomMessage => ({
  customType,
  display: true,
  details: { source: 'extension' },
  content: [
    { type: 'text', text: 'Keep the picture and its note' },
    oversized(),
    { type: 'image', data: 'invalid-image', mimeType: 'image/png' },
  ],
})

for (const route of [
  'default',
  'nextTurn',
  'before_agent_start',
  'pending',
] as const) {
  test(`${route} custom images are normalized in history, events and persisted entries`, async () => {
    const message = custom(route)
    const t = createTestVela({
      responses:
        route === 'pending'
          ? [fauxToolCall('pictures_add_picture', {}), fauxText('seen')]
          : [fauxText('seen')],
      extensions: [
        function pictures(v) {
          if (route === 'before_agent_start')
            v.on('before_agent_start', () => ({ message }))
          if (route === 'pending')
            v.registerTool({
              name: 'add_picture',
              description: 'Add a custom picture while a tool is running',
              inputSchema: z.object({}),
              execute: async () => {
                await t.session.sendMessage(message, { triggerTurn: false })
                return 'picture added'
              },
            })
        },
      ],
    })
    if (route === 'default') await t.session.sendMessage(message)
    if (route === 'nextTurn')
      await t.session.sendMessage(message, { deliverAs: 'nextTurn' })
    await t.run('Look at the extension picture')
    const entry = t.session
      .getEntries()
      .find((e) => e.type === 'custom_message')
    expect(entry).toMatchObject({
      customType: route,
      display: true,
      details: message.details,
    })
    if (entry?.type !== 'custom_message' || typeof entry.content === 'string')
      throw new Error('Missing custom content parts')
    const images = entry.content.filter(
      (part) => part.type === 'image' && 'data' in part,
    )
    expect(images).toHaveLength(1)
    const image = images[0]!
    if (image.type !== 'image' || !('data' in image))
      throw new Error('Missing normalized image')
    expect(image.data).not.toBe(oversized().data)
    const metadata = imageMetadata(Buffer.from(image.data, 'base64'))!
    expect(Math.max(metadata.width, metadata.height)).toBeLessThanOrEqual(2000)
    expect(image.data.length).toBeLessThanOrEqual(4.5 * 1024 * 1024)
    expect(JSON.stringify(entry.content)).toContain(
      'image omitted: invalid image base64 data',
    )
    const history = t.messages.find(
      (m) => t.session.customMessageOf(m)?.customType === route,
    )
    expect(history?.content).toEqual(entry.content)
    const event = t
      .eventsOf('message_end')
      .find((e) => e.custom?.customType === route)
    expect(event?.message.content).toEqual(entry.content)
    const saved = await t.readData('sessions/default.jsonl')
    expect(saved).not.toContain('invalid-image')
    expect(saved).not.toContain(oversized().data)
    expect(saved).toContain(image.data)
    const resumed = createTestVela({ cwd: t.cwd, responses: [] })
    expect(await resumed.session.resume()).toBe(true)
    expect(
      resumed.session.getEntries().find((e) => e.type === 'custom_message'),
    ).toEqual(entry)
  })
}

test('text-only custom messages still append and queue synchronously', async () => {
  const t = createTestVela({ responses: [fauxText('seen')] })
  const send = t.session.sendMessage({
    customType: 'text',
    content: 'immediate',
    display: false,
  })
  expect(t.messages).toHaveLength(1)
  await send
  const queued = t.session.sendMessage(
    { customType: 'next', content: 'next turn', display: false },
    { deliverAs: 'nextTurn' },
  )
  const run = t.run('begin')
  await Promise.all([queued, run])
  expect(t.model.calls[0]!.lastUserText).toBe('next turn')
})

test('closing during custom image normalization cannot append after the final save', async () => {
  const t = createTestVela({ responses: [] })
  const send = t.session.sendMessage(custom()).then(
    () => 'accepted',
    (error: Error) => error.message,
  )
  await t.session.close()
  expect(await send).toMatch(/closed/)
  expect(
    t.session.getEntries().filter((e) => e.type === 'custom_message'),
  ).toHaveLength(0)
})

test('closing while before_agent_start returns custom images does not record them', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const t = createTestVela({
    responses: [],
    extensions: [
      (v) => {
        v.on('before_agent_start', async () => {
          entered.resolve()
          await release.promise
          return { message: custom() }
        })
      },
    ],
  })
  const run = t.run('start').catch((error: Error) => error.message)
  await entered.promise
  const closing = t.session.close()
  release.resolve()
  await Promise.all([run, closing])
  expect(
    t.session.getEntries().filter((e) => e.type === 'custom_message'),
  ).toHaveLength(0)
  expect(t.model.calls).toHaveLength(0)
})

test('agent_start listeners can synchronously add next-turn custom text to the current prompt', async () => {
  const t = createTestVela({ responses: [fauxText('seen')] })
  let customVisibleAtMicrotask = false
  t.session.subscribe((event) => {
    if (event.type === 'agent_start') {
      queueMicrotask(() => {
        customVisibleAtMicrotask = t.session
          .getEntries()
          .some((e) => e.type === 'custom_message')
      })
      void t.session.sendMessage(
        { customType: 'at-start', content: 'listener note', display: false },
        { deliverAs: 'nextTurn' },
      )
    }
  })
  await t.run('begin')
  expect(t.model.calls[0]!.lastUserText).toBe('listener note')
  expect(customVisibleAtMicrotask).toBe(true)
  expect(
    t.session.getEntries().filter((e) => e.type === 'custom_message'),
  ).toHaveLength(1)
})

for (const timing of ['synchronous', 'late image'] as const) {
  test(`${timing} abort after agent_start ends the run and retains unconsumed next-turn images`, async () => {
    const t = createTestVela({ responses: [fauxText('retried')] })
    const controller = new AbortController()
    const unsubscribe = t.session.subscribe((event) => {
      if (event.type !== 'agent_start') return
      if (timing === 'late image') {
        void t.session.sendMessage(custom('late'), { deliverAs: 'nextTurn' })
        queueMicrotask(() => controller.abort())
      } else controller.abort()
    })
    await expect(
      t.session.prompt('first', { signal: controller.signal }),
    ).rejects.toThrow()
    expect(t.eventsOf('agent_end')).toHaveLength(1)
    expect(t.eventsOf('agent_end')[0]).toMatchObject({
      reason: 'aborted',
      messages: [],
    })
    expect(t.model.calls).toHaveLength(0)
    expect(
      t.session.getEntries().filter((e) => e.type === 'custom_message'),
    ).toHaveLength(0)
    unsubscribe()
    await t.run('retry')
    const entries = t.session
      .getEntries()
      .filter((e) => e.type === 'custom_message')
    expect(entries).toHaveLength(timing === 'late image' ? 1 : 0)
    expect(JSON.stringify(entries)).not.toContain('invalid-image')
  })
}

for (const state of ['idle', 'busy'] as const) {
  test(`concurrent append-only image and text messages keep invocation order while ${state}`, async () => {
    const send = async () => {
      const first = t.session.sendMessage(custom('first'), {
        triggerTurn: false,
      })
      const second = t.session.sendMessage(
        {
          customType: 'second',
          content: 'SECOND',
          display: false,
          details: { order: 2 },
        },
        { triggerTurn: false },
      )
      const third = t.session.sendMessage(
        {
          customType: 'third',
          content: [
            { type: 'image', data: 'invalid-image', mimeType: 'image/png' },
          ],
          display: true,
        },
        { triggerTurn: false },
      )
      await Promise.all([first, second, third])
    }
    const t = createTestVela({
      responses:
        state === 'busy'
          ? [fauxToolCall('ordered_send', {}), fauxText('seen')]
          : [fauxText('seen')],
      extensions: [
        function ordered(v) {
          v.registerTool({
            name: 'send',
            description: 'Send concurrent custom messages',
            inputSchema: z.object({}),
            execute: async () => {
              await send()
              return 'sent'
            },
          })
        },
      ],
    })
    if (state === 'idle') await send()
    await t.run('Read the custom notes in order')
    const customEntries = t.session
      .getEntries()
      .filter((e) => e.type === 'custom_message')
    expect(customEntries.map((e) => e.customType)).toEqual([
      'first',
      'second',
      'third',
    ])
    expect(
      t
        .eventsOf('message_end')
        .filter((e) => e.custom)
        .map((e) => e.custom?.customType),
    ).toEqual(['first', 'second', 'third'])
    expect(
      t.messages
        .filter((m) => t.session.customMessageOf(m))
        .map((m) => t.session.customMessageOf(m)?.customType),
    ).toEqual(['first', 'second', 'third'])
    const saved = (await t.readData('sessions/default.jsonl'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    expect(
      saved.filter((e) => e.type === 'custom_message').map((e) => e.customType),
    ).toEqual(['first', 'second', 'third'])
    expect(JSON.stringify(customEntries)).not.toContain(oversized().data)
    expect(JSON.stringify(customEntries)).not.toContain('invalid-image')
    expect(customEntries[1]).toMatchObject({
      display: false,
      details: { order: 2 },
    })
    const synchronous = t.session.sendMessage({
      customType: 'after',
      content: 'after',
      display: false,
    })
    expect(
      t.session
        .getEntries()
        .filter((e) => e.type === 'custom_message')
        .at(-1),
    ).toMatchObject({ customType: 'after' })
    await synchronous
  })
}

test('close rejects both a pending append-only image and the text waiting behind it', async () => {
  const t = createTestVela({ responses: [] })
  const sends = [
    t.session.sendMessage(custom('first')),
    t.session.sendMessage({
      customType: 'second',
      content: 'SECOND',
      display: true,
    }),
  ]
  const settled = Promise.allSettled(sends)
  await t.session.close()
  const results = await settled
  expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
  for (const result of results) {
    if (result.status === 'rejected')
      expect(result.reason.message).toMatch(/closed/)
  }
  expect(
    t.session.getEntries().filter((e) => e.type === 'custom_message'),
  ).toHaveLength(0)
})
