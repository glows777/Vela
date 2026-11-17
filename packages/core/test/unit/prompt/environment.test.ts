import { expect, test } from 'bun:test'
import { environment, type PromptContext } from '../../../src/prompt/index.ts'

const context: PromptContext = {
  deferredToolSummary: '',
  sessionId: 's',
}

test('the env block renders the OS and the shell, and no date, timezone or git branch', () => {
  expect(
    environment({
      os: 'linux',
      shell: '/usr/local/bin/bash',
    })(context),
  ).toBe('os: linux\nshell: /usr/local/bin/bash')
})
