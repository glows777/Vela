import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../../../../../test/support/vela.ts'
import { environment, type PromptContext } from '../../../src/prompt/index.ts'
import { gitBranch } from '../../../src/session/git-branch.ts'

const context: PromptContext = {
  deferredToolSummary: '',
  sessionId: 's',
}

test('the env block renders the injected date, timezone, OS and shell', () => {
  expect(
    environment({
      cwd: '/repo',
      date: '2026-01-02',
      timezone: 'Asia/Shanghai',
      os: 'linux',
      shell: '/usr/local/bin/bash',
    })(context),
  ).toBe(
    'date: 2026-01-02\ntimezone: Asia/Shanghai\nos: linux\nshell: /usr/local/bin/bash',
  )
})

test('the env block carries no git branch, so a checkout in the working tree cannot rewrite the prompt', () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir.path, '.git'), { recursive: true })
    writeFileSync(join(dir.path, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    expect(environment({ cwd: dir.path })(context)).not.toContain('git branch')
  } finally {
    dir.cleanup()
  }
})

test('gitBranch reads .git/HEAD, follows a worktree pointer, and is null without git', () => {
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
    expect(gitBranch(repo)).toBe('vela/175-prompt-rules-env')
    // A session opened in a subdirectory still belongs to the checkout above it
    const sub = join(repo, 'src', 'nested')
    mkdirSync(sub, { recursive: true })
    expect(gitBranch(sub)).toBe('vela/175-prompt-rules-env')
    expect(gitBranch(worktree)).toBe('wt')
    expect(gitBranch(plain)).toBeNull()
    // A detached HEAD is identified by its short hash
    writeFileSync(
      join(repo, '.git', 'HEAD'),
      '0123456789abcdef0123456789abcdef01234567\n',
    )
    expect(gitBranch(repo)).toBe('0123456')
  } finally {
    dir.cleanup()
  }
})
