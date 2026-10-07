import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { fauxText } from '../../src/testing/faux'
import { cleanupTestVelas, createTestVela, tempDir } from '../support/vela'

afterEach(cleanupTestVelas)

test('a resumed Vela continues the saved conversation', async () => {
  const first = createTestVela({ responses: [fauxText('第一次的回答')] })
  await first.run('你好')
  await first.cleanup({ keepDir: true })

  const second = createTestVela({
    cwd: first.cwd,
    responses: [
      (req) =>
        fauxText(
          JSON.stringify(req.prompt).includes('第一次的回答')
            ? '记得'
            : '不记得',
        ),
    ],
  })
  try {
    expect(await second.session.resume()).toBe(true)
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    await second.run('你还记得吗？')
    expect(second.lastAssistantText()).toBe('记得')
  } finally {
    await second.cleanup()
    rmSync(first.cwd, { recursive: true, force: true })
  }
})

test('resume on an empty data dir reports no session', async () => {
  const t = createTestVela()
  expect(await t.session.resume()).toBe(false)
  expect(t.messages).toEqual([])
})

test('sessions with different ids are stored separately', async () => {
  const dir = tempDir()
  try {
    const a = createTestVela({
      cwd: dir.path,
      sessionId: 'a',
      responses: [fauxText('A')],
    })
    await a.run('in a')
    const b = createTestVela({
      cwd: dir.path,
      sessionId: 'b',
      responses: [fauxText('B')],
    })
    await b.run('in b')
    expect(a.exists('sessions/a.jsonl')).toBe(true)
    expect(b.exists('sessions/b.jsonl')).toBe(true)
    expect(await a.readData('sessions/a.jsonl')).not.toContain('in b')

    const again = createTestVela({ cwd: dir.path, sessionId: 'a' })
    await again.session.resume()
    expect(JSON.stringify(again.messages)).toContain('in a')
    expect(JSON.stringify(again.messages)).not.toContain('in b')
  } finally {
    await cleanupTestVelas()
    dir.cleanup()
  }
})

test('dataDir keeps sessions, memory, usage and knowledge base out of the working directory', async () => {
  const t = createTestVela({
    dataDir: '.vela-data',
    embedder: true,
    responses: [fauxText('ok')],
  })
  await t.run('hi')

  for (const path of [
    'sessions/default.jsonl',
    'memory/MEMORY.md',
    'usage/today.jsonl',
    'rag/knowledge.db',
  ])
    expect(t.exists(path)).toBe(true)
  expect(t.dataDir).toBe(t.path('.vela-data'))
  const top = Array.from(
    new Bun.Glob('*').scanSync({ cwd: t.cwd, onlyFiles: false, dot: true }),
  )
  expect(top.sort()).toEqual(['.vela-data'])
})

test('token usage is appended to the usage log for every model step', async () => {
  const t = createTestVela({
    responses: [
      fauxText('a', { usage: { input: 100, output: 10 } }),
      fauxText('b', { usage: { input: 120, output: 12 } }),
    ],
  })
  await t.run('1')
  await t.run('2')

  const rows = (await t.readData('usage/today.jsonl'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  expect(rows).toHaveLength(2)
  expect(rows.map((r) => r.outputTokens)).toEqual([10, 12])
  expect(t.eventsOf('usage').map((e) => e.modelId)).toEqual(['faux', 'faux'])
})

test('prompt cache simulation: a stable system prompt is read from cache on the next request', async () => {
  const t = createTestVela({
    faux: { cache: true },
    responses: [fauxText('a'), fauxText('b')],
  })
  await t.run('1')
  await t.run('2')
  const usage = t.eventsOf('usage').map((e) => e.usage)
  expect(usage[0]!.cacheWriteTokens).toBeGreaterThan(0)
  expect(usage[1]!.cacheReadTokens).toBe(usage[0]!.cacheWriteTokens)
})
