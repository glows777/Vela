import { expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function until(check: () => boolean) {
  const deadline = Date.now() + 15000
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for preparation fixture')
    await Bun.sleep(10)
  }
}

test('SIGTERM during admitted session preparation starts no model and preserves pending input', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'vela-graceful-preparation-'))
  const child = Bun.spawn(
    [
      process.execPath,
      new URL('../fixtures/recovery/graceful-preparation.ts', import.meta.url)
        .pathname,
      cwd,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const stderr = new Response(child.stderr).text()
  try {
    await until(() => existsSync(join(cwd, 'preparation-started.json')))
    child.kill('SIGTERM')
    await Bun.sleep(300)
    writeFileSync(join(cwd, 'release'), '')
    await until(() => child.exitCode !== null)
    expect(child.exitCode, await stderr).toBe(0)
    expect(existsSync(join(cwd, 'forbidden-model.json'))).toBe(false)
    expect(
      JSON.parse(readFileSync(join(cwd, 'model-calls.json'), 'utf8')),
    ).toHaveLength(0)
    const directory = readFileSync(
      join(cwd, '.vela-data/channels/index.json'),
      'utf8',
    )
    const records = JSON.parse(directory).records as {
      pendingMessageIds: unknown[]
    }[]
    expect(records.flatMap((record) => record.pendingMessageIds)).toContain(
      'held-preparation',
    )
  } finally {
    child.kill('SIGKILL')
    await child.exited
    await rm(cwd, { recursive: true, force: true })
  }
}, 25000)
