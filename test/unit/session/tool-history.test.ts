import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ToolHistoryStore,
  type ResultRecord,
} from '../../../src/session/tool-history.ts'
import { SessionStore } from '../../../src/session/index.ts'

const root = mkdtempSync(join(tmpdir(), 'vela-history-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test('parallel calls append in order, preserve full arguments and link out-of-order results', async () => {
  const store = new ToolHistoryStore(join(root, 'parallel.jsonl'))
  const input = { text: '汉😀'.repeat(10000) }
  const calls = await Promise.all(
    Array.from({ length: 8 }, (_, n) =>
      store.begin('tool', `sdk-${n}`, { ...input, n }),
    ),
  )
  for (const call of calls.toReversed())
    await store.append<ResultRecord>({
      type: 'tool_result',
      callId: call.callId,
      status: 'completed',
      durationMs: 1,
      output: call.input,
    })
  const records = (await Bun.file(store.path).text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(records.map((record) => record.seq)).toEqual(
    Array.from({ length: 16 }, (_, n) => n + 1),
  )
  expect(records[0].input.text).toBe(input.text)
  const restored = new ToolHistoryStore(store.path)
  expect((await restored.completed('sdk-0'))?.output).toEqual({
    ...input,
    n: 0,
  })
})

test('repeated SDK ids get distinct execution ids; unfinished calls stay unconfirmed after restart', async () => {
  const store = new ToolHistoryStore(join(root, 'unfinished.jsonl'))
  const a = await store.begin('bash', 'same', { command: 'first' })
  const b = await store.begin('bash', 'same', { command: 'second' })
  expect(a.callId).not.toBe(b.callId)
  const restored = new ToolHistoryStore(store.path)
  await restored.load()
  expect(await restored.completed('same')).toBeUndefined()
  expect(restored.throughSequence).toBe(2)
})

test('a write failure blocks subsequent calls, and torn history is not overwritten', async () => {
  const blocked = join(root, 'blocked')
  await Bun.write(blocked, 'occupied')
  const store = new ToolHistoryStore(join(blocked, 'history.jsonl'))
  await expect(store.begin('bash', 'a', {})).rejects.toThrow(
    'Failed to save tool call record',
  )
  expect(() => store.assertHealthy()).toThrow()
  const torn = join(root, 'torn.jsonl')
  await Bun.write(torn, '{"version":1')
  await expect(
    new ToolHistoryStore(torn).begin('bash', 'a', {}),
  ).rejects.toThrow()
  expect(await Bun.file(torn).text()).toBe('{"version":1')
})

test('a frozen history file cannot expose later entries even when the reader omits the seq filter', async () => {
  const session = new SessionStore('snapshot', root)
  const store = session.results.history
  const first = await store.begin('bash', 'first', {
    command: '汉😀'.repeat(20000),
  })
  await store.append<ResultRecord>({
    type: 'tool_result',
    callId: first.callId,
    status: 'completed',
    durationMs: 1,
    output: 'original',
  })
  const frozen = await store.snapshot()
  const before = await Bun.file(frozen.path).text()
  const later = await store.begin('bash', 'later', {
    command: 'AFTER_BOUNDARY',
  })
  await store.append<ResultRecord>({
    type: 'tool_result',
    callId: later.callId,
    status: 'completed',
    durationMs: 1,
    output: 'later',
  })
  const rows = (await Bun.file(frozen.path).text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(rows.map((row) => row.seq)).toEqual([1, 2])
  expect(rows[0].input.command).toBe('汉😀'.repeat(20000))
  expect(await Bun.file(frozen.path).text()).toBe(before)
  await session.replace([], new Map(), 'summary', frozen.sequence)
  const restored = new SessionStore('snapshot', root)
  await restored.loadState()
  expect(restored.results.historyViewSequence).toBe(2)
  expect(restored.results.readingGuide()).toContain(`Absolute path: ${frozen.path}`)
  expect((await store.snapshot(undefined, 2)).path).toBe(frozen.path)
})
