import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelSpec, ThinkingLevel } from '@glows777/vela-core'
import { loadModels } from '@glows777/vela-core'
import { responsesReply } from '../support/responses.ts'
import { cleanupTestVelas, createTestVela, tempDir } from '../support/vela.ts'

const realFetch = globalThis.fetch
const dirs: { cleanup(): void }[] = []
afterEach(async () => {
  await cleanupTestVelas()
  globalThis.fetch = realFetch
  for (const dir of dirs.splice(0)) dir.cleanup()
})

function fixture(models?: ModelSpec[], reasoning?: 'text' | 'summary') {
  const dir = tempDir('vela-thinking-')
  dirs.push(dir)
  writeFileSync(
    join(dir.path, 'models.json'),
    JSON.stringify({
      providers: {
        compat: {
          api: 'openai-responses',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'test',
          models,
        },
      },
    }),
  )
  const requests: {
    reasoning?: { effort?: string }
    store?: boolean
    include?: string[]
    input: { role?: string }[]
  }[] = []
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    return responsesReply(body, reasoning)
  }) as typeof fetch
  return {
    cwd: dir.path,
    providers: loadModels({ agentDir: dir.path }),
    requests,
  }
}

test.each(['high', 'max', 'off'] as ThinkingLevel[])(
  'session thinking %s survives actual SDK serialization for a catalog model',
  async (thinkingLevel) => {
    const f = fixture()
    const t = createTestVela({
      ...f,
      model: 'compat/deepseek-flash',
      thinkingLevel,
    })
    await t.run('Answer OK')
    expect(t.lastAssistantText()).toBe('OK')
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]?.reasoning?.effort).toBe(
      thinkingLevel === 'off' ? 'none' : thinkingLevel,
    )
    expect(f.requests[0]?.input[0]?.role).toBe('system')
    expect(f.requests[0]?.store).toBe(false)
    expect(f.requests[0]?.include).toContain('reasoning.encrypted_content')
  },
)

test('stock medium is clamped to high before serialization', async () => {
  const f = fixture()
  const t = createTestVela({ ...f, model: 'compat/deepseek-flash' })
  expect(t.session.thinkingLevel).toBe('high')
  await t.run('Answer OK')
  expect(f.requests[0]?.reasoning?.effort).toBe('high')
})

test('custom medium mapping and resumed model/level reach the wire', async () => {
  const f = fixture([
    {
      id: 'deepseek-flash',
      thinkingLevelMap: { medium: 'medium', max: 'max' },
    },
  ])
  const first = createTestVela({ ...f, model: 'compat/deepseek-flash' })
  expect(first.session.thinkingLevel).toBe('medium')
  await first.run('Save medium')
  await first.cleanup()
  const again = createTestVela({
    ...f,
    model: 'compat/other',
    thinkingLevel: 'off',
  })
  expect(await again.session.resume()).toBe(true)
  expect(again.session.modelInfo.ref).toBe('compat/deepseek-flash')
  expect(again.session.thinkingLevel).toBe('medium')
  await again.run('Continue')
  expect(f.requests.map((r) => r.reasoning?.effort)).toEqual([
    'medium',
    'medium',
  ])
})

test.each(['text', 'summary'] as const)(
  'Responses reasoning %s deltas reach thinking events and the saved session',
  async (reasoning) => {
    const f = fixture(undefined, reasoning)
    const t = createTestVela({
      ...f,
      model: 'compat/deepseek-flash',
      thinkingLevel: 'high',
    })
    await t.run('Answer OK')
    const thinking = t
      .eventsOf('message_update')
      .flatMap((e) =>
        e.assistantMessageEvent.type === 'thinking_delta'
          ? [e.assistantMessageEvent.delta]
          : [],
      )
      .join('')
    expect(thinking).toBe('Check the result.')
    expect(t.lastAssistantText()).toBe('OK')
    const saved = (await t.readData('sessions/default.jsonl'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const assistant = saved
      .filter((entry) => entry.message?.role === 'assistant')
      .at(-1).message
    expect(assistant.content).toContainEqual(
      expect.objectContaining({ type: 'reasoning', text: thinking }),
    )
  },
)

test('DeepSeek reasoning preserves tool execution and the following answer', async () => {
  const f = fixture()
  const requests: {
    input: { type?: string; call_id?: string; output?: string }[]
  }[] = []
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    return responsesReply(
      body,
      'text',
      requests.length === 1
        ? { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) }
        : undefined,
    )
  }) as typeof fetch
  const t = createTestVela({
    ...f,
    model: 'compat/deepseek-flash',
    thinkingLevel: 'high',
    files: { 'a.txt': 'fixture content' },
  })
  await t.run('Read a.txt then answer OK')
  expect(t.eventsOf('tool_execution_start')).toHaveLength(1)
  expect(t.eventsOf('tool_execution_start')[0]).toMatchObject({
    toolName: 'read_file',
    args: { path: 'a.txt' },
  })
  expect(t.eventsOf('tool_execution_end')[0]?.isError).toBe(false)
  expect(requests).toHaveLength(2)
  expect(requests[1]?.input).toContainEqual(
    expect.objectContaining({
      type: 'function_call_output',
      call_id: 'call_test',
      output: expect.stringContaining('fixture content'),
    }),
  )
  expect(t.lastAssistantText()).toBe('OK')
})
