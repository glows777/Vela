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
