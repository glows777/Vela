import { afterEach, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import {
  cleanupTestVelas,
  createTestVela,
  tempDir,
} from '../../../src/testing/test-vela.ts'

afterEach(cleanupTestVelas)

test('temporary directories agree with the working directory seen by child processes', async () => {
  const dir = tempDir()
  try {
    const child = Bun.spawn(
      ['bun', '-e', 'process.stdout.write(process.cwd())'],
      {
        cwd: dir.path,
        stdout: 'pipe',
      },
    )
    expect(await new Response(child.stdout).text()).toBe(dir.path)
    expect(await child.exited).toBe(0)
  } finally {
    dir.cleanup()
  }
})

test('a test Vela uses the canonical path for its generated working directory', () => {
  const t = createTestVela()
  expect(t.cwd).toBe(realpathSync(t.cwd))
})
