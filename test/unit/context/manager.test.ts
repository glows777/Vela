import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelMessage, ToolResultPart } from 'ai'
import { planMicrocompact } from '../../../src/context/compressor.ts'
import {
  ContextManager,
  createRequestSnapshot,
} from '../../../src/context/manager.ts'
import { SessionStore } from '../../../src/session/index.ts'
import { getStoredResult } from '../../../src/session/tool-results.ts'
import {
  createFauxModel,
  fauxSummary,
  fauxText,
  fauxToolCall,
} from '../../../src/testing/faux.ts'
import { TokenTracker } from '../../../src/usage/tracker.ts'

const dir = mkdtempSync(join(tmpdir(), 'vela-context-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
function history(count: number, size: number): ModelMessage[] {
  return [
    { role: 'user', content: 'inspect' },
    ...Array.from({ length: count }, (_, i): ModelMessage[] => [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: `c${i}`,
            toolName: 'read_file',
            input: { path: `f${i}` },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: `c${i}`,
            toolName: 'read_file',
            output: {
              type: 'text',
              value: `evidence-${i}\n` + 'x'.repeat(size),
            },
          },
        ],
      },
    ]).flat(),
  ]
}
const model = createFauxModel()

test('old timestamps do not change history or create files below capacity', async () => {
  const store = new SessionStore('age', dir)
  const messages = history(2, 50)
  const timestamps = new Map(messages.map((m) => [m, Date.now() - 86400000]))
  const manager = new ContextManager(store, new TokenTracker(), {
    messages,
    timestamps,
    summary: '',
  })
  const before = JSON.stringify(messages)
  await manager.prepare(
    await createRequestSnapshot(model, 'stable', {}, messages),
  )
  expect(JSON.stringify(messages)).toBe(before)
  expect(await Bun.file(store.results.indexPath).exists()).toBe(false)
})

test('micro protects five completed calls even when results share one message', async () => {
  const messages = history(8, 25000)
  const calls = messages.filter((m) => m.role === 'assistant')
  const results = messages
    .filter((m) => m.role === 'tool')
    .flatMap((m) => m.content) as ToolResultPart[]
  const mixed: ModelMessage[] = [
    messages[0]!,
    ...calls,
    { role: 'tool', content: results },
  ]
  const store = new SessionStore('mixed', dir)
  const plan = planMicrocompact(mixed, store.results)
  expect(plan.candidates.map((c) => c.toolCallId)).toEqual(['c0', 'c1', 'c2'])
  const parts = plan.messages.at(-1)!.content as ToolResultPart[]
  expect(getStoredResult(parts[0]!.output)).toBeDefined()
  expect(parts.slice(3)).toEqual(results.slice(3))
})

/** Summary model: by default produces a valid quote-based summary; with '' it returns empty text. */
function summaryModel(text?: string) {
  return createFauxModel({
    responses: [text === undefined ? fauxSummary() : fauxText(text)],
  })
}

test('micro commits once, keeps references across restart and is idempotent', async () => {
  const store = new SessionStore('micro', dir)
  const messages = history(10, 41000)
  const manager = new ContextManager(store, new TokenTracker(), {
    messages,
    timestamps: new Map(),
    summary: 'old summary',
  })
  await manager.prepare(
    await createRequestSnapshot(model, 'stable', {}, messages),
  )
  const references = messages
    .filter((m) => m.role === 'tool')
    .flatMap((m) => m.content)
    .filter((p) => p.type === 'tool-result' && getStoredResult(p.output))
  expect(references).toHaveLength(5)
  const first = references[0] as ToolResultPart
  expect(await Bun.file(getStoredResult(first.output)!.path).text()).toContain(
    'evidence-0',
  )
  const index = await Bun.file(store.results.indexPath).text()
  await manager.prepare(
    await createRequestSnapshot(model, 'stable', {}, messages),
  )
  expect(await Bun.file(store.results.indexPath).text()).toBe(index)
  const restored = await new SessionStore('micro', dir).loadState()
  expect(restored.messages).toEqual(messages)
  expect(restored.summary).toBe('old summary')
})

test('low net savings does not clear even above the micro trigger', async () => {
  const store = new SessionStore('little', dir)
  const messages = history(8, 2000)
  messages.unshift({ role: 'user', content: 'x'.repeat(400000) })
  const manager = new ContextManager(store, new TokenTracker(), {
    messages,
    timestamps: new Map(),
    summary: '',
  })
  const before = JSON.stringify(messages)
  await manager.prepare(
    await createRequestSnapshot(model, 'stable', {}, messages),
  )
  expect(JSON.stringify(messages)).toBe(before)
  expect(await Bun.file(store.results.indexPath).exists()).toBe(false)
})

test('duplicates, unmatched, excluded and errors are not candidates', () => {
  const messages = history(10, 25000)
  const error = messages[2]!.content as ToolResultPart[]
  error[0] = {
    ...error[0]!,
    output: { type: 'error-text', value: 'failed'.repeat(5000) },
  }
  const duplicate = messages[4]!
  messages.splice(5, 0, duplicate)
  const excludedCall = (messages[6]!.content as { toolName: string }[])[0]!
  const excludedResult = (messages[7]!.content as { toolName: string }[])[0]!
  excludedCall.toolName = 'memory'
  excludedResult.toolName = 'memory'
  const plan = planMicrocompact(
    messages,
    new SessionStore('exclude', dir).results,
  )
  expect(
    plan.candidates.some((c) => ['c0', 'c1', 'c2'].includes(c.toolCallId)),
  ).toBe(false)
})

test('summary chosen directly when a profitable micro still leaves >=150k', async () => {
  const m = summaryModel()
  const messages = history(10, 16000)
  messages[0] = {
    role: 'user',
    content: 'preserved decisions\n' + 'x'.repeat(440000),
  }
  messages.push(
    ...Array.from(
      { length: 6 },
      (): ModelMessage => ({ role: 'user', content: 'recent' }),
    ),
  )
  const store = new SessionStore('summary', dir)
  const tracker = new TokenTracker()
  const manager = new ContextManager(store, tracker, {
    messages,
    timestamps: new Map(),
    summary: '',
  })
  await manager.prepare(await createRequestSnapshot(m, 'stable', {}, messages))
  expect(m.calls).toHaveLength(1)
  expect(JSON.stringify(m.calls[0]!.prompt)).not.toContain(
    'tool result preview omitted',
  )
  expect(manager.state.summary).toContain('preserved decisions')
  expect(manager.state.summary).toContain('/snapshots/through-')
  expect(store.results.historyViewSequence).toBeDefined()
  expect((await store.loadState()).summary).toBe(manager.state.summary)
  expect(tracker.recent(1)[0]!.kind).toBe('summary')
})

test('summary cannot execute tools and rejected summary leaves original history', async () => {
  let executions = 0
  const { ToolRegistry } = await import('../../../src/tools/registry.ts')
  const z = (await import('zod')).default
  const registry = new ToolRegistry()
  registry.register({
    name: 'write_file',
    description: 'write',
    inputSchema: z.object({}),
    execute: async () => {
      executions++
      return 'oops'
    },
  })
  const m = createFauxModel({
    responses: [fauxToolCall('write_file', {}, { id: 'bad' })],
  })
  const messages: ModelMessage[] = [
    { role: 'user', content: 'x'.repeat(510000) },
    { role: 'assistant', content: 'old' },
    ...Array.from(
      { length: 6 },
      (): ModelMessage => ({ role: 'user', content: 'recent' }),
    ),
  ]
  const manager = new ContextManager(
    new SessionStore('bad-summary', dir),
    new TokenTracker(),
    { messages, timestamps: new Map(), summary: 'unchanged' },
  )
  const before = JSON.stringify(messages)
  await expect(
    manager.prepare(
      await createRequestSnapshot(
        m,
        'stable',
        registry.toAISDKFormat(),
        messages,
      ),
    ),
  ).rejects.toThrow('tool calls')
  expect(executions).toBe(0)
  expect(JSON.stringify(messages)).toBe(before)
  expect(manager.state.summary).toBe('unchanged')
  expect(m.calls).toHaveLength(1)
})

test('debug never generates a paid summary; oversized input and missing boundary stop safely', async () => {
  const m = summaryModel()
  const messages: ModelMessage[] = [
    { role: 'user', content: 'x'.repeat(520000) },
  ]
  const manager = new ContextManager(
    new SessionStore('stop', dir),
    new TokenTracker(),
    { messages, timestamps: new Map(), summary: '' },
  )
  const request = await createRequestSnapshot(m, 'stable', {}, messages)
  await manager.prepare(request, { allowSummary: false })
  expect(m.calls).toHaveLength(0)
  await expect(manager.prepare(request)).rejects.toThrow('split point')
  messages[0] = { role: 'user', content: 'x'.repeat(650000) }
  messages.push(
    ...Array.from(
      { length: 7 },
      (): ModelMessage => ({ role: 'user', content: 'x'.repeat(20000) }),
    ),
  )
  await expect(
    manager.prepare(await createRequestSnapshot(m, 'stable', {}, messages)),
  ).rejects.toThrow('safe input size')
  expect(m.calls).toHaveLength(0)
})

test('checkpoint failure does not commit a cleared in-memory view', async () => {
  const { spyOn } = await import('bun:test')
  const store = new SessionStore('atomic', dir)
  const messages = history(10, 41000)
  const tracker = new TokenTracker()
  const manager = new ContextManager(store, tracker, {
    messages,
    timestamps: new Map(),
    summary: 'before',
  })
  await manager.save()
  const original = JSON.stringify(messages)
  const failure = spyOn(store, 'replace').mockRejectedValue(
    new Error('disk failure'),
  )
  try {
    await expect(
      manager.prepare(
        await createRequestSnapshot(model, 'stable', {}, messages),
      ),
    ).rejects.toThrow('disk failure')
    expect(JSON.stringify(messages)).toBe(original)
    expect(manager.state.summary).toBe('before')
  } finally {
    failure.mockRestore()
  }
  expect((await store.loadState()).messages).toEqual(messages)
})

test('empty summary is rejected without changing the live summary or messages', async () => {
  const m = summaryModel('')
  const messages: ModelMessage[] = [
    { role: 'user', content: 'x'.repeat(510000) },
    ...Array.from(
      { length: 7 },
      (): ModelMessage => ({ role: 'user', content: 'retained' }),
    ),
  ]
  const manager = new ContextManager(
    new SessionStore('empty', dir),
    new TokenTracker(),
    { messages, timestamps: new Map(), summary: 'keep this' },
  )
  const before = JSON.stringify(messages)
  await expect(
    manager.prepare(await createRequestSnapshot(m, 'stable', {}, messages)),
  ).rejects.toThrow('Summary was not fully generated')
  expect(JSON.stringify(messages)).toBe(before)
  expect(manager.state.summary).toBe('keep this')
})
