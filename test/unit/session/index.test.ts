import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ModelMessage } from 'ai'
import { SessionStore } from '../../../src/session/index.ts'

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-session-'))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

test('replace → loadState round-trip keeps messages, timestamps and summary', async () => {
  const store = new SessionStore(
    'default',
    path.join(makeTempDir(), '.sessions'),
  )
  const messages: ModelMessage[] = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: [{ type: 'text' as const, text: 'Hello!' }] },
  ]
  const timestamps = new Map([
    [messages[0]!, 1000],
    [messages[1]!, 2000],
  ])

  await store.replace(messages, timestamps, 'Summary')
  const state = await store.loadState()

  expect(state.messages).toEqual(messages)
  expect(state.summary).toBe('Summary')
  // Timestamps are keyed by the parsed message objects (references differ after the JSON round-trip, so only check count and values)
  expect(state.timestamps.size).toBe(2)
  for (const ts of state.timestamps.values()) {
    expect(ts).toBeGreaterThan(0)
  }
})

test('returns an empty session when the file does not exist', async () => {
  const store = new SessionStore(
    'default',
    path.join(makeTempDir(), '.sessions'),
  )
  const state = await store.loadState()
  expect(state.messages).toEqual([])
  expect(state.summary).toBe('')
})

test('corrupt lines are skipped and later lines still parse', async () => {
  const dir = path.join(makeTempDir(), '.sessions')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'default.jsonl')
  fs.writeFileSync(
    file,
    [
      '{ broken json',
      JSON.stringify({
        type: 'checkpoint',
        timestamp: '2026-01-01',
        summary: 'S',
        messages: [],
      }),
    ].join('\n'),
    'utf-8',
  )
  const state = await new SessionStore('default', dir).loadState()
  expect(state.summary).toBe('S')
  expect(state.messages).toEqual([])
})

test('exists reflects whether the file exists', async () => {
  const store = new SessionStore(
    'default',
    path.join(makeTempDir(), '.sessions'),
  )
  expect(await store.exists()).toBe(false)
  await store.replace([], new Map(), '')
  expect(await store.exists()).toBe(true)
})

test('checkpoints carry a format version; a file written by a newer version fails clearly instead of loading as empty', async () => {
  const dir = path.join(makeTempDir(), '.sessions')
  await new SessionStore('default', dir).replace([], new Map(), '')
  const saved = JSON.parse(
    fs.readFileSync(path.join(dir, 'default.jsonl'), 'utf-8'),
  )
  expect(saved.version).toBe(1)

  fs.writeFileSync(
    path.join(dir, 'newer.jsonl'),
    JSON.stringify({ ...saved, version: 2 }),
  )
  await expect(new SessionStore('newer', dir).loadState()).rejects.toThrow(
    'uses file format version 2',
  )
})
