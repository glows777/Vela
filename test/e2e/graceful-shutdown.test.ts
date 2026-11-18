import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
const children: ReturnType<typeof Bun.spawn>[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
    await child.exited
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
async function fixture(mode: string, existing?: string) {
  const cwd = existing ?? (await mkdtemp(join(tmpdir(), 'vela-graceful-')))
  if (!existing) roots.push(cwd)
  const child = Bun.spawn(
    [
      process.execPath,
      new URL('../fixtures/recovery/graceful.ts', import.meta.url).pathname,
      cwd,
      mode,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  children.push(child)
  return { cwd, child }
}
async function until(check: () => boolean, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for graceful fixture')
    await Bun.sleep(10)
  }
}
function read(cwd: string, name: string) {
  return JSON.parse(readFileSync(join(cwd, name), 'utf8'))
}

test('SIGTERM lets an in-flight tool settle durably, admits no new task, and restart continues without reexecution', async () => {
  const { cwd, child } = await fixture('settle')
  await until(() => existsSync(join(cwd, 'tool-started.json')))
  child.kill('SIGTERM')
  await Bun.sleep(300)
  writeFileSync(join(cwd, 'release'), '')
  await until(() => child.exitCode !== null)
  expect(child.exitCode).toBe(0)
  expect(existsSync(join(cwd, 'new-task-attempted.json'))).toBe(true)
  expect(existsSync(join(cwd, 'tool-finished.json'))).toBe(true)
  expect(existsSync(join(cwd, 'unexpected-model.json'))).toBe(false)
  expect(existsSync(join(cwd, 'forbidden.json'))).toBe(false)
  expect(read(cwd, 'model-calls.json')).toHaveLength(1)
  expect(JSON.stringify(read(cwd, 'events.json'))).not.toContain(
    'NEW TASK AFTER SIGTERM',
  )
  expect(
    JSON.stringify(read(cwd, '.vela-data/channels/index.json')),
  ).not.toContain('NEW TASK AFTER SIGTERM')
  const restarted = await fixture('resume', cwd)
  await until(() => restarted.child.exitCode !== null)
  expect(restarted.child.exitCode).toBe(0)
  expect(readFileSync(join(cwd, 'executions'), 'utf8')).toBe('executed\n')
  expect(JSON.stringify(read(cwd, 'recovered-request.json'))).toContain(
    'DURABLE TOOL RESULT',
  )
  expect(read(cwd, 'model-calls.json')).toHaveLength(1)
}, 40000)

test('SIGTERM reaches the real 30-second deadline then aborts an unsettled tool', async () => {
  const { cwd, child } = await fixture('deadline')
  await until(() => existsSync(join(cwd, 'tool-started.json')))
  const started = Date.now()
  child.kill('SIGTERM')
  await until(() => child.exitCode !== null, 38000)
  const elapsed = Date.now() - started
  expect(elapsed).toBeGreaterThanOrEqual(29000)
  expect(elapsed).toBeLessThan(37000)
  expect(existsSync(join(cwd, 'tool-finished.json'))).toBe(false)
  expect(existsSync(join(cwd, 'unexpected-model.json'))).toBe(false)
  expect(existsSync(join(cwd, 'forbidden.json'))).toBe(false)
  expect(readFileSync(join(cwd, 'serve.log'), 'utf8')).toContain(
    'Shutdown exceeded 30 seconds',
  )
  const restarted = await fixture('resume', cwd)
  await until(() => restarted.child.exitCode !== null)
  expect(restarted.child.exitCode).toBe(0)
  expect(readFileSync(join(cwd, 'executions'), 'utf8')).toBe('executed\n')
  expect(JSON.stringify(read(cwd, 'recovered-request.json'))).toContain(
    'interrupted',
  )
  expect(JSON.stringify(read(cwd, 'recovered-request.json'))).not.toContain(
    'DURABLE TOOL RESULT',
  )
}, 65000)

for (const mode of ['queued', 'stream']) {
  test(`SIGTERM prevents a ${mode === 'queued' ? 'queued sibling' : 'late streamed'} tool from executing and saves its closed result`, async () => {
    const { cwd, child } = await fixture(mode)
    await until(() =>
      existsSync(
        join(
          cwd,
          mode === 'stream' ? 'model-stream-started.json' : 'tool-started.json',
        ),
      ),
    )
    child.kill('SIGTERM')
    await Bun.sleep(300)
    writeFileSync(join(cwd, 'release'), '')
    await until(() => child.exitCode !== null)
    expect(child.exitCode).toBe(0)
    expect(existsSync(join(cwd, 'forbidden.json'))).toBe(false)
    expect(existsSync(join(cwd, 'unexpected-model.json'))).toBe(false)
    expect(read(cwd, 'model-calls.json')).toHaveLength(1)
    const restarted = await fixture('resume', cwd)
    await until(() => restarted.child.exitCode !== null)
    expect(restarted.child.exitCode).toBe(0)
    const request = JSON.stringify(read(cwd, 'recovered-request.json'))
    expect(request).toContain('graceful_forbidden')
    expect(request).toContain('not executed')
    expect(read(cwd, 'recovered-request.json').toolResults).toHaveLength(
      mode === 'queued' ? 2 : 1,
    )
    if (mode === 'queued') {
      expect(request).toContain('DURABLE TOOL RESULT')
      expect(readFileSync(join(cwd, 'executions'), 'utf8')).toBe('executed\n')
    } else expect(existsSync(join(cwd, 'executions'))).toBe(false)
  }, 40000)
}
