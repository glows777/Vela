import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type {
  LanguageModelV4FilePart,
  LanguageModelV4Prompt,
  SharedV4FileData,
} from '@ai-sdk/provider'
import { PhotonImage } from '@silvia-odwyer/photon-node'
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
const encoded = (data: SharedV4FileData) => {
  if (data.type !== 'data') throw new Error('Expected inline image data')
  return typeof data.data === 'string'
    ? data.data
    : Buffer.from(data.data).toString('base64')
}
const imagesIn = (prompt: LanguageModelV4Prompt) =>
  prompt.flatMap((message) =>
    message.role === 'user'
      ? message.content.filter(
          (part): part is LanguageModelV4FilePart =>
            part.type === 'file' && part.mediaType.startsWith('image/'),
        )
      : [],
  )
const alphaContrast = (data: string) => {
  const image = PhotonImage.new_from_byteslice(Buffer.from(data, 'base64'))
  try {
    const raw = image.get_raw_pixels()
    let opaqueDark = 0
    let transparent = 0
    for (let i = 0; i < raw.length; i += 4) {
      const alpha = raw[i + 3] ?? 0
      const rgb = (raw[i] ?? 0) + (raw[i + 1] ?? 0) + (raw[i + 2] ?? 0)
      if (alpha < 16) transparent++
      if (alpha > 200 && rgb < 48) opaqueDark++
    }
    const count = raw.length / 4
    return {
      longest: Math.max(image.get_width(), image.get_height()),
      opaqueDark: opaqueDark / count,
      transparent: transparent / count,
    }
  } finally {
    image.free()
  }
}

test('image prompt reaches the provider as an image and history uses one inline base64 shape', async () => {
  const image = fixture()
  const t = createTestVela({ responses: [fauxText('blue')] })
  await t.session.prompt('Describe the image', { images: [image] })
  const parts = imagesIn(t.model.calls[0]!.prompt)
  expect(parts).toHaveLength(1)
  expect(parts[0]).toMatchObject({ type: 'file', mediaType: 'image/png' })
  expect(encoded(parts[0]!.data)).toBe(image.data)
  expect(t.messages[0]).toEqual({
    role: 'user',
    content: [{ type: 'text', text: 'Describe the image' }, image],
  })
  expect(await t.readData('sessions/default.jsonl')).toContain(image.data)
})

test('oversized prompt image is resized before it reaches the provider', async () => {
  const image = fixture('wide.png')
  const t = createTestVela({ responses: [fauxText('wide')] })
  await t.session.prompt('Describe the wide image', { images: [image] })
  const parts = imagesIn(t.model.calls[0]!.prompt)
  expect(parts).toHaveLength(1)
  expect(encoded(parts[0]!.data)).not.toBe(image.data)
  expect(encoded(parts[0]!.data).length).toBeLessThanOrEqual(4.5 * 1024 * 1024)
})

test('resized transparent PNG keeps dark lines distinguishable from the background', async () => {
  const image = fixture('transparent-lines.png')
  const original = PhotonImage.new_from_byteslice(
    Buffer.from(image.data, 'base64'),
  )
  try {
    expect(
      Math.max(original.get_width(), original.get_height()),
    ).toBeGreaterThan(2000)
  } finally {
    original.free()
  }
  const t = createTestVela({ responses: [fauxText('lines')] })
  await t.session.prompt('what is in this diagram?', { images: [image] })
  const parts = imagesIn(t.model.calls[0]!.prompt)
  expect(parts).toHaveLength(1)
  const sent = encoded(parts[0]!.data)
  const history = t.messages[0]?.content
  const saved = (Array.isArray(history) ? history : []).find(
    (part) => part.type === 'image',
  )
  expect(saved).toMatchObject({
    type: 'image',
    mimeType: 'image/png',
    data: sent,
  })
  expect(parts[0]).toMatchObject({ type: 'file', mediaType: 'image/png' })
  expect(sent).not.toBe(image.data)
  expect(sent.length).toBeLessThanOrEqual(4.5 * 1024 * 1024)
  const seen = alphaContrast(sent)
  expect(seen.longest).toBeLessThanOrEqual(2000)
  expect(seen.opaqueDark).toBeGreaterThan(0.02)
  expect(seen.transparent).toBeGreaterThan(0.5)
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

test('saved and appended images are sent as stored, without decoding them again (like pi)', async () => {
  const image = fixture()
  // PNG signature plus a complete IHDR and no pixel data: the decoder would reject it
  const headerOnly = {
    type: 'image' as const,
    data: Buffer.from(image.data, 'base64').subarray(0, 33).toString('base64'),
    mimeType: 'image/png',
  }
  const t = createTestVela({ responses: [fauxText('seen')] })
  t.session.append({
    role: 'user',
    content: [{ type: 'text', text: 'appended by an extension' }, headerOnly],
  })
  await t.session.prompt('Remember this picture', { images: [image] })
  const sent = (prompt: LanguageModelV4Prompt) =>
    imagesIn(prompt).map((part) => encoded(part.data))
  expect(sent(t.model.calls[0]!.prompt)).toEqual([headerOnly.data, image.data])
  const resumed = createTestVela({
    cwd: t.cwd,
    responses: [fauxText('remembered')],
  })
  expect(await resumed.session.resume()).toBe(true)
  await resumed.session.prompt('What did I send?')
  expect(sent(resumed.model.calls[0]!.prompt)).toEqual([
    headerOnly.data,
    image.data,
  ])
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

test('normalizing triggered and queued custom content preserves display metadata and session entries', async () => {
  const t = createTestVela({
    responses: [
      () => {
        void t.session.sendMessage(
          {
            customType: 'queued',
            content: [{ type: 'text', text: 'queued note' }, fixture()],
            display: false,
            details: { saved: 'queued' },
          },
          { deliverAs: 'followUp' },
        )
        return fauxText('first')
      },
      fauxText('second'),
    ],
  })
  await t.session.sendMessage(
    {
      customType: 'triggered',
      content: [{ type: 'text', text: 'triggered note' }],
      display: false,
      details: { saved: 'triggered' },
    },
    { triggerTurn: true },
  )
  const custom = t.session
    .getEntries()
    .filter((entry) => entry.type === 'custom_message')
  expect(custom).toHaveLength(2)
  expect(
    custom.map((entry) => ({
      type: entry.customType,
      display: entry.display,
      details: entry.details,
    })),
  ).toEqual([
    { type: 'triggered', display: false, details: { saved: 'triggered' } },
    { type: 'queued', display: false, details: { saved: 'queued' } },
  ])
  expect(
    t
      .eventsOf('message_end')
      .filter((event) => event.custom)
      .map((event) => event.custom?.customType),
  ).toEqual(['triggered', 'queued'])
  expect(imagesIn(t.model.calls[1]!.prompt)).toHaveLength(1)
})

test('text-only requests omit compatible AI SDK image file parts from user and tool history', async () => {
  const model = createFauxModel({ responses: [fauxText('text')] })
  const t = createTestVela({
    model: 'faux/text',
    providers: {
      faux: {
        models: [{ id: 'text', input: ['text'] }],
        createModel: () => model,
      },
    },
  })
  const image = fixture()
  t.session.append({
    role: 'user',
    content: [{ type: 'file', data: image.data, mediaType: 'image/png' }],
  })
  t.session.append({
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolName: 'picture',
        toolCallId: 'picture-1',
        input: {},
      },
    ],
  })
  t.session.append({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolName: 'picture',
        toolCallId: 'picture-1',
        output: {
          type: 'content',
          value: [
            {
              type: 'file',
              data: { type: 'data', data: image.data },
              mediaType: 'image',
            },
            {
              type: 'image-file-reference',
              providerReference: { openai: 'reference-image-1' },
            },
          ],
        },
      },
    ],
  })
  await t.session.prompt('Continue')
  const request = JSON.stringify(model.calls[0]!.prompt)
  expect(request).toContain('(image omitted: model does not support images)')
  expect(request.match(/tool image omitted/g)).toHaveLength(2)
  expect(request).not.toContain(image.data)
  expect(request).not.toContain('reference-image-1')
  expect(JSON.stringify(t.session.messages)).toContain(image.data)
})
