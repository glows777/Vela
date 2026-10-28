import { afterEach, expect, test } from 'bun:test'
import { APICallError } from '@ai-sdk/provider'
import {
  fauxError,
  fauxHang,
  fauxStreamError,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import z from 'zod'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('a 429 is retried and the turn then succeeds', async () => {
  const t = createTestVela({
    responses: [
      fauxError('429 Too Many Requests'),
      fauxError('503 overloaded'),
      fauxText('Finally worked'),
    ],
  })

  await t.run('hi')

  expect(
    t
      .eventsOf('auto_retry_start')
      .map((e) => [e.attempt, e.maxAttempts, e.errorMessage]),
  ).toEqual([
    [1, 3, '429 Too Many Requests'],
    [2, 3, '503 overloaded'],
  ])
  expect(t.eventsOf('auto_retry_end')).toEqual([
    { type: 'auto_retry_end', success: true, attempt: 2 },
  ])
  // Like pi: each failed attempt ends its (empty) assistant message as an error
  expect(
    t
      .eventsOf('message_end')
      .filter((e) => e.message.role === 'assistant')
      .map((e) => [e.stopReason, e.errorMessage]),
  ).toEqual([
    ['error', '429 Too Many Requests'],
    ['error', '503 overloaded'],
    ['stop', undefined],
  ])
  expect(t.lastAssistantText()).toBe('Finally worked')
  expect(t.eventsOf('agent_end').at(-1)).toMatchObject({
    type: 'agent_end',
    reason: 'done',
  })
  // A failed request leaves no partial message
  expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
})

test('a provider 429 whose message has no status code is still retried', async () => {
  const t = createTestVela({
    responses: [
      fauxError(
        new APICallError({
          message: 'Rate limit reached for requests',
          statusCode: 429,
          url: 'https://api.example.com/v1/chat/completions',
          requestBodyValues: {},
        }),
      ),
      fauxText('Worked'),
    ],
  })

  await t.run('hi')

  expect(t.eventsOf('auto_retry_start')).toHaveLength(1)
  expect(t.lastAssistantText()).toBe('Worked')
})

test('a stream that breaks midway is retried from scratch', async () => {
  const t = createTestVela({
    responses: [
      fauxStreamError('ECONNRESET', 'Half an ans'),
      fauxText('The full answer'),
    ],
  })

  await t.run('hi')

  expect(t.eventsOf('auto_retry_start')).toHaveLength(1)
  // Like pi: the broken attempt's text ends as a failed message (the TUI marks it), and the retry is a new message
  const assistantEnds = t
    .eventsOf('message_end')
    .filter((e) => e.message.role === 'assistant')
  expect(assistantEnds.map((e) => e.stopReason)).toEqual(['error', 'stop'])
  expect(JSON.stringify(assistantEnds[0]!.message)).toContain('Half an ans')
  expect(t.lastAssistantText()).toBe('The full answer')
  // The failed attempt is not in history
  expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  expect(JSON.stringify(t.messages)).not.toContain('Half an ans')
})

test('a 400 is not retried: the run fails and the user message stays in the saved session', async () => {
  const t = createTestVela({
    responses: [fauxError('400 Bad Request: invalid model')],
  })

  await expect(t.run('hi')).rejects.toThrow('400 Bad Request')

  expect(t.eventsOf('auto_retry_start')).toHaveLength(0)
  expect(t.eventsOf('agent_end').at(-1)).toMatchObject({
    type: 'agent_end',
    reason: 'error',
  })
  expect(t.session.busy.locked).toBe(false)
  expect(await t.readData('sessions/default.jsonl')).toContain('"hi"')
})

test('retries give up after maxRetries', async () => {
  const t = createTestVela({
    limits: { maxRetries: 2 },
    responses: [fauxError('500 a'), fauxError('500 b'), fauxError('500 c')],
  })

  await expect(t.run('hi')).rejects.toThrow('500 c')
  expect(t.eventsOf('auto_retry_start')).toHaveLength(2)
  expect(t.eventsOf('auto_retry_end')).toEqual([
    { type: 'auto_retry_end', success: false, attempt: 2, finalError: '500 c' },
  ])
  // The request never produced anything, so only the user message is in history
  expect(t.messages.map((m) => m.role)).toEqual(['user'])
})

test('a non-retryable error midway keeps the streamed text in the session but not in the context (like pi); the next prompt works', async () => {
  const t = createTestVela({
    responses: [
      fauxStreamError('400 Bad Request: content policy', 'Half an answer'),
      (req) =>
        fauxText(
          JSON.stringify(req.prompt).includes('Half an answer')
            ? 'resent'
            : 'not resent',
        ),
    ],
  })

  await expect(t.run('hi')).rejects.toThrow('400 Bad Request')
  const failed = t.eventsOf('message_end').at(-1)!
  expect(failed).toMatchObject({
    message: { role: 'assistant' },
    stopReason: 'error',
    errorMessage: '400 Bad Request: content policy',
  })
  expect(t.messages.map((m) => m.role)).toEqual(['user'])
  expect(t.session.getEntries().at(-1)).toMatchObject({
    type: 'message',
    stopReason: 'error',
    message: { content: [{ type: 'text', text: 'Half an answer' }] },
  })
  expect(t.eventsOf('turn_end')).toHaveLength(1)

  await t.run('go on')
  expect(t.lastAssistantText()).toBe('not resent')
})

test('a content-filtered response fails the run with the provider reason and keeps the streamed text', async () => {
  const t = createTestVela({
    responses: [
      { text: 'Half a filtered ans', finishReason: 'content-filter' },
      (req) =>
        fauxText(
          JSON.stringify(req.prompt).includes('Half a filtered ans')
            ? 'kept in context'
            : 'missing from context',
        ),
    ],
  })

  await expect(t.run('hi')).rejects.toThrow(
    'Provider stopped the response: content_filter',
  )

  const assistantEnd = t
    .eventsOf('message_end')
    .find((event) => event.message.role === 'assistant')!
  expect(assistantEnd).toMatchObject({
    stopReason: 'error',
    errorMessage: 'Provider stopped the response: content_filter',
  })
  expect(JSON.stringify(assistantEnd.message)).toContain('Half a filtered ans')
  expect(t.eventsOf('agent_end').at(-1)).toMatchObject({
    type: 'agent_end',
    reason: 'error',
    error: expect.objectContaining({
      message: 'Provider stopped the response: content_filter',
    }),
  })
  // A blocked response is final: no retry, and its turn still ends
  expect(t.eventsOf('auto_retry_start')).toHaveLength(0)
  expect(t.eventsOf('turn_end')).toHaveLength(t.eventsOf('turn_start').length)
  expect(t.session.busy.locked).toBe(false)
  expect(await t.readData('sessions/default.jsonl')).toContain(
    'Half a filtered ans',
  )

  // The text the provider streamed before filtering stays in the context
  await t.run('again')
  expect(t.lastAssistantText()).toBe('kept in context')
})

test('a response cut off by the output limit answers its tool calls with an error and continues (like pi)', async () => {
  const t = createTestVela({
    files: { 'a.txt': 'A' },
    responses: [
      {
        ...fauxToolCall('write_file', { path: 'a.txt', content: 'trunc' }),
        finishReason: 'length',
      },
      (req) => fauxText(`retrying: ${req.toolResults[0]!.output}`),
      fauxText('second prompt works'),
    ],
  })

  await t.run('write it')

  // The truncated call never ran
  expect(await t.readFile('a.txt')).toBe('A')
  expect(
    t.eventsOf('message_end').find((e) => e.message.role === 'assistant')
      ?.stopReason,
  ).toBe('length')
  expect(t.eventsOf('tool_execution_end')).toEqual([
    expect.objectContaining({ toolName: 'write_file', isError: true }),
  ])
  expect(t.messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
  ])
  expect(t.lastAssistantText()).toContain(
    'the response hit the output token limit',
  )
  // The session is still valid
  await t.run('again')
  expect(t.lastAssistantText()).toBe('second prompt works')
})

test('aborting while the model is streaming stops the run; the next run works', async () => {
  const t = createTestVela({
    responses: [fauxHang('Thinking'), fauxText('Second run works')],
  })

  const running = t.run('Take your time')
  while (!t.streamedText()) await Bun.sleep(1)
  t.session.abort()

  await expect(running).rejects.toThrow()
  expect(t.eventsOf('agent_end').at(-1)).toMatchObject({
    type: 'agent_end',
    reason: 'aborted',
  })
  expect(t.session.busy.locked).toBe(false)
  // Like pi: the text streamed before the abort is kept in the session, but not sent to the model again
  expect(t.eventsOf('message_end').at(-1)).toMatchObject({
    message: { role: 'assistant' },
    stopReason: 'aborted',
    errorMessage: 'Operation aborted',
  })
  expect(t.messages.map((m) => m.role)).toEqual(['user'])
  expect(t.session.getEntries().at(-1)).toMatchObject({
    type: 'message',
    stopReason: 'aborted',
    message: { content: [{ type: 'text', text: t.streamedText() }] },
  })
  expect(await t.readData('sessions/default.jsonl')).toContain('"aborted"')

  await t.run('Again')
  expect(t.lastAssistantText()).toBe('Second run works')
})

test('aborting while a tool runs cancels the tool and records it as cancelled', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('slow', {}),
      (req) =>
        fauxText(
          JSON.stringify(req.prompt).includes('Operation aborted')
            ? 'saw the abort'
            : 'missing',
        ),
    ],
  })
  let started!: () => void
  const toolStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  t.internals.registry.register({
    name: 'slow',
    description: 'slow',
    inputSchema: z.object({}),
    execute: (_input, context) =>
      new Promise<string>((resolve) => {
        started()
        context?.signal?.addEventListener(
          'abort',
          () => resolve('stopped early'),
          {
            once: true,
          },
        )
      }),
  })

  const running = t.run('Run a slow tool')
  await toolStarted
  // Like pi: the assistant message ends and tool_execution_start arrives while the tool is still running
  while (!t.eventTypes().includes('tool_execution_start')) await Bun.sleep(1)
  const types = t.eventTypes()
  expect(types.lastIndexOf('message_end')).toBeLessThan(
    types.indexOf('tool_execution_start'),
  )
  t.session.abort()

  await expect(running).rejects.toThrow()
  expect(t.eventsOf('agent_end').at(-1)).toMatchObject({
    type: 'agent_end',
    reason: 'aborted',
  })
  // The model was called only once: no new turn starts after an abort
  expect(t.model.calls).toHaveLength(1)
  const history = await Bun.file(t.session.registry.results.indexPath).text()
  expect(history).toContain('"status":"cancelled"')
  // Like pi: the call stays in history, answered with "Operation aborted", so the model knows it was cut short
  expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
  expect(t.eventsOf('tool_execution_end')).toEqual([
    expect.objectContaining({
      toolName: 'slow',
      isError: true,
      result: expect.any(Error),
    }),
  ])
  await t.run('what happened?')
  expect(t.lastAssistantText()).toBe('saw the abort')
})

test('a second run while one is in flight is refused', async () => {
  const t = createTestVela({ responses: [fauxHang()] })
  const running = t.run('first')
  await expect(t.run('second')).rejects.toThrow('A task is already running')
  while (t.model.calls.length === 0) await Bun.sleep(1)
  t.session.abort()
  await expect(running).rejects.toThrow()
})

const LOOP_NOTICE =
  'The same tool has been called 10 times with the same arguments. Change your approach instead of repeating it.'

test('the loop warning fires on the 10th identical call and is stored as a notice', async () => {
  const same = () => fauxToolCall('read_file', { path: 'a.txt' })
  const t = createTestVela({
    files: { 'a.txt': 'A' },
    responses: [...Array.from({ length: 10 }, same), fauxText('stop')],
  })

  await t.run('read a.txt')

  expect(t.eventsOf('loop_detected')).toEqual([
    {
      type: 'loop_detected',
      level: 'warning',
      detector: 'generic_repeat',
      message: LOOP_NOTICE,
    },
  ])
  expect(
    t.eventsOf('tool_execution_end').map((event) => event.toolCallId),
  ).toEqual(Array.from({ length: 10 }, (_, i) => `faux-call-${i + 1}-1`))
  const notice = t.messages[21]
  expect(t.messages.slice(19, 22).map((message) => message.role)).toEqual([
    'assistant',
    'tool',
    'user',
  ])
  expect(notice).toEqual({ role: 'user', content: LOOP_NOTICE })
  expect(JSON.stringify(t.messages[19]?.content)).toContain('faux-call-10-1')
  expect(t.session.customMessageOf(notice!)).toEqual({
    customType: 'loop',
    display: true,
  })
  expect(
    t.eventsOf('message_end').find((event) => event.message === notice),
  ).toEqual({
    type: 'message_end',
    message: { role: 'user', content: LOOP_NOTICE },
    custom: { customType: 'loop', display: true },
  })
  expect(
    t.session.getEntries().find((entry) => entry.type === 'custom_message'),
  ).toMatchObject({
    type: 'custom_message',
    customType: 'loop',
    content: LOOP_NOTICE,
    display: true,
  })
  expect(
    t.session
      .getEntries()
      .some(
        (entry) =>
          entry.type === 'message' &&
          JSON.stringify(entry.message).includes(LOOP_NOTICE),
      ),
  ).toBe(false)
  expect(t.model.calls).toHaveLength(11)
  expect(t.model.calls[10]?.lastUserText).toBe(LOOP_NOTICE)
  expect(t.lastAssistantText()).toBe('stop')
  expect(t.eventsOf('agent_end').at(-1)?.reason).toBe('done')

  const resumed = createTestVela({ cwd: t.cwd, responses: [fauxText('again')] })
  expect(await resumed.session.resume()).toBe(true)
  const restored = resumed.messages.find((message) =>
    resumed.session.customMessageOf(message),
  )
  expect(restored).toEqual({ role: 'user', content: LOOP_NOTICE })
  expect(resumed.session.customMessageOf(restored!)).toEqual({
    customType: 'loop',
    display: true,
  })
  await resumed.run('more')
  expect(resumed.lastAssistantText()).toBe('again')
  expect(JSON.stringify(resumed.model.calls[0]?.prompt)).toContain(LOOP_NOTICE)
})

test('repeating the same tool call trips the loop detector: warning, then critical stop', async () => {
  const same = () => fauxToolCall('list_directory', { path: '.' })
  const t = createTestVela({
    responses: Array.from({ length: 20 }, same),
  })

  await t.run('Keep listing the directory')

  const detections = t.eventsOf('loop_detected')
  expect(detections[0]).toMatchObject({
    level: 'warning',
    detector: 'generic_repeat',
    message: LOOP_NOTICE,
  })
  expect(detections.at(-1)).toMatchObject({ level: 'critical' })
  expect(t.eventsOf('agent_end').at(-1)).toMatchObject({
    type: 'agent_end',
    reason: 'loop',
  })
  const firstWarning = t.messages.findIndex(
    (message) => t.session.customMessageOf(message)?.customType === 'loop',
  )
  expect(
    t.messages.slice(firstWarning - 2, firstWarning).map((m) => m.role),
  ).toEqual(['assistant', 'tool'])
  expect(JSON.stringify(t.messages[firstWarning - 2]?.content)).toContain(
    'faux-call-10-1',
  )
  expect(t.model.calls).toHaveLength(20)
})

test('a critical loop stop keeps the stopping step in the history: the tool that ran has its call and result', async () => {
  const same = () => fauxToolCall('list_directory', { path: '.' })
  const t = createTestVela({ responses: Array.from({ length: 20 }, same) })

  await t.run('Keep listing the directory')

  expect(t.eventsOf('agent_end').at(-1)).toMatchObject({ reason: 'loop' })
  // The 20th call trips the critical stop, but its tool already ran
  const ran = t.eventsOf('tool_execution_end').map((e) => e.toolCallId)
  expect(ran).toContain('faux-call-20-1')
  // Every tool that ran has its assistant call and tool result in the session messages
  const json = (role: string) =>
    JSON.stringify(t.messages.filter((m) => m.role === role))
  for (const id of ran) {
    expect(json('assistant')).toContain(id)
    expect(json('tool')).toContain(id)
  }
  expect(t.messages.at(-1)?.role).toBe('tool')
  // The step's messages are emitted as message events before turn_end
  const types = t.eventTypes()
  expect(types.lastIndexOf('message_end')).toBeLessThan(
    types.lastIndexOf('turn_end'),
  )
  expect(types.lastIndexOf('turn_end')).toBeGreaterThan(
    types.lastIndexOf('tool_execution_end'),
  )
})

test('there is no turn limit: the loop runs until the model stops calling tools (same as pi)', async () => {
  const t = createTestVela({
    responses: [
      ...Array.from({ length: 20 }, (_, i) =>
        fauxToolCall('find', { pattern: `*${i}` }),
      ),
      fauxText('All done'),
    ],
  })

  await t.run('Keep working')

  expect(t.eventsOf('turn_start')).toHaveLength(21)
  expect(t.eventsOf('agent_end').at(-1)).toMatchObject({
    type: 'agent_end',
    reason: 'done',
  })
})

test('a request over maxInputTokens is stopped before it is sent', async () => {
  const t = createTestVela({ limits: { maxInputTokens: 10 }, responses: [] })
  await expect(t.run('hi')).rejects.toThrow('safe input size')
  expect(t.model.calls).toHaveLength(0)
})
