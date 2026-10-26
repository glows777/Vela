import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { environment, type PromptContext } from '../../../src/prompt/index.ts'
import { tempDir } from '../../support/vela.ts'

const context: PromptContext = {
  toolCount: 1,
  deferredToolSummary: '',
  sessionMessageCount: 0,
  sessionId: 's',
}

test('the env block renders the injected date, timezone, OS, shell and git branch', () => {
  expect(
    environment({
      cwd: '/repo',
      date: '2026-01-02',
      timezone: 'Asia/Shanghai',
      os: 'linux',
      shell: '/usr/local/bin/bash',
      branch: 'main',
    })(context),
  ).toBe(
    '<env>\ndate: 2026-01-02\ntimezone: Asia/Shanghai\nos: linux\nshell: /usr/local/bin/bash\ngit branch: main\n</env>',
  )
})

test('the env block reads the branch from .git/HEAD, follows a worktree pointer, and omits it without git', () => {
  const dir = tempDir()
  try {
    const repo = join(dir.path, 'repo')
    const worktree = join(dir.path, 'worktree')
    const plain = join(dir.path, 'plain')
    for (const path of [repo, worktree, plain]) mkdirSync(path)
    mkdirSync(join(repo, '.git', 'worktrees', 'wt'), { recursive: true })
    writeFileSync(
      join(repo, '.git', 'HEAD'),
      'ref: refs/heads/vela/175-prompt-rules-env\n',
    )
    writeFileSync(
      join(repo, '.git', 'worktrees', 'wt', 'HEAD'),
      'ref: refs/heads/wt\n',
    )
    writeFileSync(
      join(worktree, '.git'),
      `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`,
    )
    const env = (cwd: string) => environment({ cwd })(context)!
    // The date defaults to today in the local calendar; the block never carries the time of day
    expect(env(repo)).toContain(
      `date: ${new Date().toLocaleDateString('en-CA')}`,
    )
    expect(env(repo)).toContain('timezone: ')
    expect(env(repo)).toContain('git branch: vela/175-prompt-rules-env')
    expect(env(worktree)).toContain('git branch: wt')
    expect(env(plain)).not.toContain('git branch:')
    // A detached HEAD is identified by its short hash
    writeFileSync(
      join(repo, '.git', 'HEAD'),
      '0123456789abcdef0123456789abcdef01234567\n',
    )
    expect(env(repo)).toContain('git branch: 0123456')
  } finally {
    dir.cleanup()
  }
})
