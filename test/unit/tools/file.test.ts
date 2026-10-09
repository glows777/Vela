import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createEditFileTool,
  createReadFileTool,
  type EditFileDetails,
  editFileToolParamSchema,
} from '../../../src/tools/file.ts'
import { withFileMutationQueue } from '../../../src/tools/file-mutation-queue.ts'
import type { ToolExecutionResult } from '../../../src/tools/registry.ts'

const dir = mkdtempSync(join(tmpdir(), 'vela-file-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('edit_file writes newText literally, without $ replacement patterns', async () => {
  writeFileSync(join(dir, 'price.txt'), 'cost: X\n')
  const tool = createEditFileTool(dir)
  await tool.execute({
    path: 'price.txt',
    edits: [{ oldText: 'X', newText: "$$5 and $& and $1 and $` and $'" }],
  })
  expect(readFileSync(join(dir, 'price.txt'), 'utf8')).toBe(
    "cost: $$5 and $& and $1 and $` and $'\n",
  )
})

const editIn = (name: string, content: string | Buffer) => {
  writeFileSync(join(dir, name), content)
  return createEditFileTool(dir)
}
const parseEdit = (input: unknown) =>
  editFileToolParamSchema.parse(input) as Parameters<
    ReturnType<typeof createEditFileTool>['execute']
  >[0]

test('edit_file applies several disjoint edits matched against the original file', async () => {
  const tool = editIn('multi.txt', 'alpha\nbeta\ngamma\n')
  const result = (await tool.execute(
    parseEdit({
      path: 'multi.txt',
      edits: [
        { oldText: 'gamma', newText: 'GAMMA' },
        { oldText: 'alpha', newText: 'ALPHA' },
      ],
    }),
  )) as ToolExecutionResult
  expect(readFileSync(join(dir, 'multi.txt'), 'utf8')).toBe('ALPHA\nbeta\nGAMMA\n')
  expect(result.text).toBe('Successfully replaced 2 block(s) in multi.txt.')
  const details = result.value as EditFileDetails
  expect(details.firstChangedLine).toBe(1)
  expect(details.diff).toContain('-1 alpha')
  expect(details.diff).toContain('+1 ALPHA')
  expect(details.patch).toContain('+++ multi.txt')
})

test('edit_file fails loudly on a missing, duplicate or overlapping oldText and leaves the file alone', async () => {
  const tool = editIn('strict.txt', 'one two one\n')
  const edit = (edits: unknown) => tool.execute(parseEdit({ path: 'strict.txt', edits }))
  await expect(edit([{ oldText: 'three', newText: 'x' }])).rejects.toThrow(
    'Could not find the exact text in strict.txt',
  )
  await expect(edit([{ oldText: 'one', newText: 'x' }])).rejects.toThrow(
    'Found 2 occurrences',
  )
  await expect(
    edit([
      { oldText: 'one two', newText: 'x' },
      { oldText: 'two one', newText: 'y' },
    ]),
  ).rejects.toThrow('overlap')
  await expect(
    createEditFileTool(dir).execute(
      parseEdit({ path: 'nope.txt', edits: [{ oldText: 'a', newText: 'b' }] }),
    ),
  ).rejects.toThrow('Could not edit file: nope.txt')
  expect(readFileSync(join(dir, 'strict.txt'), 'utf8')).toBe('one two one\n')
})

test('edit_file falls back to fuzzy matching and only rewrites the matched lines', async () => {
  // Smart quotes and trailing spaces in the file; the model sends plain ASCII
  const tool = editIn('fuzzy.txt', 'keep  \nsay “hi” — now   \nkeep too  \n')
  await tool.execute(
    parseEdit({
      path: 'fuzzy.txt',
      edits: [{ oldText: 'say "hi" - now', newText: 'say "bye"' }],
    }),
  )
  expect(readFileSync(join(dir, 'fuzzy.txt'), 'utf8')).toBe(
    'keep  \nsay "bye"\nkeep too  \n',
  )
})

test('edit_file keeps a BOM and CRLF line endings', async () => {
  const tool = editIn('crlf.txt', '﻿a\r\nb\r\n')
  await tool.execute(
    parseEdit({ path: 'crlf.txt', edits: [{ oldText: 'a\nb', newText: 'a\nB' }] }),
  )
  expect(readFileSync(join(dir, 'crlf.txt'), 'utf8')).toBe('﻿a\r\nB\r\n')
})

test('edit_file accepts the argument shapes models get wrong, like pi', () => {
  const edits = [{ oldText: 'a', newText: 'b' }]
  expect(parseEdit({ path: 'p', edits: JSON.stringify(edits) })).toEqual({ path: 'p', edits })
  expect(parseEdit({ path: 'p', edits: edits[0] })).toEqual({ path: 'p', edits })
  expect(parseEdit({ path: 'p', oldText: 'a', newText: 'b' })).toEqual({ path: 'p', edits })
  expect(() => parseEdit({ path: 'p', edits: [] })).toThrow()
})

test('writes to the same file queue up, different files run in parallel', async () => {
  const order: string[] = []
  const slow = (id: string, file: string, ms: number) =>
    withFileMutationQueue(join(dir, file), async () => {
      order.push(`${id}-start`)
      await Bun.sleep(ms)
      order.push(`${id}-end`)
    })
  await Promise.all([slow('a', 'q1', 40), slow('b', 'q1', 0), slow('c', 'q2', 0)])
  expect(order.indexOf('b-start')).toBeGreaterThan(order.indexOf('a-end'))
  expect(order.indexOf('c-end')).toBeLessThan(order.indexOf('a-end'))
})

test('read_file pages default to 2000 lines and stop at 50KB', async () => {
  const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n')
  writeFileSync(join(dir, 'long.txt'), `${lines}\n`)
  const read = createReadFileTool(dir)
  const first = (await read.execute({ path: 'long.txt' })) as string
  expect(first).toContain('[read_file: lines 1-2000')
  expect(first).toContain('offset=2001')

  writeFileSync(join(dir, 'wide.txt'), `${'x'.repeat(1000)}\n`.repeat(100))
  const wide = (await read.execute({ path: 'wide.txt' })) as string
  expect(wide).toContain('[read_file: lines 1-52, starting column=0; 51200 UTF-16 code units shown')
  expect(new TextEncoder().encode(wide.slice(0, wide.indexOf('\n\n[read_file'))).length).toBeLessThanOrEqual(50 * 1024)
})
