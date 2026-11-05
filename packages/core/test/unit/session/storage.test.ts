import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../../../../../test/support/vela.ts'
import type { SessionFileEntry, SessionHeader } from '../../../src/index.ts'
import { fileSessionStorage, memorySessionStorage } from '../../../src/index.ts'

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
  expect(storage.persistence?.('a')).toEqual({ type: 'memory' })
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

test('file storage appends lines to <dir>/<id>/transcript.jsonl; corrupt lines are skipped and a cut-off line is ended', async () => {
  const dir = tempDir()
  dirs.push(dir)
  const storage = fileSessionStorage(join(dir.path, 'sessions'))
  const path = join(dir.path, 'sessions/a/transcript.jsonl')
  expect(storage.persistence?.('a')).toEqual({ type: 'file', path })
  expect(existsSync(path)).toBe(false)
  await storage.append('a', [header('a'), message('hi')])
  await storage.append('a', [message('again')])
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(3)
  expect(contents(await storage.load('a'))).toEqual(['hi', 'again'])

  // A crash mid-write leaves half a line without a newline: it is skipped and the next append starts a new line
  writeFileSync(path, `${readFileSync(path, 'utf8')}{"type":"mess`)
  expect(contents(await storage.load('a'))).toEqual(['hi', 'again'])
  await storage.append('a', [message('after')])
  expect(contents(await storage.load('a'))).toEqual(['hi', 'again', 'after'])
})

test('a 0.5.0 flat session is converted on load, keeping its entries and appending to the new path', async () => {
  const dir = tempDir()
  dirs.push(dir)
  const sessions = join(dir.path, 'sessions')
  const storage = fileSessionStorage(sessions)
  mkdirSync(sessions, { recursive: true })
  writeFileSync(
    join(sessions, 'a.jsonl'),
    `${[header('a'), message('hi')].map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  )
  expect(contents(await storage.load('a'))).toEqual(['hi'])
  expect(existsSync(join(sessions, 'a.jsonl'))).toBe(false)
  expect(readFileSync(join(sessions, 'a/transcript.jsonl'), 'utf8')).toContain(
    '"hi"',
  )
  await storage.append('a', [message('again')])
  expect(contents(await storage.load('a'))).toEqual(['hi', 'again'])
})

test('appending without loading converts the flat session first instead of starting a second transcript', async () => {
  const dir = tempDir()
  dirs.push(dir)
  const sessions = join(dir.path, 'sessions')
  const storage = fileSessionStorage(sessions)
  mkdirSync(sessions, { recursive: true })
  writeFileSync(
    join(sessions, 'a.jsonl'),
    `${[header('a'), message('hi')].map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  )
  await storage.append('a', [message('after')])
  expect(contents(await storage.load('a'))).toEqual(['hi', 'after'])
  expect(existsSync(join(sessions, 'a.jsonl'))).toBe(false)
  expect(
    readFileSync(join(sessions, 'a/transcript.jsonl'), 'utf8')
      .trim()
      .split('\n'),
  ).toHaveLength(3)
})

test("a flat file of session 'a' that blocks the name of session 'a.jsonl' is converted first", async () => {
  const dir = tempDir()
  dirs.push(dir)
  const sessions = join(dir.path, 'sessions')
  const storage = fileSessionStorage(sessions)
  mkdirSync(sessions, { recursive: true })
  const flat = (id: string, text: string) =>
    writeFileSync(
      join(sessions, `${id}.jsonl`),
      `${[header(id), message(text)].map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    )
  flat('a', 'one')
  flat('a.jsonl', 'two')
  // Opening the inner session needs the directory that the outer one's flat file occupies
  expect(contents(await storage.load('a.jsonl'))).toEqual(['two'])
  expect(contents(await storage.load('a'))).toEqual(['one'])
  expect(readFileSync(join(sessions, 'a/transcript.jsonl'), 'utf8')).toContain(
    '"one"',
  )
  expect(
    readFileSync(join(sessions, 'a.jsonl/transcript.jsonl'), 'utf8'),
  ).toContain('"two"')
  expect(existsSync(join(sessions, 'a.jsonl.jsonl'))).toBe(false)
})

test('listing reads both layouts without converting, and the directory form wins', async () => {
  const dir = tempDir()
  dirs.push(dir)
  const sessions = join(dir.path, 'sessions')
  const storage = fileSessionStorage(sessions)
  const lines = (id: string, text: string, timestamp: string) =>
    `${[header(id), message(text, timestamp)].map((entry) => JSON.stringify(entry)).join('\n')}\n`
  mkdirSync(join(sessions, 'new'), { recursive: true })
  writeFileSync(
    join(sessions, 'flat.jsonl'),
    lines('flat', 'old', '2026-10-06T00:00:00.000Z'),
  )
  writeFileSync(
    join(sessions, 'new/transcript.jsonl'),
    lines('new', 'directory', '2026-10-08T00:00:00.000Z'),
  )
  // A leftover flat copy of a converted session loses to its directory
  writeFileSync(
    join(sessions, 'new.jsonl'),
    lines('new', 'leftover', '2026-10-08T00:00:00.000Z'),
  )
  // Tool output for a session without a transcript yet, and the shared tool-result directory
  mkdirSync(join(sessions, '.shared/tool-results'), { recursive: true })

  expect((await storage.list?.())?.map((s) => [s.id, s.firstMessage])).toEqual([
    ['new', 'directory'],
    ['flat', 'old'],
  ])
  expect(existsSync(join(sessions, 'flat.jsonl'))).toBe(true)
  expect(existsSync(join(sessions, 'new.jsonl'))).toBe(true)
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
  expect(existsSync(join(sessions, 'old.jsonl'))).toBe(false)

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
  const text = readFileSync(
    join(sessions, 'checkpoint/transcript.jsonl'),
    'utf8',
  )
  expect(JSON.parse(text.split('\n')[0] as string).type).toBe('session')
  expect(await storage.load('checkpoint')).toEqual(migrated)
})

test('a file whose header line is damaged is not mistaken for version 1 and rewritten', async () => {
  const dir = tempDir()
  dirs.push(dir)
  const sessions = join(dir.path, 'sessions')
  const storage = fileSessionStorage(sessions)
  await storage.append('cut', [header('cut'), message('kept')])
  const path = join(sessions, 'cut/transcript.jsonl')
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
