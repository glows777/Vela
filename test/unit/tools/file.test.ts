import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEditFileTool } from '../../../src/tools/file.ts'

const dir = mkdtempSync(join(tmpdir(), 'vela-file-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('edit_file writes new_string literally, without $ replacement patterns', async () => {
  writeFileSync(join(dir, 'price.txt'), 'cost: X\n')
  const tool = createEditFileTool(dir)
  await tool.execute({
    path: 'price.txt',
    old_string: 'X',
    new_string: "$$5 and $& and $1 and $` and $'",
  })
  expect(readFileSync(join(dir, 'price.txt'), 'utf8')).toBe(
    "cost: $$5 and $& and $1 and $` and $'\n",
  )
})
