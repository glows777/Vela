import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { tempDir } from '../support/vela.ts'

// The docs point readers at these examples: run each one as a reader would (offline, faux or demo model)
const ROOT = resolve(import.meta.dir, '../..')

// Each test spawns a process and they run concurrently
setDefaultTimeout(30_000)

const dirs: { cleanup(): void }[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

async function run(args: string[]) {
  const home = tempDir('vela-example-')
  dirs.push(home)
  const proc = Bun.spawn(['bun', ...args], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home.path,
      VELA_DIR: home.path,
      VELA_MODEL: 'mock',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

const sdkExamples: [file: string, expected: string][] = [
  ['01-minimal.ts', 'messages: 2'],
  ['02-events.ts', '[agent_settled]'],
  ['03-multi-session.ts', 'bob: role=guest'],
  ['04-custom-storage.ts', 'answer: You are Ada.'],
]

for (const [file, expected] of sdkExamples)
  test.concurrent(`examples/sdk/${file} runs`, async () => {
    const { stdout, stderr, code } = await run([join('examples/sdk', file)])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(stdout).toContain(expected)
  })

test.concurrent('examples/rpc-client.ts drives vela --mode rpc to agent_settled', async () => {
  const { stdout, stderr, code } = await run([
    'examples/rpc-client.ts',
    'list files',
  ])
  expect(stderr).not.toContain('failed]')
  expect(code).toBe(0)
  // The demo model lists the folder: the client printed the tool call and the result
  expect(stdout).toContain('[tool] list_directory')
})
