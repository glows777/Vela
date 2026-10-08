import { afterEach, expect, test } from 'bun:test'
import {
  fauxError,
  fauxHang,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

// Messages queued during a run (steer / followUp, as in pi). Faux response functions run when the request
// arrives, so queueing inside them deterministically simulates "the user typed again while the model was running".

test('steer is injected after the current step, before the next model request', async () => {
  const t = createTestVela({
    files: { 'a.txt': 'A' },
    responses: [
      () => {
        void t.session.steer('Read b instead')
        return fauxToolCall('read_file', { path: 'a.txt' })
      },
      fauxText('OK'),
    ],
  })

  await t.run('Read a')

  // Second request: the steer message follows right after the tool result
  expect(t.model.calls[1]!.lastUserText).toBe('Read b instead')
  expect(t.messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'user',
    'assistant',
  ])
  expect(t.eventsOf('agent_start')).toHaveLength(1)
  expect(t.eventsOf('queue_update')).toEqual([
    { type: 'queue_update', steering: ['Read b instead'], followUp: [] },
    { type: 'queue_update', steering: [], followUp: [] },
  ])
  expect(t.eventTypes().at(-1)).toBe('agent_settled')
})

test('a steer that arrives on the final answer keeps the loop going', async () => {
  const t = createTestVela({
    responses: [
      () => {
        void t.session.steer('Add one more line')
        return fauxText('First line')
      },
      fauxText('Second line'),
    ],
  })

  await t.run('Say something')

  expect(t.model.calls).toHaveLength(2)
  expect(t.lastAssistantText()).toBe('Second line')
  expect(t.eventsOf('agent_end')).toEqual([
    { type: 'agent_end', reason: 'done' },
  ])
})

test('followUp waits until the model would stop, then continues in the same loop (pi)', async () => {
  const t = createTestVela({
    files: { 'a.txt': 'A' },
    responses: [
      () => {
        void t.session.followUp('Then summarize')
        return fauxToolCall('read_file', { path: 'a.txt' })
      },
      fauxText('Done reading'),
      fauxText('Summary: A'),
    ],
  })

  await t.run('Read a')

  // followUp did not cut into the first task: the second request still sees the tool result
  expect(t.model.calls[1]!.toolResults).toHaveLength(1)
  expect(t.model.calls[2]!.lastUserText).toBe('Then summarize')
  expect(t.eventsOf('agent_start').map((e) => e.input)).toEqual(['Read a'])
  expect(t.eventsOf('agent_end')).toEqual([
    { type: 'agent_end', reason: 'done' },
  ])
  expect(
    t.eventTypes().filter((type) => type === 'agent_settled'),
  ).toHaveLength(1)
  expect(t.lastAssistantText()).toBe('Summary: A')
})

test('one-at-a-time takes one queued steer per step; all takes them together', async () => {
  const t = createTestVela({
    responses: [
      () => {
        void t.session.steer('one')
        void t.session.steer('two')
        return fauxText('a')
      },
      fauxText('b'),
      fauxText('c'),
      () => {
        void t.session.steer('three')
        void t.session.steer('four')
        return fauxText('d')
      },
      fauxText('e'),
    ],
  })

  await t.run('Start')
  expect(t.model.calls.map((c) => c.lastUserText)).toEqual(['Start', 'one', 'two'])

  t.session.steeringMode = 'all'
  await t.run('Again')
  expect(t.model.calls.at(-1)!.prompt.slice(-2)).toMatchObject([
    { role: 'user', content: [{ type: 'text', text: 'three' }] },
    { role: 'user', content: [{ type: 'text', text: 'four' }] },
  ])
})

test('prompt() while running needs a streamingBehavior; with one it queues', async () => {
  const t = createTestVela({ responses: [fauxHang('Thinking')] })
  const running = t.run('Think slowly')
  while (!t.streamedText()) await Bun.sleep(1)

  await expect(t.session.prompt('Interject')).rejects.toThrow('steer()')
  await t.session.prompt('Interject', { streamingBehavior: 'followUp' })
  expect(t.session.queue).toEqual({ steering: [], followUp: ['Interject'] })

  // Clear the queue before interrupting (as TUI / RPC do); abort waits until it really stops
  expect(t.session.clearQueue()).toEqual({ steering: [], followUp: ['Interject'] })
  await t.session.abort()
  expect(t.session.isRunning).toBe(false)
  await expect(running).rejects.toThrow()
  expect(t.eventTypes().at(-1)).toBe('agent_settled')
})

test('abort stops the task and leaves queued messages in the queue', async () => {
  const t = createTestVela({ responses: [fauxHang('Thinking')] })
  const running = t.run('Think slowly')
  while (!t.streamedText()) await Bun.sleep(1)
  await t.session.followUp('Do this later')

  await t.session.abort()

  await expect(running).rejects.toThrow()
  expect(t.model.calls).toHaveLength(1)
  expect(t.session.queue.followUp).toEqual(['Do this later'])
})

test('queued messages still run after the task fails; prompt() then rejects with the failure', async () => {
  const t = createTestVela({
    responses: [
      () => {
        void t.session.followUp('Different question')
        return fauxError('400 Bad Request')
      },
      fauxText('OK'),
    ],
  })

  await expect(t.run('Bad request')).rejects.toThrow('400 Bad Request')

  expect(t.eventsOf('agent_end').map((e) => e.reason)).toEqual([
    'error',
    'done',
  ])
  expect(t.lastAssistantText()).toBe('OK')
})

test('steer and followUp on an idle session behave like prompt()', async () => {
  const t = createTestVela({ responses: [fauxText('one'), fauxText('two')] })

  await t.session.steer('Hello')
  await t.session.followUp('Bye')

  expect(t.model.calls.map((c) => c.lastUserText)).toEqual(['Hello', 'Bye'])
})

test('thinking text from the model is streamed as thinking_delta', async () => {
  const t = createTestVela({
    responses: [{ reasoning: 'Let me think first', text: 'Answer' }],
  })

  await t.run('Question')

  expect(
    t
      .eventsOf('thinking_delta')
      .map((e) => e.text)
      .join(''),
  ).toBe('Let me think first')
  expect(t.streamedText()).toBe('Answer')
})

test('an extension command can abort the running task without waiting on itself', async () => {
  const t = createTestVela({
    responses: [fauxHang('Thinking')],
    extensions: [
      (vela) =>
        vela.registerCommand('stop', {
          handler: async (_args, ctx) => {
            await ctx.session.abort()
            ctx.ui.notify('stopped')
          },
        }),
    ],
  })
  const running = t.run('Think slowly')
  while (!t.streamedText()) await Bun.sleep(1)

  await t.run('/stop')

  await expect(running).rejects.toThrow()
  expect(t.eventsOf('notify').map((e) => e.message)).toEqual(['stopped'])
})

test('messages cannot be queued while a non-prompt task (compact) holds the session', async () => {
  const t = createTestVela({
    responses: [fauxText('one'), fauxText('two'), fauxText('three'), fauxText('four')],
    generate: [fauxHang()],
    // Compaction may be interrupted before it sends the summary request
    allowPendingResponses: true,
  })
  for (const q of ['1', '2', '3', '4']) await t.run(q)
  const compacting = t.session.compact()
  expect(t.session.isRunning).toBe(true)

  await expect(t.session.steer('Cut in')).rejects.toThrow('A task is already running')
  await t.session.abort()
  await expect(compacting).rejects.toThrow()
})
