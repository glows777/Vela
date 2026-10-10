import { afterEach, expect, test } from 'bun:test'
import z from 'zod'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { ToolExecutionResult } from '../../src/tools/registry.ts'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('several tool calls in one response all run and all results go back together', async () => {
  const t = createTestVela({
    files: {
      'src/a.ts': 'export const a = 1\n',
      'src/b.ts': 'export const b = 2\n',
    },
    responses: [
      [
        fauxToolCall('find', { pattern: 'src/*.ts' }),
        fauxToolCall('grep', { pattern: 'export const', path: 'src' }),
        fauxToolCall('read_file', { path: 'src/b.ts' }),
      ],
      fauxText('Found a and b'),
    ],
  })

  await t.run('What is in src?')

  expect(t.eventsOf('tool_execution_start').map((e) => e.toolName)).toEqual([
    'find',
    'grep',
    'read_file',
  ])
  expect(
    t.eventsOf('tool_execution_end').filter((e) => !e.isError),
  ).toHaveLength(3)
  const second = t.model.calls[1]!
  expect(second.toolResults.map((r) => r.toolName).sort()).toEqual([
    'find',
    'grep',
    'read_file',
  ])
  expect(
    second.toolResults.find((r) => r.toolName === 'read_file')!.output,
  ).toContain('export const b = 2')
  expect(t.messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
  ])
})

test('write_file writes into cwd and is reported as an audit event; edit_file changes it', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('write_file', {
        path: 'out/hello.txt',
        content: 'hello world\n',
      }),
      fauxToolCall('edit_file', {
        path: 'out/hello.txt',
        edits: [{ oldText: 'world', newText: 'vela' }],
      }),
      fauxText('Done writing'),
    ],
  })

  await t.run('Write a file')

  expect(await t.readFile('out/hello.txt')).toBe('hello vela\n')
  expect(t.eventsOf('audit').map((e) => [e.toolName, e.path])).toEqual([
    ['write_file', 'out/hello.txt'],
    ['edit_file', 'out/hello.txt'],
  ])
  expect(t.eventsOf('tool_execution_end').filter((e) => e.isError)).toEqual([])
})

test('bash runs in cwd and its output carries the timestamp post-hook', async () => {
  const t = createTestVela({
    files: { 'marker.txt': 'here' },
    responses: [
      fauxToolCall('bash', { command: 'ls && echo BASH_OK' }),
      fauxText('ok'),
    ],
  })

  await t.run('Run a command')

  const output = t.model.calls[1]!.toolResults[0]!.output
  expect(output).toContain('marker.txt')
  expect(output).toContain('BASH_OK')
  expect(output).toMatch(/\[\d{4}-\d{2}-\d{2}T[^\]]+Z\]\\n/)
})

test('a dangerous bash command is refused before it runs and the model sees why', async () => {
  const t = createTestVela({
    files: { 'keep.txt': 'important' },
    responses: [
      fauxToolCall('bash', { command: 'rm -rf /' }),
      fauxText('OK, not deleting'),
    ],
  })

  await t.run('Clean up')

  expect(await t.readFile('keep.txt')).toBe('important')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain(
    '[Rejected] Dangerous operation detected',
  )
  expect(t.eventsOf('agent_end').at(-1)).toMatchObject({
    type: 'agent_end',
    reason: 'done',
  })
})

test('a tool that throws becomes a tool error the model can react to', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('read_file', { path: 'missing.txt' }),
      fauxText('The file does not exist'),
    ],
  })

  await t.run('Read missing.txt')

  expect(
    t.eventTypes().filter((type) => type.startsWith('tool_execution')),
  ).toEqual(['tool_execution_start', 'tool_execution_end'])
  expect(t.eventsOf('tool_execution_end')[0]).toMatchObject({
    toolName: 'read_file',
    isError: true,
  })
  const result = t.model.calls[1]!.toolResults[0]!
  expect(result.toolName).toBe('read_file')
  expect(result.raw).toMatchObject({ type: 'error-text' })
  expect(result.output).toContain('ENOENT')
  expect(t.lastAssistantText()).toBe('The file does not exist')
  expect(t.eventsOf('agent_end').at(-1)).toMatchObject({
    type: 'agent_end',
    reason: 'done',
  })
})

test('an unknown tool and invalid arguments are rejected without crashing the loop', async () => {
  const t = createTestVela({
    responses: [
      [
        fauxToolCall('no_such_tool', { x: 1 }),
        fauxToolCall('read_file', { wrong: 'shape' }),
      ],
      fauxText('Trying another way'),
    ],
  })

  await t.run('Try it')

  expect(
    t
      .eventsOf('tool_execution_end')
      .filter((e) => e.isError)
      .map((e) => e.toolName)
      .sort(),
  ).toEqual(['no_such_tool', 'read_file'])
  expect(t.model.calls[1]!.toolResults).toHaveLength(2)
  expect(t.eventsOf('agent_end').at(-1)).toMatchObject({
    type: 'agent_end',
    reason: 'done',
  })
  // Rejected calls are also written to the tool history
  const history = await Bun.file(t.session.registry.results.indexPath).text()
  expect(history).toContain('no_such_tool')
  expect(history).toContain('"status":"rejected"')
})

test('a deferred tool only reaches the model after tool_search discovers it', async () => {
  const t = createTestVela({
    responses: [
      (req) => {
        expect(req.tools).not.toContain('mcp__fake__lookup')
        expect(req.system).toContain('mcp__fake__lookup')
        return fauxToolCall('tool_search', { query: 'mcp__fake__lookup' })
      },
      (req) => {
        expect(req.tools).toContain('mcp__fake__lookup')
        return fauxToolCall('mcp__fake__lookup', { id: '42' })
      },
      (req) => fauxText(`Found: ${req.toolResults[0]!.output}`),
    ],
  })
  t.internals.registry.register({
    name: 'mcp__fake__lookup',
    description: '[MCP:fake] look something up',
    inputSchema: z.object({ id: z.string() }),
    exposure: 'deferred',
    execute: async ({ id }: { id: string }) => `record ${id}`,
  })

  await t.run('Look up 42')

  expect(t.lastAssistantText()).toBe('Found: record 42')
})

test('a guest cannot use bash: the call is refused and recorded', async () => {
  const t = createTestVela({
    responses: [
      (req) => {
        // A guest does not get bash, but the model may still call it from history
        expect(req.tools).not.toContain('bash')
        return fauxToolCall('bash', { command: 'echo hi' })
      },
      fauxText('No permission'),
    ],
  })
  await captureConsole(() => t.dispatch('/role guest'))

  await t.run('Run echo')

  expect(
    t.eventsOf('tool_execution_end').filter((e) => !e.isError),
  ).toHaveLength(0)
  expect(
    t.eventsOf('tool_execution_end').filter((e) => e.isError),
  ).toHaveLength(1)
  expect(t.lastAssistantText()).toBe('No permission')
})

test('session permissions cannot grant a guest a tool its role forbids', async () => {
  const t = createTestVela({
    session: { role: 'guest', permissions: { bash: 'allow', '*': 'allow' } },
    responses: [
      (req) => {
        // The role is the upper bound: 'allow' does not add bash or read_file
        expect(req.tools).not.toContain('bash')
        expect(req.tools).not.toContain('read_file')
        return fauxToolCall('bash', { command: 'echo hi' })
      },
      fauxText('No permission'),
    ],
  })
  // Selecting the tool explicitly does not grant it either
  t.session.setActiveTools(['bash', 'read_file'])
  expect(t.session.getActiveTools()).toEqual([])

  await t.run('Run echo')

  expect(
    t.eventsOf('tool_execution_end').filter((e) => !e.isError),
  ).toHaveLength(0)
  expect(
    t.eventsOf('tool_execution_end').filter((e) => e.isError),
  ).toHaveLength(1)
  expect(t.lastAssistantText()).toBe('No permission')
})

test('bash has no default timeout; the model can pass one and sees that the command timed out', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'echo started; sleep 20',
        timeout: 0.3,
      }),
      fauxText('ok'),
    ],
  })

  const started = performance.now()
  await t.run('Run something slow')

  expect(performance.now() - started).toBeLessThan(10_000)
  const output = String(t.model.calls[1]!.toolResults[0]!.output)
  expect(output).toContain('started')
  expect(output).toContain('Command timed out after 0.3 seconds')
  // Like pi, a timed-out (or failed, or aborted) command is an error result
  expect(t.model.calls[1]!.toolResults[0]!.raw).toMatchObject({
    type: 'error-text',
  })
  expect(t.eventsOf('tool_execution_end')[0]).toMatchObject({
    toolName: 'bash',
    isError: true,
  })
})

test('bash streams its output as tool_execution_update events while it runs', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: "printf 'first\\n'; sleep 0.4; printf 'second\\n'",
      }),
      fauxText('ok'),
    ],
  })

  await t.run('Run something that prints twice')

  const updates = t.eventsOf('tool_execution_update')
  expect(updates.length).toBeGreaterThan(0)
  expect(updates[0]).toMatchObject({
    toolName: 'bash',
    partialResult: { content: [{ type: 'text', text: 'first\n' }] },
  })
  // Updates come between the call's start and end
  const types = t
    .eventTypes()
    .filter((type) => type.startsWith('tool_execution'))
  expect(types[0]).toBe('tool_execution_start')
  expect(types.at(-1)).toBe('tool_execution_end')
  expect(String(t.model.calls[1]!.toolResults[0]!.output)).toContain('second')
})

test('a tool calling another tool through ctx.executeTool goes through permissions, hooks and the bash check', async () => {
  const t = createTestVela({
    session: { permissions: { write_file: 'deny' } },
    responses: [fauxToolCall('runner', {}), fauxText('done')],
  })
  const blocked: string[] = []
  t.internals.hooks.registerPre('block-read', (toolName, _input, context) => {
    if (toolName !== 'read_file') return { action: 'allow' }
    blocked.push(context.toolCallId ?? '')
    return { action: 'block', reason: 'reads are off' }
  })
  t.internals.registry.register({
    name: 'runner',
    description: 'Runs other tools',
    inputSchema: z.object({}),
    execute: async (_input, context) => {
      const outcomes = []
      for (const [name, args] of [
        ['bash', { command: 'echo nested' }],
        ['bash', { command: 'rm -rf /' }],
        ['write_file', { path: 'x.txt', content: 'x' }],
        ['read_file', { path: 'x.txt' }],
      ] as const)
        outcomes.push(await context!.executeTool!(name, args))
      return outcomes.map((o) => `${o.toolName}:${o.isError}`).join(' ')
    },
  })

  await t.run('Run the runner')

  expect(t.model.calls[1]!.toolResults[0]!.output).toBe(
    'bash:false bash:true write_file:true read_file:true',
  )
  await expect(t.readFile('x.txt')).rejects.toThrow('ENOENT')
  const runnerId = t.eventsOf('tool_execution_start')[0]!.toolCallId
  expect(blocked).toEqual([`${runnerId}/4`])
  const nested = t
    .eventsOf('tool_execution_end')
    .filter((e) => e.parentToolCallId === runnerId)
  expect(nested.map((e) => [e.toolCallId, e.toolName, e.isError])).toEqual([
    [`${runnerId}/1`, 'bash', false],
    [`${runnerId}/2`, 'bash', true],
    [`${runnerId}/3`, 'write_file', true],
    [`${runnerId}/4`, 'read_file', true],
  ])
  // Nested calls are in the tool history, not in the conversation
  const history = await Bun.file(t.session.registry.results.indexPath).text()
  expect(history).toContain(`${runnerId}/2`)
  // Like pi's nestedCalls: recorded on the calling tool's result in the session, not sent to the model
  const toolEntry = t.session
    .getEntries()
    .find((e) => e.type === 'message' && e.message.role === 'tool')
  expect(toolEntry).toMatchObject({
    nestedCalls: {
      [runnerId]: {
        complete: true,
        calls: [
          {
            id: `${runnerId}/1`,
            name: 'bash',
            arguments: { command: 'echo nested' },
            status: 'ok',
          },
          { id: `${runnerId}/2`, name: 'bash', status: 'error' },
          { id: `${runnerId}/3`, name: 'write_file', status: 'error' },
          { id: `${runnerId}/4`, name: 'read_file', status: 'error' },
        ],
      },
    },
  })
  expect(JSON.stringify(t.model.calls[1]!.prompt)).not.toContain('nestedCalls')
  expect(t.messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
  ])
})

test('a long bash in one session does not hold back file writes in another session', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'sleep 1.5' }),
      fauxToolCall('write_file', { path: 'other.txt', content: 'written' }),
      fauxText('other done'),
      fauxText('slow done'),
    ],
  })

  let slowDone = false
  const slow = t.run('Run a slow command').then(() => {
    slowDone = true
  })
  await Bun.sleep(300)
  const started = performance.now()
  await t.vela.session('other').prompt('Write a file')

  // Before, every non-read-only tool took one lock shared by all sessions
  expect(performance.now() - started).toBeLessThan(800)
  expect(slowDone).toBe(false)
  expect(await t.readFile('other.txt')).toBe('written')
  await slow
  expect(t.lastAssistantText()).toBe('slow done')
})

test('tool_execution_end carries edit_file diff details for display, the model gets only the summary (like pi)', async () => {
  const t = createTestVela({
    files: { 'a.txt': 'one\ntwo\n' },
    responses: [
      fauxToolCall('edit_file', {
        path: 'a.txt',
        edits: [{ oldText: 'two', newText: 'TWO' }],
      }),
      fauxToolCall('runner', {}),
      fauxText('done'),
    ],
  })
  t.internals.registry.register({
    name: 'runner',
    description: 'Runs other tools',
    inputSchema: z.object({}),
    execute: async (_input, context) => {
      await context!.executeTool!('edit_file', {
        path: 'a.txt',
        edits: [{ oldText: 'TWO', newText: 'three' }],
      })
      return 'ok'
    },
  })

  await t.run('edit')

  const [direct, nested, runner] = t.eventsOf('tool_execution_end')
  expect(direct!.details).toMatchObject({
    diff: expect.stringContaining('+2 TWO'),
    patch: expect.stringContaining('-two'),
    firstChangedLine: 2,
  })
  expect(t.model.calls[1]!.toolResults[0]!.output).toBe(
    'Successfully replaced 1 block(s) in a.txt.',
  )
  expect(nested!.parentToolCallId).toBe(runner!.toolCallId)
  expect(nested!.details).toMatchObject({
    diff: expect.stringContaining('+2 three'),
  })
  // Tools that return plain values have no details
  expect('details' in runner!).toBe(false)
})

test('details of a call cut off by an abort are dropped with the call', async () => {
  const t = createTestVela({
    responses: [fauxToolCall('marker', {})],
  })
  t.internals.registry.register({
    name: 'marker',
    description: 'Returns display data, then the run is aborted',
    inputSchema: z.object({}),
    execute: async () => {
      void t.session.abort()
      return new ToolExecutionResult({ shown: true }, 'ok')
    },
  })

  await t.run('go').catch(() => {})

  const [call] = t.eventsOf('tool_execution_start')
  expect(t.session.registry.takeDetails(call!.toolCallId)).toBeUndefined()
})
