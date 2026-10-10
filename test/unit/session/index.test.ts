import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ModelMessage } from 'ai'
import {
  buildSessionContext,
  migrateSessionV1,
  type SessionEntry,
  type SessionFileEntry,
  summaryMessageText,
} from '../../../src/session/entries.ts'
import { SessionStore } from '../../../src/session/index.ts'
import {
  memorySessionStorage,
  type SessionStorage,
} from '../../../src/session/storage.ts'

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

test('entries are appended in order with ids and parents; loadSaved rebuilds the context and settings', async () => {
  const dir = path.join(makeTempDir(), 'sessions')
  const store = new SessionStore('default', dir)
  store.appendModelChange('openai/gpt-x')
  store.appendThinkingLevelChange('high')
  store.appendMessage(user('Hello'))
  store.appendMessage(assistant('Hi!'))
  store.appendSessionInfo('Greeting')
  await store.flush()

  const lines = fs
    .readFileSync(path.join(dir, 'default.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(lines.map((line) => line.type)).toEqual([
    'session',
    'model_change',
    'thinking_level_change',
    'message',
    'message',
    'session_info',
  ])
  expect(lines[0]).toMatchObject({ version: 2, id: 'default' })
  for (let i = 2; i < lines.length; i++)
    expect(lines[i].parentId).toBe(lines[i - 1].id)
  expect(lines[1].parentId).toBeNull()

  const loaded = await new SessionStore('default', dir).loadSaved()
  expect(loaded?.messages).toEqual([user('Hello'), assistant('Hi!')])
  expect(loaded?.model).toBe('openai/gpt-x')
  expect(loaded?.thinkingLevel).toBe('high')
  expect(loaded?.name).toBe('Greeting')
  expect(loaded?.timestamps.size).toBe(2)
})

test('like pi, nothing is written until the session has a user or assistant message', async () => {
  const dir = path.join(makeTempDir(), 'sessions')
  const store = new SessionStore('default', dir)
  store.appendThinkingLevelChange('low')
  store.appendSessionInfo('Name')
  await store.flush()
  expect(fs.existsSync(path.join(dir, 'default.jsonl'))).toBe(false)
  expect(await store.loadSaved()).toBeUndefined()
})

test('a failed write keeps the entries and writes them, in order, on the next attempt', async () => {
  const inner = memorySessionStorage()
  let fail = true
  const storage: SessionStorage = {
    load: inner.load,
    append: async (id, entries) => {
      if (fail) throw new Error('disk full')
      await inner.append(id, entries)
    },
  }
  const store = new SessionStore('s', 'unused', undefined, storage)
  store.appendMessage(user('one'))
  await expect(store.flush()).rejects.toThrow('disk full')
  store.appendMessage(assistant('two'))
  fail = false
  await store.flush()
  const saved = await inner.load('s')
  expect(saved?.map((entry) => entry.type)).toEqual([
    'session',
    'message',
    'message',
  ])
})

test('a session written by a newer format version fails clearly instead of loading as empty', async () => {
  const storage = memorySessionStorage()
  await storage.append('newer', [
    { type: 'session', version: 3, id: 'newer', timestamp: 't' },
  ])
  await expect(
    new SessionStore('newer', 'unused', undefined, storage).loadSaved(),
  ).rejects.toThrow('uses file format version 3')
})

test('assertNew refuses to start over a saved session that was not resumed', async () => {
  const storage = memorySessionStorage()
  const first = new SessionStore('s', 'unused', undefined, storage)
  await first.assertNew()
  first.appendMessage(user('hi'))
  await first.flush()
  await expect(
    new SessionStore('s', 'unused', undefined, storage).assertNew(),
  ).rejects.toThrow('already has saved history')
  const resumed = new SessionStore('s', 'unused', undefined, storage)
  await resumed.loadSaved()
  await resumed.assertNew()
})

test('messages appended without prompt() do not go into a saved session that was not resumed', async () => {
  const storage = memorySessionStorage()
  const first = new SessionStore('s', 'unused', undefined, storage)
  first.appendMessage(user('first conversation'))
  await first.flush()
  const second = new SessionStore('s', 'unused', undefined, storage)
  second.appendMessage(user('second conversation'))
  await expect(second.flush()).rejects.toThrow('already has saved history')
  expect(await storage.load('s')).toHaveLength(2)
})

test('loadSaved keeps the first copy of entries repeated by a retried write', async () => {
  const storage = memorySessionStorage()
  const store = new SessionStore('s', 'unused', undefined, storage)
  store.appendMessage(user('hi'))
  store.appendMessage(assistant('hello'))
  await store.flush()
  const saved = (await storage.load('s')) as SessionFileEntry[]
  // The first write failed after its first entries reached storage, then the whole batch was retried
  await storage.append('s', saved.slice(1))
  const loaded = await new SessionStore(
    's',
    'unused',
    undefined,
    storage,
  ).loadSaved()
  expect(loaded?.messages).toEqual([user('hi'), assistant('hello')])
})

test('entries appended while flushing are not reported as a failed write', async () => {
  const inner = memorySessionStorage()
  const storage: SessionStorage = {
    load: inner.load,
    append: async (id, entries) => {
      await Bun.sleep(20)
      await inner.append(id, entries)
    },
  }
  const store = new SessionStore('s', 'unused', undefined, storage)
  store.appendMessage(user('one'))
  const flushing = store.flush()
  // `two` goes out with flush()'s own write; `three` lands while that write is still running
  setTimeout(() => store.appendMessage(assistant('two')), 10)
  setTimeout(() => store.appendMessage(user('three')), 30)
  await flushing
  await store.flush()
  expect(await inner.load('s')).toHaveLength(4)
})

test('compaction and context edits are appended; the originals stay and the context is rebuilt from them', async () => {
  const storage = memorySessionStorage()
  const store = new SessionStore('s', 'unused', undefined, storage)
  const old = user('old question')
  const kept = user('recent question')
  const tool: ModelMessage = {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'read_file',
        output: { type: 'text', value: 'long output' },
      },
    ],
  }
  for (const message of [old, assistant('old answer'), kept, tool])
    store.appendMessage(message)
  const folded: ModelMessage = {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'read_file',
        output: { type: 'text', value: '[folded]' },
      },
    ],
  }
  store.appendContextEdit(tool, folded)
  const summary = user(summaryMessageText('S'))
  store.appendCompaction(summary, 'S', kept, 1234, 7)
  store.appendMessage(assistant('after'))
  await store.flush()

  const entries = (await storage.load('s')) as SessionFileEntry[]
  expect(entries.map((entry) => entry.type)).toEqual([
    'session',
    'message',
    'message',
    'message',
    'message',
    'context_edit',
    'compaction',
    'message',
  ])
  const context = buildSessionContext(entries.slice(1) as SessionEntry[])
  expect(context.messages).toEqual([summary, kept, folded, assistant('after')])
  expect(context.summary).toBe('S')
  expect(context.toolHistoryViewSeq).toBe(7)
  // Every message, including the summarized ones, is still in the session
  expect(store.getEntries().filter((e) => e.type === 'message')).toHaveLength(5)
})

test('aborted or failed assistant messages are recorded but left out of the context (like pi)', () => {
  const store = new SessionStore(
    's',
    'unused',
    undefined,
    memorySessionStorage(),
  )
  store.appendMessage(user('go'))
  store.appendMessage(assistant('half an ans'), { stopReason: 'aborted' })
  store.appendMessage(user('again'))
  const entries = store.getEntries()
  expect(entries[1]).toMatchObject({ type: 'message', stopReason: 'aborted' })
  expect(buildSessionContext(entries).messages).toEqual([
    user('go'),
    user('again'),
  ])
})

test('a compacted version-1 checkpoint migrates to a compaction entry that rebuilds the same context', () => {
  const summary = 'User goal: ship it'
  const messages = [
    user(summaryMessageText(summary)),
    user('recent'),
    assistant('ok'),
  ]
  const migrated = migrateSessionV1('s', [
    {
      type: 'checkpoint',
      version: 1,
      timestamp: '2026-10-07T00:00:00.000Z',
      summary,
      toolHistoryViewSeq: 3,
      messages: messages.map((message) => ({
        timestamp: '2026-10-06T00:00:00.000Z',
        message,
      })),
    },
  ])
  expect(migrated.map((entry) => entry.type)).toEqual([
    'session',
    'message',
    'message',
    'compaction',
  ])
  const context = buildSessionContext(migrated.slice(1) as SessionEntry[])
  expect(context.messages).toEqual(messages)
  expect(context.toolHistoryViewSeq).toBe(3)
})
