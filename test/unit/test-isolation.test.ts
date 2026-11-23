import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
/** The agent-loop tests, which build tool registries whose default result store resolves `./sessions` under the cwd. */
const agentTests = join(root, 'packages/vela/test/unit/core/agent')

test('the agent unit tests write nothing into the working directory', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'vela-unit-cwd-'))
  try {
    const child = Bun.spawn([process.execPath, 'test', agentTests], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const code = await child.exited
    if (code !== 0)
      throw new Error(`bun test exited ${code}:\n${stderr || stdout}`)
    // An empty selection would leave the directory assertion below passing without running anything.
    const ran = Number(
      `${stdout}\n${stderr}`.match(/Ran (\d+) tests?/)?.[1] ?? 0,
    )
    expect(ran).toBeGreaterThan(0)
    // A result store without an explicit directory resolves `./sessions` under the working directory.
    expect(readdirSync(cwd)).toEqual([])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}, 30_000)
