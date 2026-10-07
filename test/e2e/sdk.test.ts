import { afterEach, expect, spyOn, test } from 'bun:test'
import { createVela, type VelaEvent, type VelaLogger } from 'vela'
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
