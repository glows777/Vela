import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { LanguageModelV4Prompt } from '@ai-sdk/provider'
import {
  createFauxModel,
  fauxSummary,
  fauxText,
} from '../../src/testing/faux.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

const fixture = (name = 'blue.png') => ({
  type: 'image' as const,
  data: readFileSync(
    new URL(`../fixtures/images/${name}`, import.meta.url),
  ).toString('base64'),
  mimeType: 'image/png',
})
const imagesIn = (prompt: LanguageModelV4Prompt) =>
  prompt.flatMap((message) =>
    message.role === 'user'
      ? message.content.filter((part) => part.type === 'image')
      : [],
  )

test('image prompt reaches the provider as an image and history uses one inline base64 shape', async () => {
  const image = fixture()
  const t = createTestVela({ responses: [fauxText('blue')] })
  await t.session.prompt('Describe the image', { images: [image] })
  const parts = imagesIn(t.model.calls[0]!.prompt)
  expect(parts).toHaveLength(1)
  expect(parts[0]).toMatchObject({ type: 'image', mediaType: 'image/png' })
  expect(Buffer.from(parts[0]!.image as Uint8Array).toString('base64')).toBe(
    image.data,
  )
  expect(t.messages[0]).toEqual({
    role: 'user',
    content: [{ type: 'text', text: 'Describe the image' }, image],
  })
  expect(t.readData('sessions/default.jsonl')).toContain(image.data)
})

test('oversized prompt image is resized before it reaches the provider', async () => {
  const image = fixture('wide.png')
  const t = createTestVela({ responses: [fauxText('wide')] })
  await t.session.prompt('Describe the wide image', { images: [image] })
  const parts = imagesIn(t.model.calls[0]!.prompt)
  expect(parts).toHaveLength(1)
  expect(
    Buffer.from(parts[0]!.image as Uint8Array).toString('base64'),
  ).not.toBe(image.data)
  expect(
    Buffer.from(parts[0]!.image as Uint8Array).toString('base64').length,
  ).toBeLessThanOrEqual(4.5 * 1024 * 1024)
})

test('invalid image is dropped with a useful text reason instead of failing the whole prompt', async () => {
  const t = createTestVela({ responses: [fauxText('text reply')] })
  await t.session.prompt('Keep my question', {
    images: [{ type: 'image', data: 'not-an-image', mimeType: 'image/png' }],
  })
  expect(imagesIn(t.model.calls[0]!.prompt)).toHaveLength(0)
  expect(t.model.calls[0]!.lastUserText).toContain('Keep my question')
  expect(t.model.calls[0]!.lastUserText).toMatch(
    /image.*(omitted|dropped|failed|invalid)/i,
  )
})

test('non-vision model gets a placeholder; switching back retains the image', async () => {
  const model = createFauxModel({
    responses: [fauxText('text'), fauxText('vision')],
  })
  const t = createTestVela({
    model: 'faux/text',
    providers: {
      faux: {
        models: [
          { id: 'text', input: ['text'] },
          { id: 'vision', input: ['text', 'image'] },
        ],
        createModel: () => model,
      },
    },
  })
  await t.session.prompt('Describe this', { images: [fixture()] })
  expect(imagesIn(model.calls[0]!.prompt)).toHaveLength(0)
  expect(model.calls[0]!.lastUserText).toContain(
    '(image omitted: model does not support images)',
  )
  expect(JSON.stringify(t.messages[0])).toContain(fixture().data)
  t.session.setModel('faux/vision')
  await t.session.prompt('Now look again')
  expect(imagesIn(model.calls[1]!.prompt)).toHaveLength(1)
})

test('resume, clone and a fork including the user entry keep image content', async () => {
  const image = fixture()
  const t = createTestVela({ responses: [fauxText('seen')] })
  await t.session.prompt('Remember this picture', { images: [image] })
  const user = t.session
    .getEntries()
    .find((entry) => entry.type === 'message' && entry.message.role === 'user')!
  const clone = await t.session.clone({ sessionId: 'image-clone' })
  const fork = await t.session.fork(user.id, {
    sessionId: 'image-fork',
    position: 'at',
  })
  expect(JSON.stringify(clone.session!.messages[0])).toContain(image.data)
  expect(JSON.stringify(fork.session!.messages[0])).toContain(image.data)
  const resumed = createTestVela({
    cwd: t.cwd,
    responses: [fauxText('remembered')],
  })
  expect(await resumed.session.resume()).toBe(true)
  await resumed.session.prompt('What did I send?')
  expect(imagesIn(resumed.model.calls[0]!.prompt)).toHaveLength(1)
})

test('input hooks receive and replace images, including extension content arrays', async () => {
  const seen: unknown[] = []
  const replacement = fixture('wide.png')
  const t = createTestVela({
    responses: [fauxText('changed'), fauxText('extension')],
    extensions: [
      (v) => {
        v.on('input', (event) => {
          seen.push(event.images)
          return {
            action: 'transform',
            text: `${event.text} transformed`,
            images: event.source === 'extension' ? [] : [replacement],
          }
        })
      },
    ],
  })
  await t.session.prompt('input', { images: [fixture()] })
  expect(seen[0]).toEqual([fixture()])
  expect(imagesIn(t.model.calls[0]!.prompt)).toHaveLength(1)
  await t.session.sendUserMessage([
    { type: 'text', text: 'extension input' },
    fixture(),
  ])
  expect(seen[1]).toEqual([fixture()])
  expect(imagesIn(t.model.calls[1]!.prompt)).toHaveLength(1) // earlier history only
  expect(t.model.calls[1]!.lastUserText).toBe('extension input transformed')
})

test('steer and follow-up images remain attached in queue order', async () => {
  const t = createTestVela({
    responses: [
      () => {
        void t.session.steer('steering image', { images: [fixture()] })
        void t.session.followUp('follow-up image', { images: [fixture()] })
        return fauxText('first')
      },
      fauxText('steered'),
      fauxText('followed'),
    ],
  })
  await t.run('start')
  expect(t.model.calls.map((call) => imagesIn(call.prompt).length)).toEqual([
    0, 1, 2,
  ])
  expect(t.model.calls[1]!.lastUserText).toBe('steering image')
  expect(t.model.calls[2]!.lastUserText).toBe('follow-up image')
})

test('summary compaction never serializes image base64 as text', async () => {
  const image = fixture()
  const t = createTestVela({
    responses: Array.from({ length: 5 }, () => fauxText('A blue rectangle.')),
    generate: [fauxSummary()],
  })
  await t.session.prompt('The goal is to identify the blue rectangle.', {
    images: [image],
  })
  for (let i = 0; i < 4; i++)
    await t.run(`Keep the blue rectangle context ${i}`)
  await t.session.compact()
  const summary = t.model.calls.find((call) => call.kind === 'generate')!
  expect(summary).toBeDefined()
  const texts = summary.prompt.flatMap((m) =>
    typeof m.content === 'string'
      ? [m.content]
      : m.content.filter((p) => p.type === 'text').map((p) => p.text),
  )
  expect(texts.join('\n')).not.toContain(image.data)
  expect(JSON.stringify(t.session.getEntries())).toContain(image.data)
})
