import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  fileSessionStorage,
  type SessionStorage,
} from '../../src/session/storage.ts'
import { fauxHang, fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import {
  cleanupTestVelas,
  createTestVela,
  type TestVela,
  tempDir,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

/**
 * Roles of the messages in the session file. A run appends a record as it goes, and appendFile() creates the
 * file before writing it, so a record caught mid-write has no trailing newline yet: nothing to parse until it
 * is complete (storage.load() ends such a line the same way).
 */
async function savedRoles(t: TestVela): Promise<string[]> {
  const text = t.exists('sessions/default.jsonl')
    ? await t.readData('sessions/default.jsonl')
    : ''
  if (!text.endsWith('\n')) return []
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'message')
    .map((entry) => entry.message.role as string)
}

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
  // The second request is still running: the first step is already on disk
  while ((await savedRoles(t)).length < 3) await Bun.sleep(1)
  expect(await savedRoles(t)).toEqual(['user', 'assistant', 'tool'])
  await t.session.abort()
  await expect(running).rejects.toThrow()
})

test('a session file caught mid-write is not parsed until its record is complete', async () => {
  const dir = tempDir()
  // appendFile() creates the file, then writes it. Hold the first write so a reader sees a file with no record yet
  const sessions = join(dir.path, 'data', 'sessions')
  const storage = fileSessionStorage(sessions)
  let release!: () => void
  const holding = new Promise<void>((resolve) => {
    release = resolve
  })
  let held = false
  const pausing: SessionStorage = {
    persistence: (id) => storage.persistence!(id),
    load: (id) => storage.load(id),
    list: () => storage.list!(),
    async append(id, entries) {
      if (!held) {
        held = true
        await mkdir(sessions, { recursive: true, mode: 0o700 })
        await writeFile(join(sessions, `${id}.jsonl`), '', { mode: 0o600 })
        await holding
      }
      await storage.append(id, entries)
    },
  }
  const t = createTestVela({
    cwd: dir.path,
    dataDir: 'data',
    sessionStorage: pausing,
    files: { 'a.txt': 'A' },
    responses: [fauxToolCall('read_file', { path: 'a.txt' }), fauxHang('…')],
  })
  const running = t.run('Read a.txt')
  running.catch(() => {})
  try {
    // The file exists, but its first record is still being written
    while (!t.exists('sessions/default.jsonl')) await Bun.sleep(1)
    expect(await savedRoles(t)).toEqual([])
    release()
    while ((await savedRoles(t)).length < 3) await Bun.sleep(1)
    expect(await savedRoles(t)).toEqual(['user', 'assistant', 'tool'])
  } finally {
    release()
    await t.session.abort()
    await running.catch(() => {})
    await t.cleanup({ keepDir: true })
    dir.cleanup()
  }
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
  expect(t.model.calls[1]!.system).toBe(t.model.calls[0]!.system)
  // The closing JSON delimiters of the first request are outside the shared prefix.
  expect(
    Math.abs(usage[1]!.cacheReadTokens - usage[0]!.cacheWriteTokens),
  ).toBeLessThanOrEqual(1)
})
