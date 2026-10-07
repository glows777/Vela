import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGlobTool, createGrepTool } from '../../../src/tools/search.ts'

const dir = mkdtempSync(join(tmpdir(), 'vela-search-'))
const file = (path: string, content = '') => {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), content)
}

beforeAll(() => {
  file('top.ts', 'needle top')
  file('src/a.ts', 'needle a\nplain')
  file('src/.hidden/b.ts', 'needle hidden')
  file('.dot.ts', 'needle dot')
  file('node_modules/pkg/c.ts', 'needle dep')
  file('.git/d.ts', 'needle git')
  file('dist/e.ts', 'needle dist')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const lines = (output: unknown) => String(output).split('\n').sort()

test('glob matches files relative to the search dir, skipping dotfiles, node_modules and .git', async () => {
  const glob = createGlobTool(dir)
  // glob 只跳过 node_modules / .git（dist 照常列出）
  expect(lines(await glob.execute({ pattern: '**/*.ts' }))).toEqual([
    'dist/e.ts',
    'src/a.ts',
    'top.ts',
  ])
  expect(lines(await glob.execute({ pattern: '*.ts', path: 'src' }))).toEqual([
    'a.ts',
  ])
})

test('grep searches dotfiles but skips node_modules, .git and dist', async () => {
  const grep = createGrepTool(dir)
  const output = String(await grep.execute({ pattern: 'needle', path: '.' }))
  expect(output).toContain('top.ts:1: needle top')
  expect(output).toContain('src/a.ts:1: needle a')
  expect(output).toContain('src/.hidden/b.ts:1: needle hidden')
  expect(output).toContain('.dot.ts:1: needle dot')
  expect(output).not.toContain('needle dep')
  expect(output).not.toContain('needle git')
  expect(output).not.toContain('needle dist')
})

test('grep on a single file, and stops at 50 matches', async () => {
  const grep = createGrepTool(dir)
  expect(
    String(await grep.execute({ pattern: 'needle', path: 'src/a.ts' })),
  ).toBe(':1: needle a')
  // 单独的目录：50 条上限不影响上面那条用例
  const manyDir = mkdtempSync(join(tmpdir(), 'vela-search-many-'))
  writeFileSync(
    join(manyDir, 'm.txt'),
    Array.from({ length: 60 }, () => 'needle').join('\n'),
  )
  const many = String(
    await createGrepTool(manyDir).execute({ pattern: 'needle' }),
  )
  rmSync(manyDir, { recursive: true, force: true })
  expect(many.split('\n').filter((l) => l.startsWith('m.txt:'))).toHaveLength(
    50,
  )
  expect(many).toContain('50+')
})

test('grep follows symlinked files and directories without looping', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vela-search-links-'))
  try {
    mkdirSync(join(root, 'real/sub'), { recursive: true })
    writeFileSync(join(root, 'real/f.ts'), 'needle linked file')
    writeFileSync(join(root, 'real/sub/g.ts'), 'needle linked dir')
    mkdirSync(join(root, 'work'))
    symlinkSync(join(root, 'real/f.ts'), join(root, 'work/f.ts'))
    symlinkSync(join(root, 'real/sub'), join(root, 'work/sub'))
    symlinkSync(join(root, 'work'), join(root, 'work/loop'))
    const output = String(
      await createGrepTool(join(root, 'work')).execute({ pattern: 'needle' }),
    )
    expect(output).toContain('f.ts:1: needle linked file')
    expect(output).toContain('sub/g.ts:1: needle linked dir')
    expect(output.split('\n')).toHaveLength(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
