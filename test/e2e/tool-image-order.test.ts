import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import z from 'zod'
import type { ImageContent, ToolContent } from '../../src/messages.ts'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { ToolExecutionResult } from '../../src/tools/types.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

const image = (name: string, mimeType: string): ImageContent => ({
  type: 'image',
  data: readFileSync(
    new URL(`../fixtures/images/${name}`, import.meta.url),
  ).toString('base64'),
  mimeType,
})

test.each(['before', 'after'] as const)(
  'oversized captions stay %s their respective images and remain recoverable',
  async (position) => {
    const images = [
      image('blue.png', 'image/png'),
      image('quadrants.jpg', 'image/jpeg'),
    ]
    const captions = [
      `Image A: blue. ${'Detailed blue caption. '.repeat(80)} End of image A.`,
      'Image B: quadrants.',
    ]
    const native = { source: 'ordered-pictures', images }
    const content: ToolContent = images.flatMap((picture, index) => {
      const caption = { type: 'text' as const, text: captions[index]! }
      return position === 'before' ? [caption, picture] : [picture, caption]
    })
    const t = createTestVela({
      extensions: [
        function pictures(v) {
          v.registerTool({
            name: 'ordered',
            description: 'Return two images with their respective captions',
            inputSchema: z.object({}),
            maxResultChars: 160,
            execute: async () => new ToolExecutionResult(native, content),
          })
        },
      ],
      responses: [
        fauxToolCall('pictures_ordered', {}),
        (request) => {
          const path = JSON.stringify(request.toolResults).match(
            /Full text saved at: ([^\\]+)/,
          )?.[1]
          if (!path) throw new Error('The caption recovery path is missing')
          return fauxToolCall('read_file', { path })
        },
        fauxText('Recovered both captions'),
      ],
    })
    await t.run('Describe both images, then read their full captions')

    const requested = t.model.calls[1]!.prompt.flatMap((message) =>
      message.role === 'tool' ? message.content : [],
    ).find((part) => part.type === 'tool-result')!.output
    expect(requested.type).toBe('content')
    if (requested.type !== 'content') throw new Error('Missing image content')
    expect(requested.value.slice(0, 4).map((part) => part.type)).toEqual(
      content.map((part) => (part.type === 'image' ? 'file' : 'text')),
    )
    for (const index of [0, 1]) {
      const imageIndex = index * 2 + (position === 'before' ? 1 : 0)
      const captionIndex = index * 2 + (position === 'before' ? 0 : 1)
      expect(requested.value[imageIndex]).toMatchObject({
        type: 'file',
        mediaType: images[index]!.mimeType,
        data: { type: 'data', data: images[index]!.data },
      })
      const caption = requested.value[captionIndex]!
      expect(caption.type).toBe('text')
      if (caption.type !== 'text') throw new Error('Missing image caption')
      expect(caption.text).toContain(
        index === 0 ? 'Image A: blue.' : captions[1]!,
      )
      expect(caption.text).not.toContain(index === 0 ? 'Image B:' : 'Image A:')
      if (index === 0) {
        expect(caption.text.length).toBeLessThan(captions[0]!.length)
        expect(caption.text).toContain('End of image A.')
      }
    }
    const saved = t.messages
      .flatMap((message) => (message.role === 'tool' ? message.content : []))
      .find((part) => part.type === 'tool-result')!.output
    expect(saved.type).toBe('content')
    if (saved.type !== 'content') throw new Error('Missing saved image content')
    expect(saved.value.slice(0, 4).map((part) => part.type)).toEqual(
      content.map((part) => part.type),
    )
    expect(t.eventsOf('tool_execution_end')[0]?.details).toEqual(native)

    const records = readFileSync(t.session.store.results.history.path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const record = records.find((entry) => entry.type === 'tool_result')
    expect(record.output).toEqual(native)
    const fullCaption = readFileSync(record.modelTextPath, 'utf8')
    expect(fullCaption).toBe(captions.join('\n'))
    for (const picture of images)
      expect(fullCaption).not.toContain(picture.data)
    const recovered = JSON.stringify(t.model.calls[2]!.toolResults.at(-1))
    for (const caption of captions) expect(recovered).toContain(caption)
  },
)

test('many ordered captions share a bounded preview and one recovery notice', async () => {
  const picture = image('blue.png', 'image/png')
  const captions = Array.from(
    { length: 100 },
    (_, index) => `Caption ${index}.`,
  )
  const content: ToolContent = captions.flatMap((text) => [
    picture,
    { type: 'text' as const, text },
  ])
  const maxResultChars = 100
  const t = createTestVela({
    limits: { summaryThreshold: 1e9, maxInputTokens: 1e9 },
    extensions: [
      function pictures(v) {
        v.registerTool({
          name: 'many',
          description: 'Return many images with short captions',
          inputSchema: z.object({}),
          maxResultChars,
          execute: async () => new ToolExecutionResult({}, content),
        })
      },
    ],
    responses: [fauxToolCall('pictures_many', {}), fauxText('done')],
  })
  await t.run('Describe these captioned pictures')
  const output = t.model.calls[1]!.prompt.flatMap((message) =>
    message.role === 'tool' ? message.content : [],
  ).find((part) => part.type === 'tool-result')!.output
  expect(output.type).toBe('content')
  if (output.type !== 'content') throw new Error('Missing image content')
  expect(
    output.value.slice(0, content.length).map((part) => part.type),
  ).toEqual(content.map((part) => (part.type === 'image' ? 'file' : 'text')))
  const texts = output.value.flatMap((part) =>
    part.type === 'text' ? [part.text] : [],
  )
  const notices = texts.filter((text) => text.includes('Full text saved at:'))
  expect(notices).toHaveLength(1)
  const totalTextChars = texts.reduce((total, text) => total + text.length, 0)
  expect(totalTextChars).toBeLessThanOrEqual(
    maxResultChars + notices[0]!.length,
  )
  expect(totalTextChars).toBeLessThan(captions.join('\n').length)
})
