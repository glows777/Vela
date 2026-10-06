import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import type { VelaEvent } from '../../src/agent/events'
import { createVela, type Vela } from '../../src/app'

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}

function toolCallStep(toolName: string, input: unknown): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId: `call-${toolName}`,
      toolName,
      input: JSON.stringify(input),
    },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage,
    },
  ]
}

function textStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
  ]
}

/** 按顺序回放预设的流式响应；第 3 项会用更完整的 faux 模型替换它。 */
function scriptedModel(steps: LanguageModelV4StreamPart[][]) {
  let call = 0
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[call++]
      if (!chunks) throw new Error(`no scripted response for call ${call}`)
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
}

let cwd: string
let vela: Vela | undefined
afterEach(async () => {
  await vela?.dispose()
  vela = undefined
  rmSync(cwd, { recursive: true, force: true })
})

test('createVela runs a tool-calling turn end to end without a real model', async () => {
  cwd = mkdtempSync(join(tmpdir(), 'vela-e2e-'))
  writeFileSync(join(cwd, 'a.txt'), 'hello from a.txt\n')

  const events: VelaEvent[] = []
  const model = scriptedModel([
    toolCallStep('read_file', { path: 'a.txt' }),
    textStep('a.txt says hello'),
  ])
  vela = createVela({ model, cwd, onEvent: (e) => events.push(e) })

  await vela.run('read a.txt')

  // 工具按 cwd 解析相对路径，读到了临时目录里的文件
  const result = events.find((e) => e.type === 'tool_result')
  expect(result).toMatchObject({ type: 'tool_result', toolName: 'read_file' })
  expect(JSON.stringify(result)).toContain('hello from a.txt')

  expect(events.map((e) => e.type)).toEqual([
    'turn_start',
    'tool_call',
    'tool_result',
    'usage',
    'turn_end',
    'turn_start',
    'text_delta',
    'usage',
    'turn_end',
    'agent_end',
  ])
  expect(events.at(-1)).toEqual({ type: 'agent_end', reason: 'done' })

  const last = vela.messages.at(-1)
  expect(last?.role).toBe('assistant')
  expect(JSON.stringify(last?.content)).toContain('a.txt says hello')

  // 数据全部落在 dataDir（默认 = cwd）下
  expect(existsSync(join(cwd, '.sessions', 'default.jsonl'))).toBe(true)
  expect(existsSync(join(cwd, '.memory', 'MEMORY.md'))).toBe(true)
  expect(existsSync(join(cwd, '.usage', 'today.jsonl'))).toBe(true)
  expect(model.doStreamCalls).toHaveLength(2)
})

test('a resumed Vela sees the previous session', async () => {
  cwd = mkdtempSync(join(tmpdir(), 'vela-e2e-'))
  const first = createVela({ model: scriptedModel([textStep('first answer')]), cwd })
  await first.run('hi')
  await first.dispose()

  vela = createVela({ model: scriptedModel([]), cwd })
  expect(await vela.resume()).toBe(true)
  expect(vela.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
})

test('without an embedder, RAG tools are not registered', async () => {
  cwd = mkdtempSync(join(tmpdir(), 'vela-e2e-'))
  vela = createVela({ model: scriptedModel([]), cwd })
  const names = vela.registry.getAllTools().map((t) => t.name)
  expect(names).toContain('read_file')
  expect(names).not.toContain('rag_search')
})

test('file writes are reported as audit events instead of printed', async () => {
  cwd = mkdtempSync(join(tmpdir(), 'vela-e2e-'))
  const events: VelaEvent[] = []
  vela = createVela({
    model: scriptedModel([
      toolCallStep('write_file', { path: 'out.txt', content: 'hi' }),
      textStep('done'),
    ]),
    cwd,
    onEvent: (e) => events.push(e),
  })

  await vela.run('write out.txt')

  expect(events).toContainEqual({
    type: 'audit',
    toolName: 'write_file',
    path: 'out.txt',
  })
  expect(existsSync(join(cwd, 'out.txt'))).toBe(true)
})

test('a turn that exceeds the token budget still ends with turn_end', async () => {
  cwd = mkdtempSync(join(tmpdir(), 'vela-e2e-'))
  const events: VelaEvent[] = []
  const huge = {
    inputTokens: { total: 250_000, noCache: 250_000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  }
  const step = toolCallStep('list_directory', {}).map((part) =>
    part.type === 'finish' ? { ...part, usage: huge } : part,
  )
  vela = createVela({
    model: scriptedModel([step]),
    cwd,
    onEvent: (e) => events.push(e),
  })

  await vela.run('list files')

  const types = events.map((e) => e.type)
  expect(types.slice(-3)).toEqual(['budget_warning', 'turn_end', 'agent_end'])
  expect(events.at(-1)).toEqual({ type: 'agent_end', reason: 'budget' })
})
