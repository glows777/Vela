import { afterEach, expect, test } from 'bun:test'
import { fauxText, fauxToolCall } from '../../src/testing/faux'
import { cleanupTestVelas, createTestVela } from '../support/vela'

afterEach(cleanupTestVelas)

test('plain text reply streams, ends the loop and saves the session', async () => {
  const t = createTestVela({
    responses: [fauxText('你好，我是 Vela。有什么可以帮你？')],
  })

  await t.run('你好')

  expect(t.eventTypes()).toEqual([
    'turn_start',
    'text_delta',
    'text_delta',
    'text_delta',
    'usage',
    'turn_end',
    'agent_end',
  ])
  expect(t.streamedText()).toBe('你好，我是 Vela。有什么可以帮你？')
  expect(t.events.at(-1)).toEqual({ type: 'agent_end', reason: 'done' })
  expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  expect(t.lastAssistantText()).toBe('你好，我是 Vela。有什么可以帮你？')

  const session = await t.readData('.sessions/default.jsonl')
  expect(session).toContain('你好，我是 Vela')
  expect(t.exists('.usage/today.jsonl')).toBe(true)
})

test('the model receives the system prompt, the tool list and the user message', async () => {
  const t = createTestVela({ responses: [fauxText('ok')] })
  await t.run('看看有哪些工具')

  const [req] = t.model.calls
  expect(req!.kind).toBe('stream')
  expect(req!.lastUserText).toBe('看看有哪些工具')
  expect(req!.system.length).toBeGreaterThan(0)
  expect(req!.tools).toEqual(
    expect.arrayContaining(['read_file', 'bash', 'memory']),
  )
})

test('multi-turn: the second request carries the first exchange', async () => {
  const t = createTestVela({
    responses: [
      fauxText('记住了，你叫小明。'),
      (req) => {
        const history = JSON.stringify(req.prompt)
        return fauxText(
          history.includes('我叫小明') ? '你叫小明。' : '我不知道。',
        )
      },
    ],
  })

  await t.run('我叫小明')
  await t.run('我叫什么？')

  expect(t.lastAssistantText()).toBe('你叫小明。')
  expect(t.messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant',
  ])
  expect(t.model.calls).toHaveLength(2)
})

test('a tool call is executed relative to cwd and its result goes back to the model', async () => {
  const t = createTestVela({
    files: { 'notes/a.txt': 'hello from a.txt\n' },
    responses: [
      fauxToolCall('read_file', { path: 'notes/a.txt' }),
      (req) =>
        fauxText(
          `文件内容：${req.toolResults[0]?.output.includes('hello from a.txt') ? 'hello' : '??'}`,
        ),
    ],
  })

  await t.run('读一下 notes/a.txt')

  expect(t.eventTypes()).toEqual([
    'turn_start',
    'tool_call',
    'tool_result',
    'usage',
    'turn_end',
    'turn_start',
    'text_delta',
    'text_delta',
    'usage',
    'turn_end',
    'agent_end',
  ])
  expect(t.eventsOf('tool_call')[0]).toMatchObject({
    toolName: 'read_file',
    input: { path: 'notes/a.txt' },
  })
  expect(t.eventsOf('turn_end').map((e) => e.needsToolCall)).toEqual([
    true,
    false,
  ])
  expect(t.lastAssistantText()).toBe('文件内容：hello')
  expect(t.messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
  ])
})
