import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type z from 'zod'
import { createFindTool, createGrepTool } from '../../../src/tools/search.ts'

// grep / find run the real ripgrep and fd from PATH (CI installs them; see test/README.md)
const dir = mkdtempSync(join(tmpdir(), 'vela-search-'))
const file = (path: string, content = '') => {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), content)
}

beforeAll(() => {
  // A git repo, so .gitignore applies to both tools
  mkdirSync(join(dir, '.git'))
  file('.git/HEAD', 'needle in git')
  file('.gitignore', 'ignored/\nnode_modules/\n')
  file('top.ts', 'needle top')
  file('src/a.ts', 'needle a\nplain\nNEEDLE upper')
  file('src/b.test.ts', 'needle b')
  file('src/.hidden/c.ts', 'needle hidden')
  file('ignored/d.ts', 'needle ignored')
  file('node_modules/pkg/e.ts', 'needle dep')
  file('long.txt', `needle ${'x'.repeat(600)}`)
  file('regex.txt', 'a.b\naxb')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = async (tool: ReturnType<typeof createGrepTool>, input: object) =>
  String(await tool.execute(input))
const sorted = (output: string) => output.split('\n').sort()

test('grep: matches with paths relative to the search dir, respecting .gitignore and including hidden files', async () => {
  const output = await run(createGrepTool(dir), { pattern: 'needle' })
  expect(sorted(output)).toEqual(
    [
      'long.txt:1: needle ' + 'x'.repeat(493) + '... [truncated]',
      'src/.hidden/c.ts:1: needle hidden',
      'src/a.ts:1: needle a',
      'src/b.test.ts:1: needle b',
      'top.ts:1: needle top',
      '',
      '[Some lines truncated to 500 chars. Use read_file to see full lines]',
    ].sort(),
  )
})

test('grep: case, literal, glob and a single file', async () => {
  const grep = createGrepTool(dir)
  expect(await run(grep, { pattern: 'needle', path: 'src/a.ts' })).toBe(
    'a.ts:1: needle a',
  )
  expect(
    sorted(
      await run(grep, {
        pattern: 'needle',
        path: 'src/a.ts',
        ignoreCase: true,
      }),
    ),
  ).toEqual(['a.ts:1: needle a', 'a.ts:3: NEEDLE upper'])
  expect(
    sorted(await run(grep, { pattern: 'a.b', path: 'regex.txt' })),
  ).toEqual(['regex.txt:1: a.b', 'regex.txt:2: axb'])
  expect(
    await run(grep, { pattern: 'a.b', path: 'regex.txt', literal: true }),
  ).toBe('regex.txt:1: a.b')
  expect(
    await run(grep, { pattern: 'needle', path: 'src', glob: '*.test.ts' }),
  ).toBe('b.test.ts:1: needle b')
  expect(await run(grep, { pattern: 'nothing-here' })).toBe('No matches found')
})

test('grep: context lines and the match limit', async () => {
  const grep = createGrepTool(dir)
  expect(
    await run(grep, { pattern: 'plain', path: 'src/a.ts', context: 1 }),
  ).toBe('a.ts-1- needle a\na.ts:2: plain\na.ts-3- NEEDLE upper')
  const limited = await run(grep, { pattern: 'needle', limit: 2 })
  expect(limited.split('\n\n')[0]!.split('\n')).toHaveLength(2)
  expect(limited).toContain(
    '[2 matches limit reached. Use limit=4 for more, or refine pattern',
  )
})

test('grep: a bad regex or a missing path is an error', async () => {
  const grep = createGrepTool(dir)
  await expect(grep.execute({ pattern: '(' })).rejects.toThrow('regex')
  await expect(grep.execute({ pattern: 'x', path: 'nope' })).rejects.toThrow(
    'Path not found',
  )
})

test('find: glob patterns, with and without a slash, respecting .gitignore', async () => {
  const find = createFindTool(dir)
  expect(sorted(await run(find, { pattern: '*.ts' }))).toEqual([
    'src/.hidden/c.ts',
    'src/a.ts',
    'src/b.test.ts',
    'top.ts',
  ])
  expect(sorted(await run(find, { pattern: 'src/*.ts' }))).toEqual([
    'src/a.ts',
    'src/b.test.ts',
  ])
  expect(await run(find, { pattern: '*.ts', path: 'src/.hidden' })).toBe('c.ts')
  expect(await run(find, { pattern: '*.nothing' })).toBe(
    'No files found matching pattern',
  )
  expect(await run(find, { pattern: '*.ts', limit: 1 })).toContain(
    '[1 results limit reached. Use limit=2 for more, or refine pattern]',
  )
})

test('grep and find: .gitignore applies outside a git repo too', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'vela-find-'))
  try {
    writeFileSync(join(plain, '.gitignore'), 'skip.ts\n')
    writeFileSync(join(plain, 'skip.ts'), 'needle')
    writeFileSync(join(plain, 'keep.ts'), 'needle')
    expect(await run(createFindTool(plain), { pattern: '*.ts' })).toBe(
      'keep.ts',
    )
    expect(await run(createGrepTool(plain), { pattern: 'needle' })).toBe(
      'keep.ts:1: needle',
    )
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})

test('context and limit must be whole numbers', () => {
  const grep = createGrepTool(dir).inputSchema as z.ZodType
  expect(grep.safeParse({ pattern: 'x', context: 0.5 }).success).toBe(false)
  expect(grep.safeParse({ pattern: 'x', limit: 1.5 }).success).toBe(false)
  expect(grep.safeParse({ pattern: 'x', context: 2, limit: 10 }).success).toBe(
    true,
  )
  expect(
    (createFindTool(dir).inputSchema as z.ZodType).safeParse({
      pattern: '*',
      limit: 0.5,
    }).success,
  ).toBe(false)
})

test('aborting stops waiting for a program that is still downloading', async () => {
  const downloading = () => new Promise<string>(() => {})
  for (const tool of [
    createGrepTool(dir, downloading),
    createFindTool(dir, downloading),
  ]) {
    const controller = new AbortController()
    const result = tool.execute({ pattern: 'x' }, {
      signal: controller.signal,
    } as never)
    controller.abort(new Error('cancelled'))
    await expect(result).rejects.toThrow('cancelled')
  }
})

test('a missing program is reported, not worked around', async () => {
  const missing = () =>
    Promise.reject(new Error('ripgrep (rg) is not installed'))
  await expect(
    createGrepTool(dir, missing).execute({ pattern: 'x' }),
  ).rejects.toThrow('ripgrep (rg) is not installed')
})
