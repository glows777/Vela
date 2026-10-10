import { afterEach, expect, test } from 'bun:test'
import type { ExtensionAPI, VelaSession } from '@glows777/vela'
import { z } from 'zod'
import {
  type FauxRequest,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

/** The conversation a request sent, one `role: text` line per message (tool parts by name). */
function transcript(req: FauxRequest): string[] {
  return req.prompt
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const parts = message.content as {
        type: string
        text?: string
        toolName?: string
      }[]
      return `${message.role}: ${parts
        .map((part) => part.text ?? `[${part.type} ${part.toolName ?? ''}]`)
        .join('')}`
    })
}

// ---------- sendMessage / appendEntry ----------

test('sendMessage while idle appends a custom message the model sees as a user message', async () => {
  const t = createTestVela({ responses: [fauxText('noted')] })
  await t.session.sendMessage({
    customType: 'build',
    content: 'The build finished',
    display: true,
    details: { ok: true },
  })
  // Appended only: no model call, no agent loop
  expect(t.model.calls).toHaveLength(0)
  expect(t.eventTypes()).toEqual(['message_start', 'message_end'])
  expect(t.eventsOf('message_end')[0]!.custom).toEqual({
    customType: 'build',
    display: true,
    details: { ok: true },
  })

  await t.run('What happened?')
  expect(transcript(t.model.calls[0]!)).toEqual([
    'user: The build finished',
    'user: What happened?',
  ])
  await t.session.save()
  const entries = t.session.getEntries()
  expect(entries.find((e) => e.type === 'custom_message')).toMatchObject({
    customType: 'build',
    content: 'The build finished',
    display: true,
    details: { ok: true },
  })
})

test('sendMessage with triggerTurn runs the agent loop with the message as its input', async () => {
  const t = createTestVela({
    responses: [(req) => fauxText(`Seen: ${req.lastUserText}`)],
  })
  await t.session.sendMessage(
    { customType: 'job', content: 'Job 7 is done', display: false },
    { triggerTurn: true },
  )
  expect(t.lastAssistantText()).toBe('Seen: Job 7 is done')
  expect(t.eventsOf('agent_start')[0]!.input).toBe('Job 7 is done')
  expect(t.session.customMessageOf(t.messages[0]!)).toEqual({
    customType: 'job',
    display: false,
  })
})

test('nextTurn messages go after the next user message; before_agent_start can add one too', async () => {
  function ext(vela: ExtensionAPI) {
    vela.on('before_agent_start', (event) => ({
      message: {
        customType: 'recall',
        content: `Recalled for: ${event.prompt}`,
        display: false,
      },
    }))
  }
  const t = createTestVela({
    extensions: [ext],
    responses: [fauxText('a'), fauxText('b')],
  })
  await t.session.sendMessage(
    { customType: 'hint', content: 'A hint', display: false },
    { deliverAs: 'nextTurn' },
  )
  expect(t.messages).toEqual([])
  await t.run('first')
  expect(transcript(t.model.calls[0]!)).toEqual([
    'user: first',
    'user: A hint',
    'user: Recalled for: first',
  ])
  await t.run('second')
  expect(transcript(t.model.calls[1]!).slice(-2)).toEqual([
    'user: second',
    'user: Recalled for: second',
  ])
})

test('while running, a non-triggering message waits for the tool results; a triggering one is steered', async () => {
  let session: VelaSession | undefined
  function ext(vela: ExtensionAPI) {
    vela.on('session_start', (_event, ctx) => {
      session = ctx.session
    })
    vela.registerTool({
      name: 'work',
      description: 'Does work',
      inputSchema: z.object({}),
      execute: async () => {
        await session!.sendMessage(
          {
            customType: 'log',
            content: 'Logged while working',
            display: false,
          },
          { triggerTurn: false },
        )
        await session!.sendMessage({
          customType: 'note',
          content: 'Steered note',
          display: true,
        })
        return 'worked'
      },
    })
  }
  const t = createTestVela({
    extensions: [ext],
    responses: [fauxToolCall('ext_work', {}), fauxText('done')],
  })
  await t.run('Do the work')
  // The pending message lands after the tool result (never between a tool call and its result),
  // the steered one after it, both before the next request
  expect(transcript(t.model.calls[1]!)).toEqual([
    'user: Do the work',
    'assistant: [tool-call ext_work]',
    'tool: [tool-result ext_work]',
    'user: Logged while working',
    'user: Steered note',
  ])
  // Queued custom messages are not listed as queued user input
  expect(t.eventsOf('queue_update').every((e) => e.steering.length === 0)).toBe(
    true,
  )
})

test('custom messages and entries survive a resume; entries never reach the model', async () => {
  const t = createTestVela({ responses: [fauxText('ok')] })
  t.session.appendEntry('counter', { count: 3 })
  await t.session.sendMessage({
    customType: 'note',
    content: [{ type: 'text', text: 'Saved note' }],
    display: true,
  })
  await t.run('hi')
  await t.cleanup({ keepDir: true })

  const resumed = createTestVela({ cwd: t.cwd, responses: [fauxText('again')] })
  expect(await resumed.session.resume()).toBe(true)
  const entries = resumed.session.getEntries()
  expect(entries.find((e) => e.type === 'custom')).toMatchObject({
    customType: 'counter',
    data: { count: 3 },
  })
  const note = resumed.messages[0]!
  expect(note).toEqual({
    role: 'user',
    content: [{ type: 'text', text: 'Saved note' }],
  })
  expect(resumed.session.customMessageOf(note)).toEqual({
    customType: 'note',
    display: true,
  })
  await resumed.run('more')
  expect(transcript(resumed.model.calls[0]!)).toEqual([
    'user: Saved note',
    'user: hi',
    'assistant: ok',
    'user: more',
  ])
  expect(JSON.stringify(resumed.model.calls[0]!.prompt)).not.toContain(
    'counter',
  )
})

test('a custom message alone starts the session file; earlier entries are written with it', async () => {
  const first = createTestVela()
  first.session.appendEntry('state', { n: 1 })
  await first.session.save()
  // Extension state alone is not a conversation (like pi)
  expect(first.exists('sessions/default.jsonl')).toBe(false)
  await first.session.sendMessage({
    customType: 'note',
    content: 'Saved note',
    display: false,
  })
  await first.cleanup({ keepDir: true })

  const second = createTestVela({ cwd: first.cwd })
  expect(await second.session.resume()).toBe(true)
  expect(
    second.session
      .getEntries()
      .filter((e) => e.type === 'custom' || e.type === 'custom_message')
      .map((e) => e.type),
  ).toEqual(['custom', 'custom_message'])
  expect(second.messages).toEqual([{ role: 'user', content: 'Saved note' }])
})

test('sendMessage and appendEntry reject a missing customType', async () => {
  const t = createTestVela()
  expect(() => t.session.appendEntry('')).toThrow('customType')
  await expect(
    t.session.sendMessage({
      customType: ' ',
      content: 'x',
      display: false,
    }),
  ).rejects.toThrow('customType')
})

test('while running, deliverAs followUp waits until the model would stop', async () => {
  let session: VelaSession | undefined
  function ext(vela: ExtensionAPI) {
    vela.on('session_start', (_event, ctx) => {
      session = ctx.session
    })
    vela.registerTool({
      name: 'work',
      description: 'Does work',
      inputSchema: z.object({}),
      execute: async () => {
        await session!.sendMessage(
          { customType: 'later', content: 'Follow-up note', display: false },
          { deliverAs: 'followUp' },
        )
        return 'worked'
      },
    })
  }
  const t = createTestVela({
    extensions: [ext],
    responses: [fauxToolCall('ext_work', {}), fauxText('done'), fauxText('ok')],
  })
  await t.run('Do the work')
  // Not added after the tool result: only once the model answered without tool calls
  expect(transcript(t.model.calls[1]!).at(-1)).toBe(
    'tool: [tool-result ext_work]',
  )
  expect(transcript(t.model.calls[2]!).slice(-2)).toEqual([
    'assistant: done',
    'user: Follow-up note',
  ])
})

test('an invalid before_agent_start message fails the prompt before agent_start and keeps nextTurn messages', async () => {
  let bad = true
  function ext(vela: ExtensionAPI) {
    vela.on('before_agent_start', () =>
      bad
        ? { message: { customType: '', content: 'x', display: false } }
        : undefined,
    )
  }
  const t = createTestVela({ extensions: [ext], responses: [fauxText('ok')] })
  await t.session.sendMessage(
    { customType: 'hint', content: 'A hint', display: false },
    { deliverAs: 'nextTurn' },
  )
  await expect(t.session.prompt('first')).rejects.toThrow('customType')
  expect(t.eventsOf('agent_start')).toHaveLength(0)
  expect(t.messages).toEqual([])
  bad = false
  await t.run('second')
  expect(transcript(t.model.calls[0]!)).toEqual([
    'user: second',
    'user: A hint',
  ])
})

// ---------- context / input ----------

test('context handlers change what a request sends, not the history', async () => {
  function ext(vela: ExtensionAPI) {
    vela.on('context', (event) => {
      event.messages.push({ role: 'user', content: 'Injected per request' })
      const first = event.messages[0]!
      if (typeof first.content === 'string') first.content = 'Rewritten'
    })
    vela.on('context', (event) => ({
      messages: event.messages.filter((m) => m.content !== 'drop me'),
    }))
  }
  const t = createTestVela({
    extensions: [ext],
    responses: [fauxText('one'), fauxText('two')],
  })
  await t.run('drop me')
  expect(transcript(t.model.calls[0]!)).toEqual([
    'user: Rewritten',
    'user: Injected per request',
  ])
  await t.run('second')
  expect(t.messages.map((m) => m.content)).toEqual([
    'drop me',
    [{ type: 'text', text: 'one' }],
    'second',
    [{ type: 'text', text: 'two' }],
  ])
})

test('input handlers transform or handle input, after extension commands and before templates', async () => {
  const seen: string[] = []
  function ext(vela: ExtensionAPI) {
    vela.registerCommand('ping', {
      handler: (_args, ctx) => ctx.ui.notify('pong'),
    })
    vela.on('input', (event) => {
      seen.push(`${event.source}:${event.text}`)
      if (event.text === 'skip') return { action: 'handled' }
      if (event.text.startsWith('shout '))
        return { action: 'transform', text: event.text.slice(6).toUpperCase() }
    })
    vela.on('input', (event) => {
      seen.push(`second:${event.text}`)
    })
  }
  const t = createTestVela({
    extensions: [ext],
    responses: [(req) => fauxText(req.lastUserText), fauxText('ext')],
  })
  await t.run('/ping')
  await t.run('skip')
  await t.session.prompt('shout hello', { source: 'interactive' })
  await t.session.sendUserMessage('from an extension')
  // /ping ran as a command without input handlers; `skip` stopped at the first handler
  expect(seen).toEqual([
    'sdk:skip',
    'interactive:shout hello',
    'second:HELLO',
    'extension:from an extension',
    'second:from an extension',
  ])
  expect(t.model.calls.map((c) => c.lastUserText)).toEqual([
    'HELLO',
    'from an extension',
  ])
})

test('sendUserMessage is not expanded as a prompt template', async () => {
  const t = createTestVela({
    files: { '.vela/prompts/greet.md': 'Hello $1 from the template' },
    responses: [(req) => fauxText(req.lastUserText)],
  })
  await t.session.sendUserMessage('/greet Liam')
  expect(t.model.calls[0]!.lastUserText).toBe('/greet Liam')
})

// ---------- provider hooks ----------

test('provider hooks see and change requests, response headers and raw stream chunks', async () => {
  const headers: Record<string, string>[] = []
  const raw: unknown[] = []
  function ext(vela: ExtensionAPI) {
    vela.on('before_provider_request', (event) => {
      event.params.headers = { ...event.params.headers, 'x-trace': 'abc' }
    })
    vela.on('before_provider_request', (event) => ({
      ...event.params,
      maxOutputTokens: 123,
    }))
    vela.on('after_provider_response', (event) => {
      headers.push(event.headers)
    })
    vela.on('provider_stream_event', (event) => {
      raw.push(event.data)
      expect(event.provider).toBe('faux')
    })
  }
  const t = createTestVela({
    extensions: [ext],
    responses: [fauxText('streamed answer')],
  })
  await t.run('hi')
  expect(t.model.calls[0]!.headers).toMatchObject({ 'x-trace': 'abc' })
  expect(headers).toEqual([{ 'x-faux-request': '1' }])
  expect(raw.length).toBeGreaterThan(0)
  // Raw chunks were requested for the hook only: the answer streams as usual
  expect(t.lastAssistantText()).toBe('streamed answer')
  expect(t.streamedText()).toBe('streamed answer')
})

test('without provider_stream_event handlers no raw chunks are requested', async () => {
  const t = createTestVela({ responses: [fauxText('plain')] })
  await t.run('hi')
  expect(t.lastAssistantText()).toBe('plain')
})

// ---------- nested tool calls ----------

test('tool_call and tool_result carry parentToolCallId for calls made through ctx.executeTool', async () => {
  const calls: [string, string | undefined, string | undefined][] = []
  function ext(vela: ExtensionAPI) {
    vela.registerTool({
      name: 'outer',
      description: 'Reads a file through another tool',
      inputSchema: z.object({}),
      execute: async (_input, ctx) => {
        const result = await ctx!.executeTool!('read_file', { path: 'a.txt' })
        return result.isError ? 'failed' : 'read'
      },
    })
    vela.on('tool_call', (event) => {
      calls.push(['call', event.toolName, event.parentToolCallId])
    })
    vela.on('tool_result', (event) => {
      calls.push(['result', event.toolName, event.parentToolCallId])
    })
  }
  const t = createTestVela({
    extensions: [ext],
    files: { 'a.txt': 'hello' },
    responses: [fauxToolCall('ext_outer', {}), fauxText('done')],
  })
  await t.run('go')
  const outerId = t.eventsOf('tool_execution_start')[0]!.toolCallId
  expect(calls).toEqual([
    ['call', 'ext_outer', undefined],
    ['call', 'read_file', outerId],
    ['result', 'read_file', outerId],
    ['result', 'ext_outer', undefined],
  ])
})
