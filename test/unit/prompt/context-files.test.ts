import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  loadContextFiles,
  renderContextFiles,
} from '../../../src/prompt/context-files.ts'
import { tempDir } from '../../support/vela.ts'

const dirs: { cleanup(): void }[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

function setup(files: Record<string, string>): string {
  const dir = tempDir()
  dirs.push(dir)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir.path, path)), { recursive: true })
    writeFileSync(join(dir.path, path), content)
  }
  return dir.path
}

test('user file first, then ancestors from the root down to cwd; one file per directory in pi order', () => {
  const root = setup({
    'home/AGENTS.md': 'user',
    'repo/CLAUDE.md': 'repo claude',
    'repo/AGENTS.md': 'repo agents',
    'repo/pkg/CLAUDE.md': 'pkg',
    'repo/pkg/src/AGENTS.override.md': 'override',
    'repo/pkg/src/AGENTS.md': 'ignored',
  })
  const files = loadContextFiles({
    cwd: join(root, 'repo/pkg/src'),
    agentDir: join(root, 'home'),
  })
  expect(files.map((f) => f.content)).toEqual([
    'user',
    'repo agents',
    'pkg',
    'override',
  ])
  expect(files[1]!.path).toBe(join(root, 'repo/AGENTS.md'))
})

test('without agentDir only ancestors load; a user dir that is also an ancestor is not loaded twice', () => {
  const root = setup({ 'AGENTS.md': 'top', 'a/AGENTS.md': 'a' })
  expect(
    loadContextFiles({ cwd: join(root, 'a') })
      .map((f) => f.content)
      .slice(-2),
  ).toEqual(['top', 'a'])
  expect(
    loadContextFiles({ cwd: join(root, 'a'), agentDir: join(root, 'a') })
      .map((f) => f.content)
      .slice(-2),
  ).toEqual(['a', 'top'])
})

test("a nested linked worktree's own file shadows the main repository's", () => {
  const root = setup({
    'main/.git/HEAD': 'ref: refs/heads/main',
    'main/AGENTS.md': 'main',
    'main/.git/worktrees/wt/commondir': '../..',
    'main/.git/worktrees/wt/HEAD': 'ref: refs/heads/wt',
    'main/wt/AGENTS.md': 'worktree',
  })
  writeFileSync(
    join(root, 'main/wt/.git'),
    `gitdir: ${join(root, 'main/.git/worktrees/wt')}\n`,
  )
  const contents = loadContextFiles({ cwd: join(root, 'main/wt') }).map(
    (f) => f.content,
  )
  expect(contents).toContain('worktree')
  expect(contents).not.toContain('main')
  // In the main checkout itself nothing is shadowed
  expect(
    loadContextFiles({ cwd: join(root, 'main') }).map((f) => f.content),
  ).toContain('main')
})

test('rendered like pi as <project_context>', () => {
  expect(renderContextFiles([])).toBeNull()
  expect(
    renderContextFiles([{ path: '/r/AGENTS.md', content: 'Use bun' }]),
  ).toBe(
    '<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/r/AGENTS.md">\nUse bun\n</project_instructions>\n</project_context>',
  )
})
