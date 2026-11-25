import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod'
import { openDatabase } from '../../../../src/db/index.ts'
import { agentLoop } from '../../../../src/driver/agent/index.ts'
import { summarize } from '../../../../src/driver/context/compressor.ts'
import { createRequestSnapshot } from '../../../../src/driver/context/request.ts'
import type { ModelMessage } from '../../../../src/driver/messages.ts'
import { SessionStore } from '../../../../src/driver/session/index.ts'
import { prepareCallResult } from '../../../../src/driver/tools/call-result.ts'
import { readFileTool } from '../../../../src/driver/tools/file.ts'
import { ToolRegistry } from '../../../../src/driver/tools/registry.ts'
import { createBashTool } from '../../../../src/driver/tools/shell.ts'
import {
  SpilledToolOutput,
  ToolExecutionResult,
} from '../../../../src/driver/tools/types.ts'
import { TokenTracker } from '../../../../src/driver/usage/tracker.ts'
import {
  createFauxModel,
  fauxSummary,
  fauxText,
  fauxToolCall,
} from '../../../../src/testing/core/faux.ts'
import { createTestBashTool, testBashTool } from '../../../support/bash.ts'

const EMPTY_TOOLS = { sdkTools: {}, toolDefinitions: [], hasHostedTools: false }
const dir = mkdtempSync(join(tmpdir(), 'vela-output-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const posixTest = process.platform === 'win32' ? test.skip : test

test('oversized result is saved to spillDir and can be paged with readFileTool', async () => {
  const raw = `${'head\n'.repeat(1000)}MIDDLE_EVIDENCE\n${'tail\n'.repeat(1000)}`
  const prepared = await prepareCallResult({
    raw,
    spillDir: join(dir, 'results'),
    maxResultChars: 3000,
  })
  const path = String(prepared.output).match(/Full output: (.+?);/)![1]!
  expect(await Bun.file(path).text()).toBe(raw)
  const page = await readFileTool.execute({ path, offset: 1001, limit: 1 })
  expect(String(page)).toContain('MIDDLE_EVIDENCE')
  expect(String(page)).toContain('offset=1002')
})

test('long Unicode lines can be continued without missing or splitting a character', async () => {
  const raw = '汉😀'.repeat(6000)
  const path = join(dir, 'unicode.txt')
  await Bun.write(path, raw)
  let column = 0
  let recovered = ''
  while (column < raw.length) {
    const page = String(
      await readFileTool.execute({ path, offset: 1, limit: 1, column }),
    )
    const body = page.split('\n\n[read:')[0]!
    expect(body.length).toBeGreaterThan(0)
    expect(body.isWellFormed()).toBe(true)
    recovered += body
    column += body.length
    if (column < raw.length) expect(page).toContain(`column=${column}`)
  }
  expect(recovered).toBe(raw)
})

test('storage failure returns a bounded warning without an unreadable reference', async () => {
  const path = join(dir, 'not-a-directory')
  await Bun.write(path, 'occupied')
  const prepared = await prepareCallResult({
    raw: 'x'.repeat(60_000),
    spillDir: path,
  })
  expect(String(prepared.output)).toContain('could not be saved')
  expect(String(prepared.output)).not.toContain('Full output:')
  expect(String(prepared.output).length).toBeLessThan(60_000)
})

test('real Bash captures large stdout and stderr with exit status and a bounded tail', async () => {
  const result = await testBashTool.execute(
    {
      command:
        "printf 'STDERR_EVIDENCE\\n' >&2; for ((i=0;i<15000;i++)); do printf '日志😀-%s\\n' \"$i\"; done; exit 7",
    },
    { spillDir: join(dir, 'bash-results') },
  )
  expect(result).toBeInstanceOf(SpilledToolOutput)
  const spilled = result as SpilledToolOutput
  const preview = spilled.preview
  const [, bytes, path] = preview.match(
    /of (\d+) bytes of output\. Full output: (.+)\]/,
  )!
  const raw = await Bun.file(path!).text()
  expect(Buffer.byteLength(raw)).toBe(Number(bytes))
  expect(raw).toContain('STDERR_EVIDENCE')
  expect(raw).toContain('日志😀-7500')
  expect(raw).toContain('日志😀-14999')
  expect(preview.startsWith('日志😀-13000\n')).toBe(true)
  expect(preview).toContain('日志😀-14999\n')
  expect(preview).toContain('[Showing the last 2000 lines of ')
  expect(preview.endsWith('Command exited with code 7')).toBe(true)
  expect(preview.isWellFormed()).toBe(true)
  expect(spilled.execution).toMatchObject({ exitCode: 7, isError: true })
})

test('small results stay inline and invalid read cursors fail clearly', async () => {
  const prepared = await prepareCallResult({
    raw: 'small',
    spillDir: join(dir, 'small-results'),
  })
  expect(prepared.output).toBe('small')
  expect(prepared.stored).toBeUndefined()
  const path = join(dir, 'short.txt')
  await Bun.write(path, 'hello')
  await expect(readFileTool.execute({ path, offset: 0 })).rejects.toThrow()
  await expect(readFileTool.execute({ path, offset: 3 })).rejects.toThrow(
    'past the end of the file',
  )
  await expect(readFileTool.execute({ path, column: 100 })).rejects.toThrow(
    'past the end of the file',
  )
})

test('compaction omits legacy Earlier tool output footer and persists in SQLite cleanly', async () => {
  const db = openDatabase({ path: ':memory:' })
  try {
    const summaryStore = new SessionStore('summary-results', db)
    const model = createFauxModel({ responses: [fauxSummary(), fauxSummary()] })
    const history: ModelMessage[] = [
      { role: 'user', content: 'old request' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'SUMMARY_EVIDENCE' }],
      },
      { role: 'user', content: 'recent' },
    ]
    for (const msg of history) summaryStore.appendMessage(msg)
    const compacted = await summarize(
      await createRequestSnapshot(model, 'stable', EMPTY_TOOLS, history),
      summaryStore,
      new TokenTracker(),
      500,
    )
    expect(compacted.compressedCount).toBe(2)
    expect(compacted.summary).not.toContain('Earlier tool output:')
    expect(compacted.summary).not.toContain('/snapshots/through-')
    summaryStore.appendCompaction(
      compacted.messages[0]!,
      compacted.summary,
      compacted.messages[1],
      0,
    )
    expect((await summaryStore.loadSaved())?.summary).toBe(compacted.summary)
  } finally {
    db.close()
  }
})

test('VelaDriver passes the spilled output reference to the next step and accepts a paged follow-up', async () => {
  const registry = new ToolRegistry(join(dir, 'sdk-results'))
  registry.register(readFileTool, {
    name: 'large',
    description: 'large',
    inputSchema: z.object({}),
    maxResultChars: 3000,
    execute: async () =>
      `${'header\n'.repeat(1000)}SDK_MIDDLE_EVIDENCE\n${'tail\n'.repeat(1000)}`,
  })
  const model = createFauxModel({
    responses: [
      fauxToolCall('large', {}),
      (req) => {
        const path =
          req.toolResults[0]!.output.match(/Full output: (.+?);/)![1]!
        return fauxToolCall('read', { path, offset: 1001, limit: 1 })
      },
      (req) => {
        expect(JSON.stringify(req.prompt)).toContain('SDK_MIDDLE_EVIDENCE')
        return fauxText('Recovered middle evidence.')
      },
    ],
  })
  const messages: ModelMessage[] = [
    { role: 'user', content: 'Find the middle evidence' },
  ]
  await agentLoop({
    model,
    systemPrompt: '',
    toolRegistry: registry,
    messages,
    tokenTracker: new TokenTracker(),
  })
  expect(model.calls).toHaveLength(3)
  expect(JSON.stringify(messages.at(-1))).toContain(
    'Recovered middle evidence.',
  )
})

test('short Bash output completes without reserving an output file', async () => {
  const blocked = join(dir, 'blocked-results')
  await Bun.write(blocked, 'not a directory')
  const marker = join(dir, 'must-not-exist')
  const output = await testBashTool.execute(
    { command: `touch '${marker}'` },
    { spillDir: blocked },
  )
  expect(output).toBeInstanceOf(ToolExecutionResult)
  expect(await Bun.file(marker).exists()).toBe(true)
})

test('Bash timeout preserves output already written to disk', async () => {
  const timeout = 2
  const result = await createTestBashTool().execute(
    {
      command: "printf '%060000d\\n' 0; printf 'BEFORE_TIMEOUT\\n'; sleep 20",
      timeout,
    },
    { spillDir: join(dir, 'timeout-results') },
  )
  expect(result).toBeInstanceOf(SpilledToolOutput)
  const stored = result as SpilledToolOutput
  expect(await Bun.file(stored.path).text()).toContain('BEFORE_TIMEOUT')
  expect(stored.preview).toContain('BEFORE_TIMEOUT')
  expect(stored.preview).toContain(`Command timed out after ${timeout} seconds`)
  expect(stored.execution).toMatchObject({ timedOut: true, isError: true })
})

test('Bash rejects an invalid timeout and reports a missing shell without running the command', async () => {
  const spillDir = join(dir, 'invalid-bash')
  for (const timeout of [0, -1, Number.POSITIVE_INFINITY, 3_000_000])
    await expect(
      createBashTool().execute({ command: 'true', timeout }, { spillDir }),
    ).rejects.toThrow(/Invalid timeout/)
  const result = await createBashTool(undefined, {
    shellPath: join(dir, 'no-such-shell'),
  }).execute({ command: 'true' }, { spillDir })
  if (!(result instanceof ToolExecutionResult))
    throw new Error('Expected an inline result')
  expect(result.text).toContain('The command did not run')
  expect(result.execution).toMatchObject({ isError: true })
})

test('Bash reports a missing working directory without disabling the shell', async () => {
  const missingDirectory = join(dir, 'missing-working-directory')
  const result = await createTestBashTool(missingDirectory).execute(
    { command: 'echo this must not run' },
    { spillDir: join(dir, 'missing-working-directory-results') },
  )
  if (!(result instanceof ToolExecutionResult))
    throw new Error('Expected an inline result')
  expect(result.text).toContain(
    `Working directory unavailable: ${missingDirectory}`,
  )
  expect(result.execution).toMatchObject({ isError: true })
})

posixTest('Bash runs commands with the configured shellPath', async () => {
  const result = await createBashTool(undefined, {
    shellPath: '/bin/sh',
  }).execute({ command: 'echo "$0"' }, { spillDir: join(dir, 'shell-path') })
  if (!(result instanceof ToolExecutionResult))
    throw new Error('Expected an inline result')
  expect(result.text.trim()).toBe('/bin/sh')
})
