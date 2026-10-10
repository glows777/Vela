import { afterEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  SessionFileEntry,
  SessionHeader,
} from '../../../src/session/entries.ts'
import {
  fileSessionStorage,
  memorySessionStorage,
} from '../../../src/session/storage.ts'
import { tempDir } from '../../support/vela.ts'

const dirs: { cleanup(): void }[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

const header = (id: string): SessionHeader => ({
  type: 'session',
  version: 2,
  id,
  timestamp: '2026-10-07T00:00:00.000Z',
})

let next = 0
const message = (
  text: string,
  timestamp = '2026-10-07T00:00:00.000Z',
): SessionFileEntry => ({
  type: 'message',
  id: `0000000${next++}`.slice(-8),
  parentId: null,
  timestamp,
  message: { role: 'user', content: text },
})

const contents = (entries: SessionFileEntry[] | undefined) =>
  entries?.flatMap((entry) =>
    entry.type === 'message' ? [entry.message.content] : [],
  )

test('memory storage appends per id and hands out copies', async () => {
  const storage = memorySessionStorage()
  expect(await storage.load('a')).toBeUndefined()
  const first = [header('a'), message('hi')]
  await storage.append('a', first)
  first.length = 0
  await storage.append('a', [message('again')])
  const loaded = await storage.load('a')
  expect(contents(loaded)).toEqual(['hi', 'again'])
  loaded?.pop()
  expect(await storage.load('a')).toHaveLength(3)
  expect(await storage.load('b')).toBeUndefined()
})

test('file storage appends lines to <dir>/<id>.jsonl; corrupt lines are skipped and a cut-off line is ended', async () => {
  const dir = tempDir()
  dirs.push(dir)
  const storage = fileSessionStorage(join(dir.path, 'sessions'))
  await storage.append('a', [header('a'), message('hi')])
  await storage.append('a', [message('again')])
  const path = join(dir.path, 'sessions/a.jsonl')
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(3)
  expect(contents(await storage.load('a'))).toEqual(['hi', 'again'])

  // A crash mid-write leaves half a line without a newline: it is skipped and the next append starts a new line
  writeFileSync(path, `${readFileSync(path, 'utf8')}{"type":"mess`)
  expect(contents(await storage.load('a'))).toEqual(['hi', 'again'])
  await storage.append('a', [message('after')])
  expect(contents(await storage.load('a'))).toEqual(['hi', 'again', 'after'])
})

test('file storage converts version-1 files (checkpoint and one message per line) and writes them back', async () => {
  const dir = tempDir()
  dirs.push(dir)
  const sessions = join(dir.path, 'sessions')
  const storage = fileSessionStorage(sessions)
  await storage.append('seed', [header('seed')])
  writeFileSync(
    join(sessions, 'old.jsonl'),
    [
      JSON.stringify({
        type: 'message',
        timestamp: '2026-05-01T00:00:00.000Z',
        message: { role: 'user', content: 'one' },
      }),
      'not json',
      JSON.stringify({
        type: 'message',
        timestamp: '2026-05-01T00:00:01.000Z',
        message: { role: 'user', content: 'two' },
      }),
    ].join('\n'),
  )
  const old = await storage.load('old')
  expect(old?.[0]).toMatchObject({ type: 'session', version: 2, id: 'old' })
  expect(contents(old)).toEqual(['one', 'two'])

  writeFileSync(
    join(sessions, 'checkpoint.jsonl'),
    `${JSON.stringify({
      type: 'checkpoint',
      version: 1,
      timestamp: '2026-10-07T00:00:00.000Z',
      summary: '',
      model: 'openai/gpt-x',
      thinkingLevel: 'high',
      name: 'Named',
      messages: [
        {
          timestamp: '2026-10-06T00:00:00.000Z',
          message: { role: 'user', content: 'hello' },
        },
      ],
    })}\n`,
  )
  const migrated = await storage.load('checkpoint')
  expect(migrated?.map((entry) => entry.type)).toEqual([
    'session',
    'model_change',
    'thinking_level_change',
    'message',
    'session_info',
  ])
  // Written back as version 2: loading again reads the same entries
  const text = readFileSync(join(sessions, 'checkpoint.jsonl'), 'utf8')
  expect(JSON.parse(text.split('\n')[0] as string).type).toBe('session')
  expect(await storage.load('checkpoint')).toEqual(migrated)
})

test('a file whose header line is damaged is not mistaken for version 1 and rewritten', async () => {
  const dir = tempDir()
  dirs.push(dir)
  const sessions = join(dir.path, 'sessions')
  const storage = fileSessionStorage(sessions)
  await storage.append('cut', [header('cut'), message('kept')])
  const path = join(sessions, 'cut.jsonl')
  const [, ...rest] = readFileSync(path, 'utf8').split('\n')
  const damaged = ['{"type":"sess', ...rest].join('\n')
  writeFileSync(path, damaged)
  expect((await storage.load('cut'))?.[0]).toMatchObject({ type: 'message' })
  expect(readFileSync(path, 'utf8')).toBe(damaged)
})

test('both storages list sessions newest first, skipping ones without messages; a missing directory lists nothing', async () => {
  const dir = tempDir()
  dirs.push(dir)
  for (const storage of [
    memorySessionStorage(),
    fileSessionStorage(join(dir.path, 's')),
  ]) {
    expect(await storage.list?.()).toEqual([])
    await storage.append('a', [header('a'), message('first')])
    await storage.append('b', [
      header('b'),
      message('second', '2026-10-08T00:00:00.000Z'),
      {
        type: 'session_info',
        id: 'aaaaaaaa',
        parentId: null,
        timestamp: '2026-10-08T00:00:01.000Z',
        name: 'Name',
      },
    ])
    await storage.append('empty', [
      { ...header('empty'), timestamp: '2026-10-09T00:00:00.000Z' },
    ])
    expect(await storage.list?.()).toEqual([
      {
        id: 'b',
        name: 'Name',
        updatedAt: '2026-10-08T00:00:01.000Z',
        messageCount: 1,
        firstMessage: 'second',
      },
      {
        id: 'a',
        updatedAt: '2026-10-07T00:00:00.000Z',
        messageCount: 1,
        firstMessage: 'first',
      },
    ])
  }
})
