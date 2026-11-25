import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'

const roots: string[] = []
const fixture = new URL(
  '../fixtures/recovery/lark-delivery.ts',
  import.meta.url,
).pathname
const children: ReturnType<typeof Bun.spawn>[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
    await child.exited
  }
  for (const cwd of roots.splice(0))
    rmSync(cwd, { recursive: true, force: true })
})
function read(cwd: string, path: string) {
  return JSON.parse(readFileSync(join(cwd, path), 'utf8'))
}
function activeSessionId(cwd: string): string {
  return read(cwd, '.vela-data/channels/index.json').records[0].activeSessionId
}
function readIntents(cwd: string) {
  const db = openDatabase({
    path: join(cwd, '.vela-data/vela.db'),
    readonly: true,
  })
  try {
    return db
      .all<{ content_json: string }>(
        "SELECT content_json FROM vela_messages WHERE session_id = ? AND kind = 'custom' AND content_json LIKE '%channel.lark_delivery%' ORDER BY seq",
        activeSessionId(cwd),
      )
      .map(
        (row) =>
          JSON.parse(row.content_json) as { data: Record<string, unknown> },
      )
  } finally {
    db.close()
  }
}
function patchIntents(cwd: string, patch: Record<string, unknown>) {
  const db = openDatabase({ path: join(cwd, '.vela-data/vela.db') })
  try {
    const rows = db.all<{ id: string; content_json: string }>(
      "SELECT id, content_json FROM vela_messages WHERE session_id = ? AND kind = 'custom' AND content_json LIKE '%channel.lark_delivery%'",
      activeSessionId(cwd),
    )
    for (const row of rows) {
      const parsed = JSON.parse(row.content_json) as {
        data: Record<string, unknown>
      }
      Object.assign(parsed.data, patch)
      db.run(
        'UPDATE vela_messages SET content_json = ? WHERE id = ?',
        JSON.stringify(parsed),
        row.id,
      )
    }
  } finally {
    db.close()
  }
}
function readSessionDump(cwd: string): string {
  const db = openDatabase({
    path: join(cwd, '.vela-data/vela.db'),
    readonly: true,
  })
  try {
    return JSON.stringify(
      db.all<{ content_json: string }>(
        'SELECT content_json FROM vela_messages WHERE session_id = ? ORDER BY seq',
        activeSessionId(cwd),
      ),
    )
  } finally {
    db.close()
  }
}
async function run(cwd: string, mode: string, kill = false) {
  const child = Bun.spawn([process.execPath, fixture, cwd, mode], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  children.push(child)
  const errors = new Response(child.stderr).text()
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
  try {
    if (kill) {
      while (!existsSync(join(cwd, 'kill-ready'))) {
        if (child.exitCode !== null)
          throw new Error(`Crash fixture exited: ${await errors}`)
        await Bun.sleep(10)
      }
      child.kill('SIGKILL')
      await child.exited
      rmSync(join(cwd, 'kill-ready'))
    } else expect(await child.exited, await errors).toBe(0)
  } finally {
    clearTimeout(timer)
  }
}
function root() {
  const cwd = mkdtempSync(join(tmpdir(), 'vela-lark-delivery-'))
  roots.push(cwd)
  return cwd
}
function finalAttempts(cwd: string) {
  return (
    read(cwd, 'remote-ledger.json').attempts as {
      uuid?: string
      text: string
    }[]
  ).filter((item) => item.text.includes('FINAL ANSWER'))
}
function finalDeliveries(cwd: string) {
  return (
    read(cwd, 'remote-ledger.json').deliveries as {
      uuid?: string
      text: string
    }[]
  ).filter((item) => item.text.includes('FINAL ANSWER'))
}

for (const route of ['topic', 'direct'])
  for (const mode of ['accepted', 'confirmed'])
    test(`Lark ${route} ${mode} send survives real SIGKILL without duplicate final delivery or a model rerun`, async () => {
      const cwd = root()
      await run(cwd, `${route === 'direct' ? 'dm-' : ''}${mode}`, true)
      const first = finalAttempts(cwd)[0]!
      expect(first.uuid).toBeTruthy()
      expect(readFileSync(join(cwd, 'methods.txt'), 'utf8').trim()).toBe(
        route === 'direct' ? 'create' : 'reply',
      )
      const savedIntents = readIntents(cwd)
      expect(savedIntents[0]!.data.uuid).toBe(first.uuid)
      expect(savedIntents.at(-1)!.data.confirmed === true).toBe(
        mode === 'confirmed',
      )
      await run(cwd, 'restart')
      expect(finalDeliveries(cwd)).toHaveLength(1)
      expect(JSON.stringify(read(cwd, 'remote-ledger.json'))).not.toContain(
        'PRIVATE THOUGHT',
      )
      expect(finalAttempts(cwd)).toHaveLength(mode === 'accepted' ? 2 : 1)
      expect(finalAttempts(cwd).every((item) => item.uuid === first.uuid)).toBe(
        true,
      )
      expect(read(cwd, 'recovery.json').calls).toBe(0)
      expect(read(cwd, '.vela-data/channels/index.json').records[0].state).toBe(
        'done',
      )
      const count = finalAttempts(cwd).length
      await run(cwd, 'restart')
      expect(finalAttempts(cwd)).toHaveLength(count)
      expect(finalDeliveries(cwd)).toHaveLength(1)
      expect(JSON.stringify(read(cwd, 'remote-ledger.json'))).not.toContain(
        'PRIVATE THOUGHT',
      )
    }, 35000)

test('an unconfirmed Lark intent older than one hour is unknown and never resent with a fresh UUID', async () => {
  const cwd = root()
  await run(cwd, 'accepted', true)
  // Age only the persisted local intent: this checks the local guard, not Lark server TTL behavior.
  patchIntents(cwd, { startedAt: Date.now() - 3600001 })
  await run(cwd, 'expired')
  expect(finalAttempts(cwd)).toHaveLength(1)
  expect(finalDeliveries(cwd)).toHaveLength(1)
  expect(read(cwd, 'remote-ledger.json').attempts).toHaveLength(1)
  expect(read(cwd, '.vela-data/channels/index.json').records[0].state).toBe(
    'done',
  )
  expect(JSON.stringify(read(cwd, 'remote-ledger.json'))).not.toContain(
    'PRIVATE THOUGHT',
  )
  expect(read(cwd, 'recovery.json').calls).toBe(0)
  expect(JSON.stringify(read(cwd, 'recovery.json').logs)).toContain(
    'window expired',
  )
  await run(cwd, 'expired')
  expect(finalAttempts(cwd)).toHaveLength(1)
  expect(read(cwd, 'remote-ledger.json').attempts).toHaveLength(1)
  expect(read(cwd, '.vela-data/channels/index.json').records[0].state).not.toBe(
    'running',
  )
}, 35000)

test('a channel_start_topic title send persists the tool identity and is not replayed after SIGKILL', async () => {
  const cwd = root()
  await run(cwd, 'tool', true)
  const title = read(cwd, 'remote-ledger.json').attempts[0]
  expect(title.text).toBe('TOPIC TITLE')
  expect(title.uuid).toBeTruthy()
  const saved = readSessionDump(cwd)
  expect(saved).toContain('tool:faux-call-2-1:start_topic')
  expect(saved).toContain(title.uuid)
  expect(saved).toContain('FINISHED EARLIER STEP')
  await run(cwd, 'tool-restart')
  const titles = read(cwd, 'remote-ledger.json').attempts.filter(
    (item: { text: string }) => item.text === 'TOPIC TITLE',
  )
  expect(titles).toHaveLength(1)
  const request = readFileSync(join(cwd, 'tool-recovered-request.json'), 'utf8')
  expect(request).toContain('FINISHED EARLIER STEP')
  expect(request).toContain('may have partially run')
  expect(read(cwd, 'recovery.json').calls).toBe(1)
  await run(cwd, 'restart')
  expect(
    read(cwd, 'remote-ledger.json').attempts.filter(
      (item: { text: string }) => item.text === 'TOPIC TITLE',
    ),
  ).toHaveLength(1)
}, 35000)

for (const mode of ['before-send', 'accepted', 'confirmed'])
  test(`Lark ${mode} recovery preserves Bob as recipient in Alice's topic`, async () => {
    const cwd = root()
    await run(cwd, `multi-${mode}`, true)
    expect(
      read(cwd, '.vela-data/channels/index.json').records[0].requester.id,
    ).toBe('ou_alice')
    const intents = readIntents(cwd)
    const uuid = intents.at(-1)!.data.uuid
    expect(uuid).toBeTruthy()
    expect(finalAttempts(cwd)).toHaveLength(mode === 'before-send' ? 0 : 1)
    await run(cwd, 'restart')
    expect(finalAttempts(cwd)).toHaveLength(mode === 'accepted' ? 2 : 1)
    expect(finalAttempts(cwd).every((attempt) => attempt.uuid === uuid)).toBe(
      true,
    )
    expect(finalDeliveries(cwd)).toHaveLength(1)
    expect(finalDeliveries(cwd)[0]!.text).toBe(
      '<at user_id="ou_bob"></at> FINAL ANSWER',
    )
    expect(
      read(cwd, '.vela-data/channels/index.json').records[0],
    ).toMatchObject({ state: 'done', requester: { id: 'ou_alice' } })
    expect(read(cwd, 'recovery.json').calls).toBe(0)
    const count = finalAttempts(cwd).length
    await run(cwd, 'restart')
    expect(finalAttempts(cwd)).toHaveLength(count)
  }, 35000)

for (const [name, patch, diagnostic, mode] of [
  [
    'clock moved backward',
    { startedAt: Date.now() + 3600000 },
    'window expired',
    'accepted',
  ],
  [
    'confirmed fingerprint conflict',
    { fingerprint: 'conflicting-payload' },
    'identity does not match',
    'confirmed',
  ],
  [
    'UUID conflict',
    { uuid: 'conflicting-uuid' },
    'identity does not match',
    'accepted',
  ],
  [
    'invalid timestamp',
    { startedAt: null },
    'identity does not match',
    'accepted',
  ],
  [
    'invalid confirmation',
    { confirmed: 'yes' },
    'identity does not match',
    'accepted',
  ],
  [
    'invalid recipient',
    { payload: { recipientId: 42 } },
    'invalid saved recipient',
    'accepted',
  ],
] as const)
  test(`Lark recovery settles ${name} without any chat notice on either restart`, async () => {
    const cwd = root()
    await run(cwd, mode, true)
    patchIntents(cwd, patch)
    const ledger = read(cwd, 'remote-ledger.json')
    await run(cwd, 'restart')
    expect(read(cwd, 'remote-ledger.json')).toEqual(ledger)
    expect(read(cwd, '.vela-data/channels/index.json').records[0].state).toBe(
      'done',
    )
    expect(read(cwd, 'recovery.json').calls).toBe(0)
    expect(read(cwd, 'recovery.json').logs.join('\n')).toContain(diagnostic)
    await run(cwd, 'restart')
    expect(read(cwd, 'remote-ledger.json')).toEqual(ledger)
    expect(read(cwd, '.vela-data/channels/index.json').records[0].state).toBe(
      'done',
    )
    expect(read(cwd, 'recovery.json').calls).toBe(0)
  }, 35000)

for (const mode of ['transient', 'transient-save'])
  test(`a ${mode} Lark recovery failure remains retryable with the original UUID`, async () => {
    const cwd = root()
    await run(cwd, 'accepted', true)
    const uuid = finalAttempts(cwd)[0]!.uuid
    await run(cwd, mode)
    expect(read(cwd, '.vela-data/channels/index.json').records[0].state).toBe(
      'running',
    )
    expect(read(cwd, 'recovery.json').calls).toBe(0)
    await run(cwd, 'restart')
    expect(read(cwd, '.vela-data/channels/index.json').records[0].state).toBe(
      'done',
    )
    expect(read(cwd, 'recovery.json').calls).toBe(0)
    expect(finalAttempts(cwd)).toHaveLength(mode === 'transient' ? 3 : 2)
    expect(finalAttempts(cwd).every((attempt) => attempt.uuid === uuid)).toBe(
      true,
    )
    expect(finalDeliveries(cwd)).toHaveLength(1)
  }, 35000)
