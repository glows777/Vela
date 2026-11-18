import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
const children: ReturnType<typeof Bun.spawn>[] = []
const read = (cwd: string, file: string) =>
  JSON.parse(readFileSync(join(cwd, file), 'utf8'))
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
    await child.exited
  }
  for (const cwd of roots.splice(0)) {
    for (const pidFile of ['shell.pid', 'shell-second.pid']) {
      if (existsSync(join(cwd, pidFile))) {
        const pid = Number(readFileSync(join(cwd, pidFile), 'utf8').trim())
        // Local execution creates a process group. Kill the shell and its sleeping descendants.
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {}
        }
      }
    }
    await rm(cwd, { recursive: true, force: true })
  }
})
async function until(
  check: () => boolean,
  child: ReturnType<typeof Bun.spawn>,
) {
  const deadline = Date.now() + 15000
  while (!check()) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(
        `Fixture stopped/timed out: ${await new Response(child.stderr instanceof ReadableStream ? child.stderr : undefined).text()}`,
      )
    }
    await Bun.sleep(10)
  }
}
async function fixture(mode: string, scope = 'topic', existing?: string) {
  const cwd = existing ?? (await mkdtemp(join(tmpdir(), 'vela-background-')))
  if (!existing) roots.push(cwd)
  const child = Bun.spawn(
    [
      process.execPath,
      new URL('../fixtures/recovery/background.ts', import.meta.url).pathname,
      cwd,
      mode,
      scope,
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  )
  children.push(child)
  return { cwd, child }
}
async function restart(cwd: string, scope: string, calls: number) {
  const run = await fixture('restart', scope, cwd)
  await until(() => run.child.exitCode !== null, run.child)
  expect(run.child.exitCode).toBe(0)
  expect(read(cwd, 'calls.json')).toHaveLength(calls)
  expect(
    read(cwd, '.vela-data/channels/index.json').records.every(
      (record: { outstandingJobs?: unknown[] }) =>
        !record.outstandingJobs?.length,
    ),
  ).toBe(true)
  if (calls) {
    expect(read(cwd, 'recovery-request.json').system).toBe(
      read(cwd, 'initial-system.json'),
    )
    expect(JSON.stringify(read(cwd, 'recovery-request.json'))).toMatch(
      /unknown|interrupted/i,
    )
    expect(JSON.stringify(read(cwd, 'sent.json'))).toContain('RESTART NOTICE')
    expect(JSON.stringify(read(cwd, 'sent.json'))).not.toContain(
      'INITIAL ANSWER',
    )
  }
}
for (const scope of ['topic', 'hub'])
  for (const signal of ['SIGKILL', 'SIGTERM'] as const) {
    test(`idle ${scope} background job proactively reports unknown once after ${signal}`, async () => {
      const { cwd, child } = await fixture('waiting', scope)
      await until(() => existsSync(join(cwd, 'ready.json')), child)
      expect(
        read(cwd, '.vela-data/channels/index.json').records[0].outstandingJobs,
      ).toHaveLength(1)
      child.kill(signal)
      await child.exited
      await restart(cwd, scope, 1)
      await restart(cwd, scope, 0)
    }, 45000)
  }
for (const mode of ['normal', 'stopped'])
  test(`${mode} background job has no restart notice`, async () => {
    const { cwd, child } = await fixture(mode)
    await until(() => existsSync(join(cwd, 'ready.json')), child)
    child.kill('SIGKILL')
    await child.exited
    await restart(cwd, 'topic', 0)
  }, 30000)
test('normal result lost before input save is rebuilt as unknown, not the old answer', async () => {
  const { cwd, child } = await fixture('before-save')
  await until(() => existsSync(join(cwd, 'save-gate.json')), child)
  child.kill('SIGKILL')
  await child.exited
  await restart(cwd, 'topic', 1)
  await restart(cwd, 'topic', 0)
  const entries = readFileSync(
    join(cwd, '.vela-data/sessions/lark-oc_group-root/transcript.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(
    entries.filter(
      (entry) =>
        entry.type === 'custom' &&
        entry.customType === 'channel.input' &&
        entry.data?.backgroundJobToken,
    ),
  ).toHaveLength(1)
}, 45000)
test('saved notification input survives another kill before directory acknowledgement', async () => {
  const { cwd, child } = await fixture('waiting')
  await until(() => existsSync(join(cwd, 'ready.json')), child)
  child.kill('SIGKILL')
  await child.exited
  const recovering = await fixture('restart-after-save', 'topic', cwd)
  await until(() => existsSync(join(cwd, 'save-gate.json')), recovering.child)
  expect(
    read(cwd, '.vela-data/channels/index.json').records[0].outstandingJobs,
  ).toHaveLength(1)
  recovering.child.kill('SIGKILL')
  await recovering.child.exited
  await restart(cwd, 'topic', 1)
  await restart(cwd, 'topic', 0)
  const entries = readFileSync(
    join(cwd, '.vela-data/sessions/lark-oc_group-root/transcript.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(
    entries.filter(
      (entry) =>
        entry.type === 'custom' &&
        entry.customType === 'channel.input' &&
        entry.data?.backgroundJobToken,
    ),
  ).toHaveLength(1)
}, 45000)

test('two outstanding jobs each produce one durable notice without clearing the other', async () => {
  const { cwd, child } = await fixture('multiple')
  await until(() => existsSync(join(cwd, 'ready.json')), child)
  const jobs = read(cwd, '.vela-data/channels/index.json').records[0]
    .outstandingJobs
  expect(jobs).toHaveLength(2)
  expect(new Set(jobs.map((job: { token: string }) => job.token)).size).toBe(2)
  child.kill('SIGKILL')
  await child.exited
  await restart(cwd, 'topic', 2)
  expect(read(cwd, 'second-recovery-request.json').system).toBe(
    read(cwd, 'initial-system.json'),
  )
  expect(
    read(cwd, 'sent.json').filter((message: { text: string }) =>
      message.text.includes('RESTART NOTICE'),
    ),
  ).toHaveLength(2)
  await restart(cwd, 'topic', 0)
  const entries = readFileSync(
    join(cwd, '.vela-data/sessions/lark-oc_group-root/transcript.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const tokens = entries
    .filter(
      (entry) =>
        entry.type === 'custom' &&
        entry.customType === 'channel.input' &&
        entry.data?.backgroundJobToken,
    )
    .map((entry) => entry.data.backgroundJobToken)
  expect(tokens.sort()).toEqual(
    jobs.map((job: { token: string }) => job.token).sort(),
  )
}, 45000)

test('unknown notice accepted before SIGKILL reuses its final UUID without another job input', async () => {
  const { cwd, child } = await fixture('waiting')
  await until(() => existsSync(join(cwd, 'ready.json')), child)
  child.kill('SIGKILL')
  await child.exited
  const interrupted = await fixture('restart-accepted', 'topic', cwd)
  await until(
    () => existsSync(join(cwd, 'notice-accepted.json')),
    interrupted.child,
  )
  const accepted = read(cwd, 'notice-ledger.json')
  expect(accepted.attempts).toHaveLength(1)
  expect(accepted.attempts[0].uuid).toBeString()
  expect(accepted.attempts[0].text).toContain('RESTART NOTICE')
  interrupted.child.kill('SIGKILL')
  await interrupted.child.exited
  const resumed = await fixture('restart-ledger', 'topic', cwd)
  await until(() => resumed.child.exitCode !== null, resumed.child)
  expect(resumed.child.exitCode).toBe(0)
  expect(read(cwd, 'calls.json')).toHaveLength(0)
  const ledger = read(cwd, 'notice-ledger.json')
  expect(ledger.attempts).toHaveLength(2)
  expect(ledger.attempts[1].uuid).toBe(accepted.attempts[0].uuid)
  expect(ledger.deliveries).toHaveLength(1)
  expect(JSON.stringify(ledger)).not.toContain('INITIAL ANSWER')
  expect(read(cwd, '.vela-data/channels/index.json').records[0].state).toBe(
    'done',
  )
  expect(
    read(cwd, '.vela-data/channels/index.json').records[0].outstandingJobs ??
      [],
  ).toHaveLength(0)
  const entries = readFileSync(
    join(cwd, '.vela-data/sessions/lark-oc_group-root/transcript.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(
    entries.filter(
      (entry) =>
        entry.type === 'custom' &&
        entry.customType === 'channel.input' &&
        entry.data?.backgroundJobToken,
    ),
  ).toHaveLength(1)
  const intents = entries.filter(
    (entry) =>
      entry.type === 'custom' &&
      entry.customType === 'channel.lark_delivery' &&
      entry.data?.uuid === accepted.attempts[0].uuid,
  )
  expect(intents.some((entry) => entry.data.confirmed === true)).toBe(true)
  const again = await fixture('restart-ledger', 'topic', cwd)
  await until(() => again.child.exitCode !== null, again.child)
  expect(again.child.exitCode).toBe(0)
  expect(read(cwd, 'calls.json')).toHaveLength(0)
  expect(read(cwd, 'sent.json')).toHaveLength(0)
  expect(read(cwd, 'notice-ledger.json')).toEqual(ledger)
}, 45000)

test('restart of an unsaved background result preserves the topic waiting decision', async () => {
  const { cwd, child } = await fixture('waiting-before-save')
  await until(() => existsSync(join(cwd, 'save-gate.json')), child)
  const pending = read(cwd, '.vela-data/channels/index.json').records[0]
  expect(pending.state).toBe('running')
  expect(pending.waitingReason).toBe('Choose the deployment target')
  expect(pending.outstandingJobs).toHaveLength(1)
  child.kill('SIGKILL')
  await child.exited
  await restart(cwd, 'topic', 1)
  for (let i = 0; i < 2; i++) {
    const record = read(cwd, '.vela-data/channels/index.json').records[0]
    expect(record.state).toBe('waiting')
    expect(record.waitingReason).toBe('Choose the deployment target')
    if (!i) await restart(cwd, 'topic', 0)
  }
}, 45000)
