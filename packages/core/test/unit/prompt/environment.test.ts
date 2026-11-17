import { expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../../../../../test/support/vela.ts'
import type { ModelMessage } from '../../../src/messages.ts'
import { environment, type PromptContext } from '../../../src/prompt/index.ts'
import {
  EnvironmentChanges,
  reportedBranch,
} from '../../../src/session/environment-message.ts'
import { gitBranch } from '../../../src/session/git-branch.ts'
import { MessageQueue } from '../../../src/session/message-queue.ts'

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

const envMessage = (
  changes: EnvironmentChanges,
  cwd: string,
  history: ModelMessage[] = [],
) => {
  const message = changes.update(cwd, history)
  return message ? `${message.content}` : undefined
}

test('a branch is reported once, only when it differs from what the model was told', () => {
  const dir = tempDir()
  try {
    const changes = new EnvironmentChanges()
    checkout(dir.path, 'main')
    // The first turn tells the model nothing: there is no earlier value to correct
    expect(envMessage(changes, dir.path)).toBeUndefined()
    expect(envMessage(changes, dir.path)).toBeUndefined()
    checkout(dir.path, 'vela/442-prompt-cache')
    expect(envMessage(changes, dir.path)).toBe(
      'Git branch: vela/442-prompt-cache',
    )
    expect(envMessage(changes, dir.path)).toBeUndefined()
    // Leaving the checkout is a change too
    rmSync(join(dir.path, '.git'), { recursive: true, force: true })
    expect(envMessage(changes, dir.path)).toBe(
      'The working tree is no longer a git checkout.',
    )
  } finally {
    dir.cleanup()
  }
})

test('a restored history makes the next update report a branch checked out while the session was closed', () => {
  const dir = tempDir()
  try {
    checkout(dir.path, 'main')
    const queue = new MessageQueue(() => {})
    const announced: ModelMessage = {
      role: 'user',
      content: 'Git branch: topic',
    }
    queue.customMessages.set(announced, {
      customType: 'env',
      display: false,
      details: { branch: 'topic' },
    })
    const resumed = new EnvironmentChanges(queue)
    expect(envMessage(resumed, dir.path, [announced])).toBe('Git branch: main')
    // Still matching afterwards
    expect(envMessage(resumed, dir.path, [announced])).toBeUndefined()

    // A history that never reported a branch stays quiet until the branch moves
    const quiet = new EnvironmentChanges(queue)
    const plain: ModelMessage = { role: 'user', content: 'hello' }
    expect(envMessage(quiet, dir.path, [plain])).toBeUndefined()
    checkout(dir.path, 'vela/other')
    expect(envMessage(quiet, dir.path, [plain])).toBe('Git branch: vela/other')
  } finally {
    dir.cleanup()
  }
})

test('reportedBranch reads the branch a history entry carries and nothing else', () => {
  expect(reportedBranch({ branch: 'main' })).toBe('main')
  expect(reportedBranch({ branch: null })).toBeNull()
  expect(reportedBranch({})).toBeUndefined()
  expect(reportedBranch(undefined)).toBeUndefined()
  expect(reportedBranch('main')).toBeUndefined()
  expect(reportedBranch({ branch: 7 })).toBeUndefined()
})

/** Writes `.git/HEAD` the way a checkout does, without running git. */
function checkout(dir: string, branch: string) {
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`)
}
