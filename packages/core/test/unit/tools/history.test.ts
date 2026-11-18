import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod'
import { agentLoop } from '../../../src/agent/index.ts'
import { ToolExecutionResult } from '../../../src/index.ts'
import { SessionStore } from '../../../src/session/index.ts'
import { ToolHistoryStore } from '../../../src/session/tool-history.ts'
import {
  archiveToolResults,
  ToolResultStore,
} from '../../../src/session/tool-results.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../../src/testing/faux.ts'
import { ToolRegistry } from '../../../src/tools/registry.ts'
import { TokenTracker } from '../../../src/usage/tracker.ts'
import { createTestBashTool, testBashTool } from '../../support/bash.ts'

const root = mkdtempSync(join(tmpdir(), 'vela-tool-history-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const read = async (store: ToolResultStore) =>
  (await Bun.file(store.indexPath).text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
const options = (toolCallId: string, abortSignal?: AbortSignal) => ({
  toolCallId,
  messages: [],
  context: {},
  abortSignal,
})

test('Registry persists begin before execute and stores native small results without changing inline output', async () => {
  const store = new ToolResultStore(join(root, 'small', 'outputs'))
  const registry = new ToolRegistry(store)
  const input = { command: 'example', content: '😀'.repeat(20000) }
  registry.register({
    name: 'inspect',
    description: '',
    inputSchema: z.object({}),
    execute: async () => {
      const records = await read(store)
      expect(records).toHaveLength(1)
      expect(records[0].input).toEqual(input)
      return { ok: true, value: 42 }
    },
  })
  const value = await registry.toAISDKFormat().inspect!.execute!(
    input,
    options('sdk-small'),
  )
  expect(JSON.parse(String(value))).toEqual({ ok: true, value: 42 })
  const records = await read(store)
  expect(records[1]).toMatchObject({
    type: 'tool_result',
    callId: records[0].callId,
    status: 'completed',
    output: { ok: true, value: 42 },
  })
})

test('native MCP errors and thrown errors are recorded without parsing preview strings', async () => {
  const store = new ToolResultStore(join(root, 'errors', 'outputs'))
  const registry = new ToolRegistry(store)
  const native = {
    isError: true,
    content: [{ type: 'text', text: 'remote problem' }],
    structuredContent: { reason: 7 },
  }
  registry.register(
    {
      name: 'mcp',
      description: '',
      inputSchema: z.object({}),
      execute: async () =>
        new ToolExecutionResult(native, 'remote problem', { isError: true }),
    },
    {
      name: 'throw',
      description: '',
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error('explicit failure')
      },
    },
  )
  // A native error is an error result for the model (like pi), and recorded as is
  await expect(
    registry.toAISDKFormat().mcp!.execute!({}, options('mcp')),
  ).rejects.toThrow('remote problem')
  await expect(
    registry.toAISDKFormat().throw!.execute!({}, options('throw')),
  ).rejects.toThrow('explicit failure')
  const records = await read(store)
  expect(records[1]).toMatchObject({
    status: 'failed',
    isError: true,
    output: native,
  })
  expect(records[3]).toMatchObject({
    status: 'failed',
    error: 'explicit failure',
  })
})

test('terminal storage failure on an inline result leaves only the begin record and prevents replay', async () => {
  const { mkdir, rename } = await import('node:fs/promises')
  const store = new ToolResultStore(join(root, 'broken', 'outputs'))
  const registry = new ToolRegistry(store)
  const backup = store.indexPath + '.backup'
  let executions = 0
  registry.register({
    name: 'short',
    description: '',
    inputSchema: z.object({}),
    execute: async () => {
      executions++
      await rename(store.indexPath, backup)
      await mkdir(store.indexPath)
      return 'completed'
    },
  })
  await expect(
    registry.toAISDKFormat().short!.execute!({}, options('one')),
  ).rejects.toThrow('ran, but saving its result failed')
  const records = (await Bun.file(backup).text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(records.map((record) => record.type)).toEqual(['tool_call'])
  await expect(
    registry.toAISDKFormat().short!.execute!({}, options('two')),
  ).rejects.toThrow()
  expect(executions).toBe(1)
})

test('begin storage failure prevents execution; rejection records preserve invalid inputs', async () => {
  const blocked = join(root, 'blocked')
  await Bun.write(blocked, 'occupied')
  const store = new ToolResultStore(join(root, 'preflight', 'outputs'))
  store.history = new ToolHistoryStore(join(blocked, 'history.jsonl'))
  const registry = new ToolRegistry(store)
  let executed = false
  registry.register({
    name: 'write',
    description: '',
    inputSchema: z.object({}),
    execute: async () => {
      executed = true
    },
  })
  await expect(
    registry.toAISDKFormat().write!.execute!({}, options('blocked')),
  ).rejects.toThrow()
  expect(executed).toBe(false)
  const other = new ToolRegistry(
    new ToolResultStore(join(root, 'rejected', 'outputs')),
  )
  await other.recordRejection(
    'missing_tool',
    'rejected',
    { important: 123 },
    new Error('not found'),
  )
  expect((await read(other.results))[1]).toMatchObject({
    status: 'rejected',
    error: 'not found',
  })
})

test('new sessions get separate histories; session resume reuses exact history and sequence', async () => {
  const session = new SessionStore('default', join(root, 'sessions'))
  const registry = new ToolRegistry(session.results)
  registry.register({
    name: 'one',
    description: '',
    inputSchema: z.object({}),
    execute: async () => 'saved',
  })
  await registry.toAISDKFormat().one!.execute!({}, options('one'))
  session.appendMessage({ role: 'user', content: 'hi' })
  await session.flush()
  const resumed = new SessionStore('default', join(root, 'sessions'))
  expect(resumed.results.historyId).not.toBe(session.results.historyId)
  await resumed.loadSaved()
  expect(resumed.results.indexPath).toBe(session.results.indexPath)
  expect(resumed.results.history.throughSequence).toBe(2)
  expect((await resumed.results.history.completed('one'))?.output).toBe('saved')
})

test('Bash cancellation persists status and original stdout', async () => {
  const results = new ToolResultStore(join(root, 'cancel', 'outputs'))
  const registry = new ToolRegistry(results)
  registry.register(createTestBashTool(root))
  const abort = new AbortController()
  const pending = registry.toAISDKFormat().bash!.execute!(
    { command: "printf 'BEFORE_CANCEL\\n'; touch ready; sleep 30 & wait" },
    options('cancel', abort.signal),
  )
  void Promise.resolve(pending).catch(() => {})
  try {
    const deadline = Date.now() + 3000
    while (
      !(await Bun.file(join(root, 'ready')).exists()) &&
      Date.now() < deadline
    )
      await Bun.sleep(10)
    expect(await Bun.file(join(root, 'ready')).exists()).toBe(true)
    abort.abort()
    await expect(Promise.resolve(pending)).rejects.toThrow(
      /BEFORE_CANCEL[\s\S]*Command aborted$/,
    )
    const [, result] = await read(results)
    expect(result).toMatchObject({ status: 'cancelled', isError: true })
    expect(result.output).toContain('BEFORE_CANCEL')
    expect(result.outputPath).toBeUndefined()
  } finally {
    abort.abort()
    await Promise.allSettled([pending])
  }
})

test('legacy references are indexed honestly without inventing call parameters', async () => {
  const file = join(root, 'old-result.txt')
  await Bun.write(file, 'old original')
  const store = new ToolResultStore(join(root, 'legacy', 'outputs'))
  await archiveToolResults(
    [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'old',
            toolName: 'bash',
            output: {
              type: 'json',
              value: {
                kind: 'vela-tool-result',
                path: file,
                indexPath: join(root, 'old-index.jsonl'),
                bytes: 12,
                preview: 'partial',
                read: 'read_file',
              },
            },
          },
        ],
      },
    ],
    store,
  )
  const records = await read(store)
  expect(records[0]).toMatchObject({
    type: 'legacy_result',
    outputPath: file,
    toolCallId: 'old',
  })
  expect(records[0].input).toBeUndefined()
})

test('SIGKILL after the start record leaves an unconfirmed call recoverable from the session', async () => {
  const session = new SessionStore('crash', join(root, 'crash-session'))
  session.appendMessage({ role: 'user', content: 'hi' })
  await session.flush()
  const modulePath = new URL(
    '../../../src/session/tool-history.ts',
    import.meta.url,
  ).pathname
  const script = `import {ToolHistoryStore} from ${JSON.stringify(modulePath)}; const history=new ToolHistoryStore(${JSON.stringify(session.results.indexPath)}); await history.begin("bash","crash-sdk",{command:"original operation"}); process.kill(process.pid,"SIGKILL");`
  const child = Bun.spawn(['bun', '-e', script], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(await child.exited).not.toBe(0)
  const restored = new SessionStore('crash', join(root, 'crash-session'))
  await restored.loadSaved()
  expect(restored.results.indexPath).toBe(session.results.indexPath)
  expect(await restored.results.history.completed('crash-sdk')).toBeUndefined()
  const records = await read(restored.results)
  expect(records).toHaveLength(1)
  expect(records[0].input.command).toBe('original operation')
})

test('AI SDK rejected tool calls are captured by the actual agent loop', async () => {
  const registry = new ToolRegistry(
    new ToolResultStore(join(root, 'sdk-rejected', 'outputs')),
  )
  registry.register({
    name: 'known',
    description: 'known',
    inputSchema: z.object({}),
    execute: async () => 'ok',
  })
  const model = createFauxModel({
    responses: [
      fauxToolCall('missing_tool', { important: 123 }, { id: 'invalid-sdk' }),
      fauxText('done'),
    ],
  })
  await agentLoop({
    model,
    systemPrompt: '',
    toolRegistry: registry,
    messages: [{ role: 'user', content: 'test' }],
    tokenTracker: new TokenTracker(),
  })
  const records = await read(registry.results)
  expect(records).toHaveLength(2)
  expect(records[0]).toMatchObject({
    type: 'tool_call',
    toolName: 'missing_tool',
    input: { important: 123 },
  })
  expect(records[1]).toMatchObject({
    type: 'tool_result',
    status: 'rejected',
    callId: records[0].callId,
  })
})

for (const kind of ['bash', 'generic'] as const) {
  test(`${kind}: terminal history failure keeps a durable output locator and blocks re-execution`, async () => {
    const { mkdir, rename, readdir } = await import('node:fs/promises')
    const results = new ToolResultStore(
      join(root, `terminal-${kind}`, 'outputs'),
    )
    const registry = new ToolRegistry(results)
    const backup = `${results.indexPath}.backup`
    let executions = 0
    registry.register({
      name: kind,
      description: 'terminal write failure regression',
      inputSchema:
        kind === 'bash' ? z.object({ command: z.string() }) : z.object({}),
      execute: async (_input, context) => {
        executions++
        const result =
          kind === 'bash'
            ? await testBashTool.execute(
                { command: "printf '%060000d\\n' 0; echo RECOVERY_EVIDENCE" },
                context,
              )
            : 'RECOVERY_EVIDENCE\n'.repeat(4000)
        await rename(results.indexPath, backup)
        await mkdir(results.indexPath)
        return result
      },
    })
    let failure: unknown
    try {
      await registry.toAISDKFormat()[kind]!.execute!(
        kind === 'bash'
          ? { command: "printf '%060000d\\n' 0; echo RECOVERY_EVIDENCE" }
          : {},
        options(`terminal-${kind}`),
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    const calls = (await Bun.file(backup).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const files = await readdir(results.dir)
    expect(calls).toHaveLength(1)
    expect(calls[0].type).toBe('tool_call')
    expect(files).toHaveLength(1)
    const outputPath = join(results.dir, files[0]!)
    expect(await Bun.file(outputPath).text()).toContain('RECOVERY_EVIDENCE')
    expect(calls[0].plannedOutputPath).toBeUndefined()
    expect(String(failure)).toContain('not pre-recorded')
    expect(String(failure)).toContain(outputPath)
    expect(String(failure)).toContain(calls[0].callId)
    expect(String(failure)).toContain('do not rerun it automatically')
    if (kind === 'bash') expect(String(failure)).toContain('exitCode=0')
    await expect(
      registry.toAISDKFormat()[kind]!.execute!({}, options('next')),
    ).rejects.toThrow()
    expect(executions).toBe(1)
    // Only the begin record survived. The session cannot confirm or replay this call.
    const restored = new ToolHistoryStore(backup)
    await restored.load()
    expect(await restored.completed(`terminal-${kind}`)).toBeUndefined()
    expect(await Bun.file(outputPath).text()).toContain('RECOVERY_EVIDENCE')
  })
}
