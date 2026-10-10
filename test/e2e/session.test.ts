import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { fauxHang, fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { cleanupTestVelas, createTestVela, tempDir } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('a resumed Vela continues the saved conversation', async () => {
  const first = createTestVela({ responses: [fauxText('First answer')] })
  await first.run('hello')
  await first.cleanup({ keepDir: true })

  const second = createTestVela({
    cwd: first.cwd,
    responses: [
      (req) =>
        fauxText(
          JSON.stringify(req.prompt).includes('First answer')
            ? 'I remember'
            : "I don't remember",
        ),
    ],
  })
  try {
    expect(await second.session.resume()).toBe(true)
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    await second.run('Do you remember?')
    expect(second.lastAssistantText()).toBe('I remember')
  } finally {
    await second.cleanup()
    rmSync(first.cwd, { recursive: true, force: true })
  }
})

test('each message is written as it enters the history, so a killed process keeps the finished steps (like pi)', async () => {
  const t = createTestVela({
    files: { 'a.txt': 'A' },
    responses: [fauxToolCall('read_file', { path: 'a.txt' }), fauxHang('…')],
  })
  const running = t.run('Read a.txt')
  const messages = async () =>
    (t.exists('sessions/default.jsonl')
      ? (await t.readData('sessions/default.jsonl')).trim().split('\n')
      : []
    )
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === 'message')
      .map((entry) => entry.message.role)
  // The second request is still running: the first step is already on disk
  while ((await messages()).length < 3) await Bun.sleep(1)
  expect(await messages()).toEqual(['user', 'assistant', 'tool'])
  await t.session.abort()
  await expect(running).rejects.toThrow()
})

test('prompting a saved session that was not resumed fails instead of mixing two conversations', async () => {
  const first = createTestVela({ responses: [fauxText('First answer')] })
  await first.run('hello')
  await first.cleanup({ keepDir: true })
  const second = createTestVela({ cwd: first.cwd })
  try {
    await expect(second.run('hi')).rejects.toThrow('already has saved history')
    expect(second.model.calls).toHaveLength(0)
    expect(await second.session.resume()).toBe(true)
  } finally {
    await second.cleanup()
    rmSync(first.cwd, { recursive: true, force: true })
  }
})

test('a version-1 session file resumes with its settings and is rewritten in the new format', async () => {
  const t = createTestVela({
    files: {
      '.vela-data/sessions/default.jsonl': `${JSON.stringify({
        type: 'checkpoint',
        version: 1,
        timestamp: '2026-10-01T00:00:00.000Z',
        summary: '',
        thinkingLevel: 'low',
        name: 'Old chat',
        messages: [
          {
            timestamp: '2026-10-01T00:00:00.000Z',
            message: { role: 'user', content: 'old question' },
          },
          {
            timestamp: '2026-10-01T00:00:01.000Z',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'old answer' }],
            },
          },
        ],
      })}\n`,
    },
    responses: [
      (req) =>
        fauxText(
          JSON.stringify(req.prompt).includes('old answer') ? 'kept' : 'lost',
        ),
    ],
  })
  expect(await t.session.resume()).toBe(true)
  expect(t.session.name).toBe('Old chat')
  expect(t.session.thinkingLevel).toBe('low')
  await t.run('new question')
  expect(t.lastAssistantText()).toBe('kept')
  const lines = (await t.readData('sessions/default.jsonl'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(lines[0]).toMatchObject({ type: 'session', version: 2 })
  expect(
    lines.filter((l) => l.type === 'message').map((l) => l.message.role),
  ).toEqual(['user', 'assistant', 'user', 'assistant'])
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
