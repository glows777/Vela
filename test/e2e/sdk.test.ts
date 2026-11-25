import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  background,
  createVela,
  type VelaEvent,
  type VelaLogger,
} from '@glows777/vela'
import {
  cleanupTestVelas,
  createFauxModel,
  createTestVela,
  fauxText,
  fauxToolCall,
  tempDir,
} from '@glows777/vela/testing'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'

afterEach(cleanupTestVelas)

test('the SDK and the testing helpers import by package name', async () => {
  const dir = tempDir()
  const vela = createVela({
    model: createFauxModel({ responses: [fauxText('hi from the SDK')] }),
    cwd: dir.path,
  })
  try {
    const events: VelaEvent[] = []
    const session = vela.session('sdk')
    session.subscribe((event) => events.push(event))
    await session.prompt('hello')
    expect(events.at(-2)).toMatchObject({ type: 'agent_end', reason: 'done' })
    expect(events.at(-1)).toEqual({ type: 'agent_settled' })
    expect(session.messages.at(-1)).toMatchObject({ role: 'assistant' })
    expect(session.usage.totals.steps).toBe(1)
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})

test('the umbrella exports background, and a session can turn its tools on', async () => {
  const vela = createVela({ extensions: [background()] })
  try {
    await vela.ready()
    // The one entry is enough: bash takes run_in_background and both job tools are on.
    const session = vela.session('background')
    expect(session.getActiveTools()).toEqual(
      expect.arrayContaining(['bash', 'background_output', 'background_stop']),
    )
  } finally {
    await vela.dispose()
  }
})

test('core writes nothing to the terminal; diagnostics go to the injected logger', async () => {
  const lines: string[] = []
  const logger: VelaLogger = {
    debug: (m) => lines.push(`debug ${m}`),
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
  }
  const log = spyOn(console, 'log')
  const error = spyOn(console, 'error')
  const write = spyOn(process.stdout, 'write')
  try {
    const t = createTestVela({
      logger,
      files: { 'a.txt': 'x' },
      responses: [
        fauxToolCall('bash', { command: 'git status' }),
        fauxText('done'),
      ],
      extensions: [
        function noisy(vela) {
          vela.logger.info('[noisy] activated')
          vela.on('tool_result', () => {
            throw new Error('handler bug')
          })
        },
      ],
    })
    await t.run('Check the status')
    await t.cleanup()

    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(lines).toContain(
      'error [extension:noisy] tool_result handler failed: handler bug',
    )
    expect(lines).toContain('info [noisy] activated')
    expect(lines.some((l) => l.startsWith('debug [tools] bash'))).toBe(true)
  } finally {
    log.mockRestore()
    error.mockRestore()
    write.mockRestore()
  }
})

test('without a dataDir nothing is persisted: sessions live in memory and scratch files are removed on dispose', async () => {
  const dir = tempDir()
  const vela = createVela({
    model: createFauxModel({
      responses: [
        fauxToolCall('bash', { command: 'seq 1 5000' }),
        fauxText('first'),
        fauxText('second'),
      ],
    }),
    cwd: dir.path,
  })
  try {
    const session = vela.session('x')
    await session.prompt('one')
    // Ephemeral sessions use an in-memory DB while scratch files still clean up on dispose
    expect(existsSync(join(vela.dataDir, 'vela.db'))).toBe(false)
    expect(existsSync(join(vela.dataDir, 'sessions/x/transcript.jsonl'))).toBe(
      false,
    )
    await session.close()

    const reopened = vela.session('x')
    expect(await reopened.resume()).toBe(true)
    expect(reopened.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
    await reopened.prompt('two')
  } finally {
    await vela.dispose()
  }
  expect(existsSync(vela.dataDir)).toBe(false)
  expect(readdirSync(dir.path)).toEqual([])
  dir.cleanup()
})

test('a shared caller-owned SQLite db serves multiple Vela lifecycles and resume', async () => {
  const db = openDatabase({ path: ':memory:' })
  const model = createFauxModel({
    responses: [
      fauxToolCall('bash', { command: 'echo hi' }),
      fauxText('a'),
      fauxText('b'),
    ],
  })
  const first = createVela({ model, db })
  const opened = first.session('db')
  expect(opened.persistence).toEqual({ type: 'memory' })
  await opened.prompt('hello')
  await first.dispose()
  const count = () =>
    db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM vela_messages WHERE session_id = ? AND kind = 'message'",
      'db',
    )!.c
  expect(count()).toBe(4)

  const second = createVela({ model, db })
  try {
    const session = second.session('db')
    expect(session.persistence).toEqual({ type: 'memory' })
    expect(await session.resume()).toBe(true)
    expect(session.persistence).toEqual({ type: 'memory' })
    await session.prompt('again')
    expect(count()).toBe(6)
  } finally {
    await second.dispose()
    db.close()
  }
})
