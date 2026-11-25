import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../../../../src/db/index.ts'
import type { ModelMessage } from '../../../../src/driver/messages.ts'
import {
  buildSessionContext,
  type SessionEntry,
  summaryMessageText,
} from '../../../../src/driver/session/entries.ts'
import { SessionStore } from '../../../../src/driver/session/index.ts'

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-session-'))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

const user = (content: string): ModelMessage => ({ role: 'user', content })
const assistant = (text: string): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
})

test('entries are appended in order with ids and parents; loadSaved rebuilds context and metadata', async () => {
  const dbPath = path.join(makeTempDir(), 'vela.db')
  const store = new SessionStore('default', dbPath)
  store.setModelChoice('openai/gpt-x')
  store.setThinkingLevelChoice('high')
  store.appendMessage(user('Hello'))
  store.appendMessage(assistant('Hi!'))
  store.setSessionName('Greeting')
  await store.flush()

  const loaded = await new SessionStore('default', dbPath).loadSaved()
  expect(loaded?.messages).toEqual([user('Hello'), assistant('Hi!')])
  expect(loaded?.model).toBe('openai/gpt-x')
  expect(loaded?.thinkingLevel).toBe('high')
  expect(loaded?.name).toBe('Greeting')
  expect(loaded?.timestamps.size).toBe(2)
})

test('nothing is written to SQLite until the session has a user or assistant message', async () => {
  const dbPath = path.join(makeTempDir(), 'vela.db')
  const store = new SessionStore('default', dbPath)
  store.setThinkingLevelChoice('low')
  store.setSessionName('Name')
  await store.flush()
  expect(await store.loadSaved()).toBeUndefined()
})

test('assertNew refuses to start over a saved session that was not resumed', async () => {
  const db = openDatabase({ path: ':memory:' })
  try {
    const first = new SessionStore('s', db)
    await first.assertNew()
    first.appendMessage(user('hi'))
    await first.flush()
    await expect(new SessionStore('s', db).assertNew()).rejects.toThrow(
      'already has saved history',
    )
    const resumed = new SessionStore('s', db)
    await resumed.loadSaved()
    await resumed.assertNew()
  } finally {
    db.close()
  }
})

test('messages appended without resume() fail before overwriting a saved session', async () => {
  const db = openDatabase({ path: ':memory:' })
  try {
    const first = new SessionStore('s', db)
    first.appendMessage(user('first conversation'))
    const second = new SessionStore('s', db)
    expect(() => second.appendMessage(user('second conversation'))).toThrow(
      'already has saved history',
    )
  } finally {
    db.close()
  }
})

test('compaction is appended in SQLite while originals stay on disk and context is rebuilt cleanly', async () => {
  const db = openDatabase({ path: ':memory:' })
  try {
    const store = new SessionStore('s', db)
    const old = user('old question')
    const kept = user('recent question')
    const tool: ModelMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolCallId: 'c1',
          toolName: 'read',
          output: { type: 'text', value: 'long output' },
        },
      ],
    }
    for (const message of [old, assistant('old answer'), kept, tool])
      store.appendMessage(message)
    const summary = user(summaryMessageText('S'))
    store.appendCompaction(summary, 'S', kept, 1234)
    store.appendMessage(assistant('after'))

    const loaded = await new SessionStore('s', db).loadSaved()
    expect(loaded?.messages).toEqual([summary, kept, tool, assistant('after')])
    expect(loaded?.summary).toBe('S')
    const allEntries = store.getEntries()
    expect(allEntries.map((entry) => entry.type)).toEqual([
      'message',
      'message',
      'message',
      'message',
      'compaction',
      'message',
    ])
    expect(allEntries.filter((e) => e.type === 'message')).toHaveLength(5)
  } finally {
    db.close()
  }
})

test('aborted or failed assistant messages are recorded with include_in_context=0 (like pi)', () => {
  const db = openDatabase({ path: ':memory:' })
  try {
    const store = new SessionStore('s', db)
    store.appendMessage(user('go'))
    store.appendMessage(assistant('half an ans'), { stopReason: 'aborted' })
    store.appendMessage(user('again'))
    const entries: SessionEntry[] = store.getEntries()
    expect(entries[1]).toMatchObject({ type: 'message', stopReason: 'aborted' })
    expect(buildSessionContext(entries).messages).toEqual([
      user('go'),
      user('again'),
    ])
    const row = db.get<{ include_in_context: number }>(
      'SELECT include_in_context FROM vela_messages WHERE session_id = ? AND stop_reason = ?',
      's',
      'aborted',
    )
    expect(row?.include_in_context).toBe(0)
  } finally {
    db.close()
  }
})
