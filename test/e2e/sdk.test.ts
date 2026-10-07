import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  createVela,
  type SessionCheckpoint,
  type SessionStorage,
  type VelaEvent,
  type VelaLogger,
} from 'vela'
import {
  cleanupTestVelas,
  createFauxModel,
  createTestVela,
  fauxText,
  fauxToolCall,
  tempDir,
} from 'vela/testing'

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
    expect(events.at(-1)).toEqual({ type: 'agent_end', reason: 'done' })
    expect(session.messages.at(-1)).toMatchObject({ role: 'assistant' })
    expect(session.usage.totals.steps).toBe(1)
  } finally {
    await vela.dispose()
    dir.cleanup()
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
    await t.run('看看状态')
    await t.cleanup()

    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(lines).toContain(
      'error [extension:noisy] tool_result handler 出错: handler bug',
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
    // 工具长输出、工具历史写在临时数据目录里（模型能用 read_file 读），会话本身不写文件
    expect(existsSync(join(vela.dataDir, 'sessions/x'))).toBe(true)
    expect(existsSync(join(vela.dataDir, 'sessions/x.jsonl'))).toBe(false)
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

test('a custom session storage receives every save and serves resume', async () => {
  const saved = new Map<string, SessionCheckpoint>()
  const storage: SessionStorage = {
    load: async (id) => saved.get(id),
    save: async (id, checkpoint) => {
      saved.set(id, checkpoint)
    },
  }
  // 第一个实例调过工具：工具历史在它的临时目录里，dispose 后就没了，恢复仍要成功
  const model = createFauxModel({
    responses: [
      fauxToolCall('bash', { command: 'echo hi' }),
      fauxText('a'),
      fauxText('b'),
    ],
  })
  const first = createVela({ model, sessionStorage: storage })
  await first.session('db').prompt('hello')
  await first.dispose()
  expect(saved.get('db')?.messages).toHaveLength(4)
  expect(saved.get('db')?.toolHistorySeq).toBeGreaterThan(0)

  const second = createVela({ model, sessionStorage: storage })
  try {
    const session = second.session('db')
    expect(await session.resume()).toBe(true)
    await session.prompt('again')
    expect(saved.get('db')?.messages).toHaveLength(6)
  } finally {
    await second.dispose()
  }
})
