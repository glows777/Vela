import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../../../../../test/support/vela.ts'
import { environment, type PromptContext } from '../../../src/prompt/index.ts'

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

test('the env block carries no git branch, so a checkout cannot rewrite the prompt', () => {
  const dir = tempDir()
  try {
    // A checkout in the session's working tree is invisible to the system prompt
    mkdirSync(join(dir.path, '.git'), { recursive: true })
    writeFileSync(join(dir.path, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    expect(environment({ cwd: dir.path })(context)).not.toContain('git branch')
  } finally {
    dir.cleanup()
  }
})
