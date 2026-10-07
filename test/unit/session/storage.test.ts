import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fileSessionStorage,
  memorySessionStorage,
  type SessionCheckpoint,
} from '../../../src/session/storage'
import { tempDir } from '../../support/vela'

const dirs: { cleanup(): void }[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

const checkpoint = (text: string): SessionCheckpoint => ({
  type: 'checkpoint',
  timestamp: '2026-10-07T00:00:00.000Z',
  summary: '',
  messages: [
    { timestamp: '2026-10-07T00:00:00.000Z', message: { role: 'user', content: text } },
  ],
})

test('memory storage keeps checkpoints per id and hands out copies', async () => {
  const storage = memorySessionStorage()
  expect(await storage.load('a')).toBeUndefined()
  const saved = checkpoint('hi')
  await storage.save('a', saved)
  saved.messages.length = 0
  const loaded = await storage.load('a')
  expect(loaded?.messages).toHaveLength(1)
  loaded?.messages.pop()
  expect((await storage.load('a'))?.messages).toHaveLength(1)
  expect(await storage.load('b')).toBeUndefined()
})

test('file storage writes <dir>/<id>.jsonl and reads old one-message-per-line files', async () => {
  const dir = tempDir()
  dirs.push(dir)
  const storage = fileSessionStorage(join(dir.path, 'sessions'))
  await storage.save('a', checkpoint('hi'))
  expect(await Bun.file(join(dir.path, 'sessions/a.jsonl')).text()).toContain('"hi"')
  expect((await storage.load('a'))?.messages[0]?.message).toEqual({
    role: 'user',
    content: 'hi',
  })

  writeFileSync(
    join(dir.path, 'sessions/old.jsonl'),
    [
      JSON.stringify({ type: 'message', timestamp: 't', message: { role: 'user', content: 'one' } }),
      'not json',
      JSON.stringify({ type: 'message', timestamp: 't', message: { role: 'user', content: 'two' } }),
    ].join('\n'),
  )
  const old = await storage.load('old')
  expect(old?.messages.map((m) => m.message.content)).toEqual(['one', 'two'])
})
