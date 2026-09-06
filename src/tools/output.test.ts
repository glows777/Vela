import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod'
import type { ModelMessage, ToolResultPart } from 'ai'
import { generateText, stepCountIs } from 'ai'
import { ToolRegistry } from './registry'
import { readFileTool } from './file'
import { ToolResultStore, getStoredResult } from '../session/tool-results'
import { summarize } from '../context/compressor'
import { createRequestSnapshot } from '../context/request'
import { TokenTracker } from '../usage/tracker'
import { MockLanguageModelV4 } from 'ai/test'
import { SessionStore } from '../session'
import { bashTool } from './shell'

const dir = mkdtempSync(join(tmpdir(), 'vela-output-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('oversized result is saved before returning a preview and can be read through the registry', async () => {
  const registry = new ToolRegistry(new ToolResultStore(join(dir, 'results')))
  const raw =
    'head\n'.repeat(1000) + 'MIDDLE_EVIDENCE\n' + 'tail\n'.repeat(1000)
  registry.register(
    {
      name: 'large',
      description: 'large',
      inputSchema: z.object({}),
      execute: async () => raw,
    },
    readFileTool,
  )
  const tools = registry.toAISDKFormat()
  const result = await tools.large!.execute!(
    {},
    { toolCallId: 'large', messages: [], context: {} },
  )
  const stored = getStoredResult({ type: 'json', value: result as never })!
  expect(stored).toBeDefined()
  expect(await Bun.file(stored.path).text()).toBe(raw)
  const page = await tools.read_file!.execute!(
    { path: stored.path, offset: 1001, limit: 1 },
    { toolCallId: 'read', messages: [], context: {} },
  )
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
    const body = page.split('\n\n[read_file:')[0]!
    expect(body.length).toBeGreaterThan(0)
    expect(body.isWellFormed()).toBe(true)
    recovered += body
    column += body.length
    if (column < raw.length) expect(page).toContain(`column=${column}`)
  }
  expect(recovered).toBe(raw)
})

test('storage failure rejects the result instead of returning an unreadable reference', async () => {
  const path = join(dir, 'not-a-directory')
  await Bun.write(path, 'occupied')
  const registry = new ToolRegistry(new ToolResultStore(path))
  registry.register({
    name: 'large',
    description: 'large',
    inputSchema: z.object({}),
    execute: async () => 'x'.repeat(4000),
  })
  await expect(
    registry.toAISDKFormat().large!.execute!(
      {},
      { toolCallId: 'fail', messages: [], context: {} },
    ),
  ).rejects.toThrow('保存工具结果失败')
})

test('real Bash captures large stdout and stderr with exit status and a bounded tail', async () => {
  const registry = new ToolRegistry(
    new ToolResultStore(join(dir, 'bash-results')),
  )
  registry.register(bashTool)
  const result = await registry.toAISDKFormat().bash!.execute!(
    {
      command:
        "printf 'STDERR_EVIDENCE\\n' >&2; for ((i=0;i<15000;i++)); do printf '日志😀-%s\\n' \"$i\"; done; exit 7",
    },
    { toolCallId: 'bash', messages: [], context: {} },
  )
  const stored = getStoredResult({ type: 'json', value: result as never })!
  const raw = await Bun.file(stored.path).text()
  expect(raw).toContain('STDERR_EVIDENCE')
  expect(raw).toContain('日志😀-7500')
  expect(raw).toContain('日志😀-14999')
  expect(stored.preview).toContain('exit=7')
  expect(stored.preview.length).toBeLessThan(3200)
  expect(stored.preview.isWellFormed()).toBe(true)
})

test('small results stay inline and invalid read cursors fail clearly', async () => {
  const results = new ToolResultStore(join(dir, 'small-results'))
  const registry = new ToolRegistry(results)
  registry.register({
    name: 'small',
    description: 'small',
    inputSchema: z.object({}),
    execute: async () => 'small',
  })
  expect(
    await registry.toAISDKFormat().small!.execute!(
      {},
      { toolCallId: 'small', messages: [], context: {} },
    ),
  ).toBe('small')
  const records = (await Bun.file(results.indexPath).text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(records.map((record) => record.type)).toEqual([
    'tool_call',
    'tool_result',
  ])
  expect(records[1].output).toBe('small')
  const path = join(dir, 'short.txt')
  await Bun.write(path, 'hello')
  await expect(readFileTool.execute({ path, offset: 0 })).rejects.toThrow()
  await expect(readFileTool.execute({ path, offset: 3 })).rejects.toThrow(
    '超过文件范围',
  )
  await expect(readFileTool.execute({ path, column: 100 })).rejects.toThrow(
    '超过文件范围',
  )
})

test('summary keeps a readable index even if the summarizer omits every file reference', async () => {
  const results = new ToolResultStore(join(dir, 'summary-results'))
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const user = prompt.at(-1)
      const part =
        user?.role === 'user'
          ? user.content.find((part) => part.type === 'text')
          : undefined
      const control = JSON.parse(part?.type === 'text' ? part.text : '{}')
      const count = control.sourceMessageCount
      const quote = control.sourceCatalog[0].anchor
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              sourceMessageCount: count,
              goal: { sourceMessageIndex: 0, quote },
              completed: [
                {
                  sourceMessageIndex: 0,
                  quote,
                },
              ],
              pending: [],
              constraints: [],
              details: [],
            }),
          },
        ],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }
    },
  })
  const history: ModelMessage[] = [
    { role: 'user', content: 'old request' },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolName: 'bash',
          toolCallId: 'summary',
          output: { type: 'text', value: 'SUMMARY_EVIDENCE' },
        },
      ],
    },
    ...Array.from(
      { length: 6 },
      (): ModelMessage => ({ role: 'user', content: 'recent' }),
    ),
  ]
  const compacted = await summarize(
    await createRequestSnapshot(model, 'stable', {}, history),
    results,
    new TokenTracker(),
  )
  expect(compacted.compressedCount).toBe(2)
  expect(compacted.summary).toContain(
    results.history.snapshotPath(compacted.historyViewSequence!),
  )
  expect(String(compacted.messages[0]!.content)).toContain(
    '/snapshots/through-',
  )
  const entry = JSON.parse((await Bun.file(results.indexPath).text()).trim())
  expect(entry.type).toBe('legacy_result')
  expect(await Bun.file(entry.outputPath).text()).toBe('SUMMARY_EVIDENCE')
  const store = new SessionStore('summary', dir)
  await store.replace(compacted.messages, new Map(), compacted.summary)
  expect((await store.loadState()).summary).toContain('/snapshots/through-')
  const repeated = await summarize(
    await createRequestSnapshot(model, 'stable', {}, [
      ...compacted.messages,
      ...Array.from(
        { length: 6 },
        (): ModelMessage => ({ role: 'user', content: 'next' }),
      ),
    ]),
    results,
    new TokenTracker(),
  )
  expect(repeated.summary).toContain('/snapshots/through-')
})

test('AI SDK passes the saved reference to the next step and accepts a paged follow-up', async () => {
  const registry = new ToolRegistry(
    new ToolResultStore(join(dir, 'sdk-results')),
  )
  registry.register(readFileTool, {
    name: 'large',
    description: 'large',
    inputSchema: z.object({}),
    execute: async () =>
      'header\n'.repeat(1000) + 'SDK_MIDDLE_EVIDENCE\n' + 'tail\n'.repeat(1000),
  })
  let step = 0
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      step++
      const usage = {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      }
      if (step === 3) {
        expect(JSON.stringify(prompt)).toContain('SDK_MIDDLE_EVIDENCE')
        return {
          content: [{ type: 'text', text: 'Recovered middle evidence.' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage,
          warnings: [],
        }
      }
      let input = '{}'
      if (step === 2) {
        const toolMessage = prompt.find((message) => message.role === 'tool')
        if (!toolMessage || toolMessage.role !== 'tool')
          throw new Error('Missing tool result')
        const part = toolMessage.content[0]
        if (!part || part.type !== 'tool-result' || part.output.type !== 'json')
          throw new Error('Missing JSON reference')
        const reference = getStoredResult({
          type: 'json',
          value: part.output.value,
        })!
        expect(reference).toBeDefined()
        input = JSON.stringify({ path: reference.path, offset: 1001, limit: 1 })
      }
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `sdk-${step}`,
            toolName: step === 1 ? 'large' : 'read_file',
            input,
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage,
        warnings: [],
      }
    },
  })
  const result = await generateText({
    model,
    prompt: 'Find the middle evidence',
    tools: registry.toAISDKFormat(),
    stopWhen: stepCountIs(3),
  })
  expect(step).toBe(3)
  expect(result.text).toBe('Recovered middle evidence.')
})

test('Bash storage failure prevents command execution', async () => {
  const blocked = join(dir, 'blocked-results')
  await Bun.write(blocked, 'not a directory')
  const results = new ToolResultStore(blocked)
  const marker = join(dir, 'must-not-exist')
  await expect(
    bashTool.execute({ command: `touch '${marker}'` }, { results }),
  ).rejects.toThrow('保存工具结果失败')
  expect(await Bun.file(marker).exists()).toBe(false)
})

test('Bash timeout preserves output already written to disk', async () => {
  const result = await bashTool.execute(
    { command: "printf 'BEFORE_TIMEOUT\\n'; sleep 20" },
    { results: new ToolResultStore(join(dir, 'timeout-results')) },
  )
  const stored = getStoredResult({ type: 'json', value: result as never })!
  expect(await Bun.file(stored.path).text()).toContain('BEFORE_TIMEOUT')
  expect(stored.preview).toContain('signal=')
}, 15000)
