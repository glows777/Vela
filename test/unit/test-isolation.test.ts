import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
/** The package unit suites, where tests construct tool registries and result stores directly. */
const unitDirs = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(root, 'packages', entry.name, 'test', 'unit'))
  .filter((dir) => existsSync(dir))

test('the package unit suites write nothing into the working directory', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'vela-unit-cwd-'))
  try {
    const child = Bun.spawn([process.execPath, 'test', ...unitDirs], {
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
}, 120_000)
