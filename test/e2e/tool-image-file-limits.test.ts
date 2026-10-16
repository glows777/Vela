import { afterEach, expect, test } from 'bun:test'
import { truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

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
