import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkExecutionBoundaries } from '../../scripts/check-execution-boundaries.ts'

test('quality reports host dependencies in workspace prompt, skill and background code', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vela-boundary-'))
  const sources = {
    'vela/src/driver/prompt/environment-context-files.ts':
      "import 'node:fs/promises'",
    'vela/src/driver/skills/environment-skills.ts': "await import('fs')",
    'vela/src/driver/extensions/background/jobs.ts': "require('child_process')",
  }
  try {
    for (const [file, content] of Object.entries(sources)) {
      const path = join(root, 'packages', file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
    expect(
      (await checkExecutionBoundaries(root))
        .map((line) => line.split(':')[0])
        .sort(),
    ).toEqual(
      Object.keys(sources)
        .map((file) => `packages/${file}`)
        .sort(),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
