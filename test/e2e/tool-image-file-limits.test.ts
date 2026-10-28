import { afterEach, expect, test } from 'bun:test'
import { readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

test.each(['BMC deployment checklist\n1. Restart service\n', 'BM'])(
  'read_file preserves ordinary text beginning with BM: %s',
  async (text) => {
    const t = createTestVela({
      files: { 'notes.txt': text },
      responses: [
        fauxToolCall('read_file', { path: 'notes.txt' }),
        fauxText('Read the note.'),
      ],
    })
    await t.run('Read notes.txt')
    expect(t.model.calls[1]?.toolResults[0]?.output).toBe(text)
  },
)

test('read_file refuses oversized image input before loading its bytes', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('read_file', { path: 'large.data' }),
      fauxText('The image is too large.'),
    ],
  })
  const path = join(t.cwd, 'large.data')
  writeFileSync(path, pngHeader)
  truncateSync(path, 96 * 1024 * 1024 + 1)
  await t.run('Read large.data')
  expect(JSON.stringify(t.model.calls[1]!.prompt)).toContain(
    'image exceeds the safe decoding size limit',
  )
  expect(t.eventsOf('tool_execution_end')[0]!.isError).toBe(true)
})

test('read_file recognizes a truncated image signature and gives an invalid-image hint', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('read_file', { path: 'truncated.txt' }),
      fauxText('The image is invalid.'),
    ],
  })
  writeFileSync(join(t.cwd, 'truncated.txt'), pngHeader)
  await t.run('Read truncated.txt')
  const prompt = JSON.stringify(t.model.calls[1]!.prompt)
  expect(prompt).toContain('unsupported or invalid image format')
  expect(prompt).not.toContain('�PNG')
})

test('read_file explains that image reads ignore text pagination parameters', async () => {
  const image = readFileSync(
    new URL('../fixtures/images/blue.png', import.meta.url),
  )
  const faux = createFauxModel({
    responses: [
      fauxToolCall('read_file', {
        path: 'picture.txt',
        offset: 100,
        limit: 1,
        column: 40,
      }),
      fauxText('The complete image was returned.'),
    ],
  })
  let description = ''
  const t = createTestVela({
    model: {
      ...faux,
      async doStream(options: Parameters<typeof faux.doStream>[0]) {
        const tool = options.tools?.find((tool) => tool.name === 'read_file')
        if (tool?.type === 'function') description = tool.description ?? ''
        return faux.doStream(options)
      },
    },
  })
  writeFileSync(join(t.cwd, 'picture.txt'), image)
  await t.run('Read picture.txt')
  expect(description).toContain(
    'offset, limit and column are ignored for images',
  )
  expect(JSON.stringify(faux.calls[1]?.prompt)).toContain(
    image.toString('base64'),
  )
})
