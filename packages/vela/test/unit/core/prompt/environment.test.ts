import { expect, test } from 'bun:test'
import {
  environment,
  type PromptContext,
} from '../../../../src/driver/prompt/index.ts'

const context: PromptContext = {
  deferredToolSummary: '',
  sessionId: 's',
}

test('the env block renders the OS, shell and day-level date, and no timezone or git branch', () => {
  expect(
    environment({
      os: 'linux',
      shell: '/usr/local/bin/bash',
      date: '2026-11-25',
    })(context),
  ).toBe('os: linux\nshell: /usr/local/bin/bash\nCurrent date: 2026-11-25')

  const rendered = environment({
    os: 'linux',
    shell: 'bash',
  })(context)
  expect(rendered).toMatch(
    /^os: linux\nshell: bash\nCurrent date: \d{4}-\d{2}-\d{2}$/,
  )
})
