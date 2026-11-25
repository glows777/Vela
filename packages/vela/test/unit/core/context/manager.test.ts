import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ContextManager,
  createRequestSnapshot,
} from '../../../../src/driver/context/manager.ts'
import type { ModelMessage } from '../../../../src/driver/messages.ts'
import { SessionStore } from '../../../../src/driver/session/index.ts'
import { TokenTracker } from '../../../../src/driver/usage/tracker.ts'
import { resolveProviderTools } from '../../../../src/providers/index.ts'
import {
  createFauxModel,
  fauxSummary,
  fauxText,
  fauxToolCall,
} from '../../../../src/testing/core/faux.ts'

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
            type: 'tool_call',
            toolCallId: `c${i}`,
            toolName: 'read',
            input: { path: `f${i}` },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolCallId: `c${i}`,
            toolName: 'read',
            output: {
              type: 'text',
              value: `evidence-${i}\n${'x'.repeat(size)}`,
            },
          },
        ],
      },
    ]).flat(),
  ]
}
const EMPTY_TOOLS = { sdkTools: {}, toolDefinitions: [], hasHostedTools: false }
const model = createFauxModel()

test('prepare() syncs estimate below capacity without modifying history or running summary mid-turn', async () => {
  const store = new SessionStore('age', dir)
  const messages = history(2, 50)
  const timestamps = new Map(messages.map((m) => [m, Date.now() - 86400000]))
  const tracker = new TokenTracker()
  tracker.setContextDelta(25)
  const manager = new ContextManager(store, tracker, {
    messages,
    timestamps,
    summary: '',
  })
  const before = JSON.stringify(messages)
  await manager.prepare(
    await createRequestSnapshot(model, 'stable', EMPTY_TOOLS, messages),
  )
  expect(JSON.stringify(messages)).toBe(before)
  // P2 #5: pre-API setEstimatedTokens preserves extension contextHookDeltaTokens
  expect(tracker.contextDelta).toBe(25)
})

/** Summary model: by default produces a structured free-text summary; with '' it returns empty text. */
function summaryModel(text?: string) {
  return createFauxModel({
    responses: [text === undefined ? fauxSummary() : fauxText(text)],
  })
}

test('compactIfNeeded() compacts earlier history post-turn and persists compaction summary usage', async () => {
  const m = summaryModel()
  const messages = history(10, 16000)
  messages[0] = {
    role: 'user',
    content: `preserved decisions\n${'x'.repeat(440000)}`,
  }
  messages.push(
    ...Array.from(
      { length: 6 },
      (): ModelMessage => ({ role: 'user', content: 'recent' }),
    ),
  )
  const dbPath = join(dir, 'summary.db')
  const store = new SessionStore('summary', dbPath)
  for (const message of messages) store.appendMessage(message)
  const tracker = new TokenTracker((rec) => store.recordUsageRecord(rec))
  const manager = new ContextManager(store, tracker, {
    messages,
    timestamps: new Map(),
    summary: '',
  })
  const request = await createRequestSnapshot(
    m,
    'stable',
    EMPTY_TOOLS,
    messages,
  )
  // Mid-turn prepare() does not compact threshold automatically so prompt cache prefixes hold.
  await manager.prepare(request)
  expect(m.calls).toHaveLength(0)

  const compacted = await manager.compactIfNeeded(request)
  expect(compacted).toBe(true)
  expect(m.calls).toHaveLength(1)
  expect(JSON.stringify(m.calls[0]!.prompt)).not.toContain(
    'tool result preview omitted',
  )
  expect(manager.state.summary).toContain('preserved decisions')
  expect(manager.state.summary).not.toContain('Earlier tool output:')
  await manager.save()
  expect((await new SessionStore('summary', dbPath).loadSaved())?.summary).toBe(
    manager.state.summary,
  )
  expect(tracker.recent(1)[0]!.kind).toBe('summary')
})

test('summary cannot execute tools and rejected summary leaves original history', async () => {
  let executions = 0
  const { ToolRegistry } = await import(
    '../../../../src/driver/tools/registry.ts'
  )
  const z = (await import('zod')).default
  const registry = new ToolRegistry()
  registry.register({
    name: 'write',
    description: 'write',
    inputSchema: z.object({}),
    execute: async () => {
      executions++
      return 'oops'
    },
  })
  const m = createFauxModel({
    responses: [fauxToolCall('write', EMPTY_TOOLS, { id: 'bad' })],
  })
  const messages: ModelMessage[] = [
    { role: 'user', content: 'x'.repeat(650000) },
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
    manager.compactIfNeeded(
      createRequestSnapshot(
        m,
        'stable',
        await resolveProviderTools(m, registry.toProviderTools()),
        messages,
      ),
    ),
  ).rejects.toThrow('tool calls')
  expect(executions).toBe(0)
  expect(JSON.stringify(messages)).toBe(before)
  expect(manager.state.summary).toBe('unchanged')
  expect(m.calls).toHaveLength(1)
})

test('a request with nothing to summarize skips compaction cleanly', async () => {
  const m = summaryModel()
  const messages: ModelMessage[] = [
    { role: 'user', content: 'x'.repeat(520000) },
  ]
  const manager = new ContextManager(
    new SessionStore('stop', dir),
    new TokenTracker(),
    { messages, timestamps: new Map(), summary: '' },
  )
  const request = await createRequestSnapshot(
    m,
    'stable',
    EMPTY_TOOLS,
    messages,
  )
  const before = JSON.stringify(messages)
  await manager.prepare(request, { allowSummary: false })
  expect(m.calls).toHaveLength(0)
  await manager.compactIfNeeded(request)
  expect(m.calls).toHaveLength(0)
  expect(JSON.stringify(messages)).toBe(before)
  messages[0] = { role: 'user', content: 'x'.repeat(800000) }
  await manager.compactIfNeeded(
    await createRequestSnapshot(m, 'stable', EMPTY_TOOLS, messages),
  )
  expect(m.calls).toHaveLength(0)
})

test('empty summary is rejected without changing the live summary or messages', async () => {
  const m = summaryModel('')
  const messages: ModelMessage[] = [
    { role: 'user', content: 'x'.repeat(650000) },
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
    manager.compactIfNeeded(
      await createRequestSnapshot(m, 'stable', EMPTY_TOOLS, messages),
    ),
  ).rejects.toThrow('Summary was not fully generated')
  expect(JSON.stringify(messages)).toBe(before)
  expect(manager.state.summary).toBe('keep this')
})
