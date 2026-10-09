import { afterEach, expect, test } from 'bun:test'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('plain text reply streams, ends the loop and saves the session', async () => {
  const t = createTestVela({
    responses: [fauxText('Hi, this is Vela.')],
  })

  await t.run('hello')

  expect(t.eventTypes()).toEqual([
    'agent_start',
    'message',
    'turn_start',
    'text_delta',
    'text_delta',
    'text_delta',
    'usage',
    'message',
    'turn_end',
    'agent_end',
    'agent_settled',
  ])
  expect(t.events[0]).toEqual({ type: 'agent_start', input: 'hello' })
  expect(t.eventsOf('message').map((e) => e.message.role)).toEqual([
    'user',
    'assistant',
  ])
  expect(t.streamedText()).toBe('Hi, this is Vela.')
  expect(t.eventsOf('agent_end').at(-1)).toEqual({
    type: 'agent_end',
    reason: 'done',
  })
  expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  expect(t.lastAssistantText()).toBe('Hi, this is Vela.')

  const session = await t.readData('sessions/default.jsonl')
  expect(session).toContain('Hi, this is Vela')
  expect(t.exists('usage/today.jsonl')).toBe(true)
})

test('the model receives the system prompt, the tool list and the user message', async () => {
  const t = createTestVela({ responses: [fauxText('ok')] })
  await t.run('What tools are there?')

  const [req] = t.model.calls
  expect(req!.kind).toBe('stream')
  expect(req!.lastUserText).toBe('What tools are there?')
  expect(req!.system.length).toBeGreaterThan(0)
  expect(req!.tools).toEqual(
    expect.arrayContaining(['read_file', 'bash', 'memory']),
  )
})

test('multi-turn: the second request carries the first exchange', async () => {
  const t = createTestVela({
    responses: [
      fauxText('Got it, your name is Sam.'),
      (req) => {
        const history = JSON.stringify(req.prompt)
        return fauxText(
          history.includes('My name is Sam')
            ? 'Your name is Sam.'
            : "I don't know.",
        )
      },
    ],
  })

  await t.run('My name is Sam')
  await t.run('What is my name?')

  expect(t.lastAssistantText()).toBe('Your name is Sam.')
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
          `Got: ${req.toolResults[0]?.output.includes('hello from a.txt') ? 'hello' : '??'}`,
        ),
    ],
  })

  await t.run('Read notes/a.txt')

  expect(t.eventTypes()).toEqual([
    'agent_start',
    'message',
    'turn_start',
    'tool_call',
    'tool_result',
    'usage',
    'message',
    'message',
    'turn_end',
    'turn_start',
    'text_delta',
    'text_delta',
    'usage',
    'message',
    'turn_end',
    'agent_end',
    'agent_settled',
  ])
  expect(t.eventsOf('message').map((e) => e.message.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
  ])
  expect(t.eventsOf('tool_call')[0]).toMatchObject({
    toolName: 'read_file',
    input: { path: 'notes/a.txt' },
  })
  expect(t.eventsOf('turn_end').map((e) => e.needsToolCall)).toEqual([
    true,
    false,
  ])
  expect(t.lastAssistantText()).toBe('Got: hello')
  expect(t.messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
  ])
})
