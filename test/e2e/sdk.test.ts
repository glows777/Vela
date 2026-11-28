import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  createRuntime,
  type RuntimeEvent,
  type VelaLogger,
} from '@glows777/vela'
import {
  cleanupTestVelas,
  createFauxModel,
  fauxText,
  fauxToolCall,
  tempDir,
} from '@glows777/vela/testing'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'

afterEach(cleanupTestVelas)

test('createRuntime() and the testing helpers import by package name', async () => {
  const dir = tempDir()
  const runtime = createRuntime({
    ephemeral: true,
    defaultModel: createFauxModel({ responses: [fauxText('hi from the SDK')] }),
    mcp: false,
  })
  try {
    await runtime.ready()
    const project = await runtime.projects.create({
      name: 'SDK',
      cwd: dir.path,
      hubSessionId: true,
    })
    const sessionId = project.hubSessionId!
    const events: RuntimeEvent[] = []
    runtime.events.subscribe((event) => events.push(event))
    await runtime.prompt(sessionId, { text: 'hello' })
    await runtime.waitForIdle(sessionId)
    expect(events.some((e) => e.type === 'run_finished')).toBe(true)
    const page = await runtime.sessions.messages({ sessionId })
    expect(page.messages.at(-1)).toMatchObject({
      role: 'assistant',
      text: 'hi from the SDK',
    })
    const committedAssistant = events.find(
      (e) => e.type === 'message_committed' && e.message.role === 'assistant',
    )
    expect(committedAssistant).toBeDefined()
    const inspection = await runtime.sessions.inspect(sessionId, {
      includeEntries: true,
    })
    expect(inspection.entries.length).toBeGreaterThanOrEqual(2)
    expect(inspection.activeTools.length).toBeGreaterThan(0)
  } finally {
    await runtime.dispose()
    dir.cleanup()
  }
})

test('createRuntime() sessions expose built-in background tools and accept inline extensions', async () => {
  const seenToolCalls: string[] = []
  const runtime = createRuntime({
    ephemeral: true,
    defaultModel: createFauxModel({
      responses: [
        fauxToolCall('bash', { command: 'echo hello' }),
        fauxText('done'),
      ],
    }),
    mcp: false,
    extensions: [
      function recorder(api) {
        api.on('tool_call', (event) => {
          seenToolCalls.push(event.toolName)
        })
      },
    ],
  })
  try {
    await runtime.ready()
    const session = await runtime.sessions.create({ name: 'background' })
    await runtime.prompt(session.id, { text: 'run echo' })
    await runtime.waitForIdle(session.id)
    const inspected = await runtime.sessions.inspect(session.id)
    expect(inspected.allTools).toEqual(
      expect.arrayContaining(['bash', 'background_output', 'background_stop']),
    )
    expect(seenToolCalls).toEqual(['bash'])
  } finally {
    await runtime.dispose()
  }
})

test('createRuntime() supports docs paths and systemPrompt / appendSystemPrompt overrides', async () => {
  const seenSystems: string[] = []
  const dir = tempDir()
  const model = createFauxModel({
    responses: [
      (req) => {
        seenSystems.push(req.system ?? '')
        return fauxText('first')
      },
      (req) => {
        seenSystems.push(req.system ?? '')
        return fauxText('second')
      },
    ],
  })
  const runtimeDefaultDocs = createRuntime({
    ephemeral: true,
    defaultModel: model,
    mcp: false,
    appendSystemPrompt: 'CUSTOM_APPEND_LINE',
  })
  const runtimeNoDocs = createRuntime({
    ephemeral: true,
    defaultModel: model,
    mcp: false,
    docs: false,
    systemPrompt: 'CUSTOM_SYSTEM_PROMPT',
  })
  try {
    await runtimeDefaultDocs.ready()
    await runtimeNoDocs.ready()

    const s1 = await runtimeDefaultDocs.sessions.create({ name: 'docs-on' })
    await runtimeDefaultDocs.sessions.configure(s1.id, { cwd: dir.path })
    await runtimeDefaultDocs.prompt(s1.id, { text: 'one' })
    await runtimeDefaultDocs.waitForIdle(s1.id)

    const s2 = await runtimeNoDocs.sessions.create({ name: 'docs-off' })
    await runtimeNoDocs.sessions.configure(s2.id, { cwd: dir.path })
    await runtimeNoDocs.prompt(s2.id, { text: 'two' })
    await runtimeNoDocs.waitForIdle(s2.id)

    expect(seenSystems[0]).toContain('<docs>')
    expect(seenSystems[0]).toContain('CUSTOM_APPEND_LINE')
    expect(seenSystems[1]).toContain('CUSTOM_SYSTEM_PROMPT')
    expect(seenSystems[1]).not.toContain('<docs>')
  } finally {
    await runtimeDefaultDocs.dispose()
    await runtimeNoDocs.dispose()
    dir.cleanup()
  }
})

test('core writes nothing to the terminal; diagnostics go to the injected logger', async () => {
  const dir = tempDir()
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
  const runtime = createRuntime({
    ephemeral: true,
    defaultModel: createFauxModel({
      responses: [
        fauxToolCall('bash', { command: 'git status' }),
        fauxText('done'),
      ],
    }),
    mcp: false,
    logger,
    extensions: [
      function noisy(api) {
        api.logger.info('[noisy] activated')
        api.on('tool_result', () => {
          throw new Error('handler bug')
        })
      },
    ],
  })
  try {
    await runtime.ready()
    const project = await runtime.projects.create({
      name: 'LoggerTest',
      cwd: dir.path,
      hubSessionId: true,
    })
    const sessionId = project.hubSessionId!
    await runtime.prompt(sessionId, { text: 'Check the status' })
    await runtime.waitForIdle(sessionId)

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
    await runtime.dispose()
    dir.cleanup()
  }
})

test('with ephemeral: true nothing is persisted: sessions live in memory and temp agentDir is removed on dispose', async () => {
  const runtime = createRuntime({
    ephemeral: true,
    defaultModel: createFauxModel({
      responses: [
        fauxToolCall('bash', { command: 'seq 1 5000' }),
        fauxText('first'),
      ],
    }),
    mcp: false,
  })
  const agentDir = runtime.agentDir
  try {
    await runtime.ready()
    const session = await runtime.sessions.create({ name: 'ephemeral-x' })
    await runtime.prompt(session.id, { text: 'one' })
    await runtime.waitForIdle(session.id)
    expect(existsSync(join(agentDir, 'vela.db'))).toBe(false)
    const page = await runtime.sessions.messages({ sessionId: session.id })
    expect(page.messages.length).toBeGreaterThanOrEqual(2)
  } finally {
    await runtime.dispose()
  }
  expect(existsSync(agentDir)).toBe(false)
})

test('a shared caller-owned SQLite db serves multiple createRuntime() lifecycles and resume', async () => {
  const db = openDatabase({ path: ':memory:' })
  const dir = tempDir()
  const model = createFauxModel({
    responses: [
      fauxToolCall('bash', { command: 'echo hi' }),
      fauxText('a'),
      fauxText('b'),
    ],
  })
  const first = createRuntime({
    agentDir: dir.path,
    defaultModel: model,
    db,
    mcp: false,
  })
  await first.ready()
  const created = await first.sessions.create({ id: 'db', name: 'db' })
  await first.prompt(created.id, { text: 'hello' })
  await first.waitForIdle(created.id)
  await first.dispose()

  const count = () =>
    db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM vela_messages WHERE session_id = ? AND kind = 'message'",
      'db',
    )!.c
  expect(count()).toBe(4)

  const second = createRuntime({
    agentDir: dir.path,
    defaultModel: model,
    db,
    mcp: false,
  })
  try {
    await second.ready()
    const restored = await second.sessions.get('db')
    expect(restored).toBeDefined()
    await second.prompt('db', { text: 'again' })
    await second.waitForIdle('db')
    expect(count()).toBe(6)
  } finally {
    await second.dispose()
    db.close()
    dir.cleanup()
  }
})
