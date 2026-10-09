import { afterEach, expect, test } from 'bun:test'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('plain text reply streams, ends the loop and saves the session', async () => {
  const t = createTestVela({
    responses: [fauxText('Hi, this is Vela.')],
  })

  await t.run('hello')

  // Same shape as pi: message_start / message_update... / message_end around the streamed answer
  expect(t.eventTypes()).toEqual([
    'agent_start',
    'message_start',
    'message_end',
    'turn_start',
    'message_start',
    'message_update',
    'message_update',
    'message_update',
    'message_update',
    'message_update',
    'message_end',
    'usage',
    'turn_end',
    'agent_end',
    'agent_settled',
  ])
  expect(t.events[0]).toEqual({ type: 'agent_start', input: 'hello' })
  expect(t.eventsOf('message_end').map((e) => e.message.role)).toEqual([
    'user',
    'assistant',
  ])
  expect(
    t.eventsOf('message_update').map((e) => e.assistantMessageEvent.type),
  ).toEqual([
    'text_start',
    'text_delta',
    'text_delta',
    'text_delta',
    'text_end',
  ])
  expect(t.eventsOf('message_end')[1]).toEqual({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi, this is Vela.' }],
    },
    stopReason: 'stop',
  })
  expect(t.streamedText()).toBe('Hi, this is Vela.')
  expect(t.eventsOf('agent_end').at(-1)).toEqual({
    type: 'agent_end',
    messages: t.messages,
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

  // Like pi: the assistant message ends, then its tools run, then the tool results message
  expect(t.eventTypes().filter((type) => type !== 'message_update')).toEqual([
    'agent_start',
    'message_start',
    'message_end',
    'turn_start',
    'message_start',
    'message_end',
    'tool_execution_start',
    'tool_execution_end',
    'usage',
    'message_start',
    'message_end',
    'turn_end',
    'turn_start',
    'message_start',
    'message_end',
    'usage',
    'turn_end',
    'agent_end',
    'agent_settled',
  ])
  expect(
    t.eventsOf('message_end').map((e) => [e.message.role, e.stopReason]),
  ).toEqual([
    ['user', undefined],
    ['assistant', 'toolUse'],
    ['tool', undefined],
    ['assistant', 'stop'],
  ])
  expect(t.eventsOf('tool_execution_start')[0]).toMatchObject({
    toolName: 'read_file',
    args: { path: 'notes/a.txt' },
  })
  expect(t.eventsOf('tool_execution_end')[0]).toMatchObject({
    toolName: 'read_file',
    isError: false,
    durationMs: expect.any(Number),
  })
  expect(t.eventsOf('turn_end').map((e) => e.toolResults.length)).toEqual([
    1, 0,
  ])
  expect(t.lastAssistantText()).toBe('Got: hello')
  expect(t.messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
  ])
})
