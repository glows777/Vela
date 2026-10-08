import { afterEach, expect, test } from 'bun:test'
import z from 'zod'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
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

  expect(t.eventsOf('tool_call').map((e) => e.toolName)).toEqual([
    'find',
    'grep',
    'read_file',
  ])
  expect(t.eventsOf('tool_result')).toHaveLength(3)
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
        old_string: 'world',
        new_string: 'vela',
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
  expect(t.eventsOf('tool_error')).toEqual([])
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
  expect(t.eventsOf('agent_end').at(-1)).toEqual({
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

  expect(t.eventTypes().slice(2, 5)).toEqual([
    'turn_start',
    'tool_call',
    'tool_error',
  ])
  const result = t.model.calls[1]!.toolResults[0]!
  expect(result.toolName).toBe('read_file')
  expect(result.raw).toMatchObject({ type: 'error-text' })
  expect(result.output).toContain('ENOENT')
  expect(t.lastAssistantText()).toBe('The file does not exist')
  expect(t.eventsOf('agent_end').at(-1)).toEqual({
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
      .eventsOf('tool_error')
      .map((e) => e.toolName)
      .sort(),
  ).toEqual(['no_such_tool', 'read_file'])
  expect(t.model.calls[1]!.toolResults).toHaveLength(2)
  expect(t.eventsOf('agent_end').at(-1)).toEqual({
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

  expect(t.eventsOf('tool_result')).toHaveLength(0)
  expect(t.eventsOf('tool_error')).toHaveLength(1)
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

  expect(t.eventsOf('tool_result')).toHaveLength(0)
  expect(t.eventsOf('tool_error')).toHaveLength(1)
  expect(t.lastAssistantText()).toBe('No permission')
})
