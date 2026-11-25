import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import {
  fauxHang,
  fauxText,
  fauxToolCall,
} from '../../packages/vela/src/testing/core/index.ts'
import {
  cleanupTestVelas,
  createTestVela,
  type TestVela,
  tempDir,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

function savedRoles(t: TestVela): string[] {
  if (!t.exists('vela.db')) return []
  const db = openDatabase({ path: join(t.dataDir, 'vela.db'), readonly: true })
  try {
    return db
      .all<{ content_json: string }>(
        "SELECT content_json FROM vela_messages WHERE session_id = 'default' AND kind = 'message' ORDER BY seq",
      )
      .map((row) => (JSON.parse(row.content_json) as { role: string }).role)
  } finally {
    db.close()
  }
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
    responses: [fauxToolCall('read', { path: 'a.txt' }), fauxHang('…')],
  })
  const running = t.run('Read a.txt')
  // The second request is still running: the first step is already on disk
  while (savedRoles(t).length < 3) await Bun.sleep(1)
  expect(savedRoles(t)).toEqual(['user', 'assistant', 'tool'])
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
    const db = openDatabase({
      path: join(dir.path, '.vela-data/vela.db'),
      readonly: true,
    })
    try {
      const aRows = db.all<{ content_json: string }>(
        "SELECT content_json FROM vela_messages WHERE session_id = ? AND kind = 'message'",
        'a',
      )
      const bRows = db.all<{ content_json: string }>(
        "SELECT content_json FROM vela_messages WHERE session_id = ? AND kind = 'message'",
        'b',
      )
      expect(aRows.length).toBeGreaterThan(0)
      expect(bRows.length).toBeGreaterThan(0)
      expect(JSON.stringify(aRows)).not.toContain('in b')
    } finally {
      db.close()
    }

    const again = createTestVela({ cwd: dir.path, sessionId: 'a' })
    await again.session.resume()
    expect(JSON.stringify(again.messages)).toContain('in a')
    expect(JSON.stringify(again.messages)).not.toContain('in b')
  } finally {
    await cleanupTestVelas()
    dir.cleanup()
  }
})

test('dataDir keeps sessions, memory and usage out of the working directory', async () => {
  const t = createTestVela({
    dataDir: '.vela-data',
    responses: [fauxText('ok')],
  })
  await t.run('hi')

  for (const path of ['vela.db', 'memory/MEMORY.md'])
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

  const db = openDatabase({ path: join(t.dataDir, 'vela.db'), readonly: true })
  try {
    const rows = db.all<{ output_tokens: number }>(
      'SELECT output_tokens FROM usage_records ORDER BY created_at',
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.output_tokens)).toEqual([10, 12])
  } finally {
    db.close()
  }
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
