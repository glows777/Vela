import { afterEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import z from 'zod'
import { ToolExecutionResult } from '../../packages/vela/src/driver/index.ts'
import {
  fauxText,
  fauxToolCall,
} from '../../packages/vela/src/testing/core/index.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

test.each(['Hello, Vela!!!', '中文 😀\n', 'hello\n', 'hello\r\n', ''])(
  'read sends the exact EOF body to the model: %j',
  async (body) => {
    const t = createTestVela({
      files: { 'notes.txt': body },
      responses: [
        fauxToolCall('read', { path: 'notes.txt' }),
        fauxText('Done'),
      ],
    })
    await t.run('Read notes.txt')
    expect(t.model.calls[1]!.toolResults[0]!.output).toBe(body)
  },
)

test.each([8191, 65535])(
  'read preserves UTF-8 split across byte %i while seeking a line',
  async (padding) => {
    const t = createTestVela({
      files: { 'notes.txt': `${'x'.repeat(padding - 1)}\n中文 😀` },
      responses: [
        fauxToolCall('read', { path: 'notes.txt', offset: 2 }),
        fauxText('Done'),
      ],
    })
    await t.run('Read the second line')
    expect(t.model.calls[1]!.toolResults[0]!.output).toBe('中文 😀')
  },
)

test.each([0, 8191, 8192])(
  'read rejects a NUL at byte %i before pagination',
  async (nulOffset) => {
    const t = createTestVela({
      files: { 'document.pdf': `${'x'.repeat(nulOffset)}\0binary payload` },
      responses: [
        fauxToolCall('read', { path: 'document.pdf' }),
        fauxText('Use bash to inspect the document'),
      ],
    })
    await t.run('Read document.pdf')
    expect(t.eventsOf('tool_execution_end')[0]!.isError).toBe(true)
    const output = String(t.model.calls[1]!.toolResults[0]!.output)
    expect(output).toContain('binary file')
    expect(output).toContain('pdftotext')
    expect(output).toContain('unzip -l')
    expect(output).not.toContain('binary payload')
    expect(output).not.toContain('More content exists')
  },
)

test.each([
  [
    'ASCII PDF',
    readFileSync(join(import.meta.dir, '../fixtures/files/ascii.pdf')),
  ],
  ['invalid UTF-8', Buffer.from([0x62, 0x69, 0x6e, 0xff, 0xfe])],
  [
    'late invalid UTF-8',
    Buffer.concat([Buffer.alloc(8192, 0x78), Buffer.from([0xff])]),
  ],
  ['truncated UTF-8', Buffer.from([0x61, 0xe4, 0xb8])],
])(
  'read rejects %s instead of sending bytes to the model',
  async (_name, bytes) => {
    const t = createTestVela({
      responses: [
        fauxToolCall('read', { path: 'document.bin' }),
        fauxText('Use bash to inspect the document'),
      ],
    })
    writeFileSync(join(t.cwd, 'document.bin'), bytes)
    await t.run('Read document.bin')
    expect(t.eventsOf('tool_execution_end')[0]!.isError).toBe(true)
    const output = String(t.model.calls[1]!.toolResults[0]!.output)
    expect(output).toContain('binary file')
    expect(output).toContain('pdftotext')
    expect(output).not.toContain('\ufffd')
    expect(output).not.toContain('%PDF-')
  },
)

test('read keeps line-limit continuation guidance and sends only the final page body', async () => {
  const t = createTestVela({
    files: { 'notes.txt': 'first\nsecond\n' },
    responses: [
      fauxToolCall('read', { path: 'notes.txt', limit: 1 }),
      fauxToolCall('read', {
        path: 'notes.txt',
        offset: 2,
        column: 0,
        limit: 1,
      }),
      fauxText('Done'),
    ],
  })
  await t.run('Read every page of notes.txt')
  expect(t.model.calls[1]!.toolResults[0]!.output).toBe(
    'first\n\n\n[read: lines 1-1, starting column=0; 6 UTF-16 code units shown. More content exists. Continue read with path="notes.txt", offset=2, column=0, limit=1.]',
  )
  expect(t.model.calls[2]!.toolResults.at(-1)!.output).toBe('second\n')
})

test('read keeps byte-cap continuation within a Unicode line and sends only the final page body', async () => {
  const firstPage = '😀'.repeat(12800)
  const t = createTestVela({
    files: { 'wide.txt': `${firstPage}tail\n` },
    responses: [
      fauxToolCall('read', { path: 'wide.txt' }),
      fauxToolCall('read', {
        path: 'wide.txt',
        offset: 1,
        column: 25600,
        limit: 2000,
      }),
      fauxText('Done'),
    ],
  })
  await t.run('Read every page of wide.txt')
  expect(t.model.calls[1]!.toolResults[0]!.output).toBe(
    `${firstPage}\n\n[read: lines 1-1, starting column=0; 25600 UTF-16 code units shown. More content exists. Continue read with path="wide.txt", offset=1, column=25600, limit=2000.]`,
  )
  expect(t.model.calls[2]!.toolResults.at(-1)!.output).toBe('tail\n')
})

test('several tool calls in one response all run and all results go back together', async () => {
  const t = createTestVela({
    session: { tools: ['+find', '+grep'] },
    files: {
      'src/a.ts': 'export const a = 1\n',
      'src/b.ts': 'export const b = 2\n',
    },
    responses: [
      [
        fauxToolCall('find', { pattern: 'src/*.ts' }),
        fauxToolCall('grep', { pattern: 'export const', path: 'src' }),
        fauxToolCall('read', { path: 'src/b.ts' }),
      ],
      fauxText('Found a and b'),
    ],
  })

  await t.run('What is in src?')

  expect(t.eventsOf('tool_execution_start').map((e) => e.toolName)).toEqual([
    'find',
    'grep',
    'read',
  ])
  expect(
    t.eventsOf('tool_execution_end').filter((e) => !e.isError),
  ).toHaveLength(3)
  const second = t.model.calls[1]!
  expect(second.toolResults.map((r) => r.toolName).sort()).toEqual([
    'find',
    'grep',
    'read',
  ])
  expect(
    second.toolResults.find((r) => r.toolName === 'read')!.output,
  ).toContain('export const b = 2')
  expect(t.messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
  ])
})

test('write writes into cwd and is reported as an audit event; edit changes it', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('write', {
        path: 'out/hello.txt',
        content: 'hello world\n',
      }),
      fauxToolCall('edit', {
        path: 'out/hello.txt',
        edits: [{ oldText: 'world', newText: 'vela' }],
      }),
      fauxText('Done writing'),
    ],
  })

  await t.run('Write a file')

  expect(await t.readFile('out/hello.txt')).toBe('hello vela\n')
  expect(t.eventsOf('audit').map((e) => [e.toolName, e.path])).toEqual([
    ['write', 'out/hello.txt'],
    ['edit', 'out/hello.txt'],
  ])
  expect(t.eventsOf('tool_execution_end').filter((e) => e.isError)).toEqual([])
})

test('write creates new files and rewrites a file it wrote or edited', async () => {
  const t = createTestVela({
    files: { 'notes.txt': 'hello world\n' },
    responses: [
      fauxToolCall('write', { path: 'out/new.md', content: 'first\n' }),
      fauxToolCall('write', { path: 'out/new.md', content: 'second\n' }),
      fauxToolCall('edit', {
        path: 'notes.txt',
        edits: [{ oldText: 'world', newText: 'vela' }],
      }),
      fauxToolCall('write', { path: 'notes.txt', content: 'rewritten\n' }),
      fauxText('Done'),
    ],
  })

  await t.run('Write files')

  expect(await t.readFile('out/new.md')).toBe('second\n')
  expect(await t.readFile('notes.txt')).toBe('rewritten\n')
  expect(t.eventsOf('tool_execution_end').filter((e) => e.isError)).toEqual([])
})

test('bash runs in cwd and returns plain output', async () => {
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
  expect(output).not.toContain('vela-tool-result')
  expect(output).not.toMatch(/\[\d{4}-\d{2}-\d{2}T/)
})

test('a force-delete bash command runs by default: there is no built-in classifier gate', async () => {
  const t = createTestVela({
    files: { 'junk/keep.txt': 'important' },
    responses: [
      fauxToolCall('bash', { command: 'rm -rf junk' }),
      fauxText('Deleted junk'),
    ],
  })

  await t.run('Clean up')

  expect(await Bun.file(t.path('junk/keep.txt')).exists()).toBe(false)
  expect(t.model.calls[1]!.toolResults[0]!.output).not.toContain('[Rejected]')
  expect(t.eventsOf('agent_end').at(-1)).toMatchObject({
    type: 'agent_end',
    reason: 'done',
  })
})

test('a tool that throws becomes a tool error the model can react to', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('read', { path: 'missing.txt' }),
      fauxText('The file does not exist'),
    ],
  })

  await t.run('Read missing.txt')

  expect(
    t.eventTypes().filter((type) => type.startsWith('tool_execution')),
  ).toEqual(['tool_execution_start', 'tool_execution_end'])
  expect(t.eventsOf('tool_execution_end')[0]).toMatchObject({
    toolName: 'read',
    isError: true,
  })
  const result = t.model.calls[1]!.toolResults[0]!
  expect(result.toolName).toBe('read')
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
        fauxToolCall('read', { wrong: 'shape' }),
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
  ).toEqual(['no_such_tool', 'read'])
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

test('bash has no default timeout; the model can pass one and sees that the command timed out', async () => {
  // Not sub-second: `bash -lc` pays login-shell startup first, so a short timeout can kill the
  // command before it prints (#372)
  const timeout = 2
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', {
        command: 'echo started; sleep 20',
        timeout,
      }),
      fauxText('ok'),
    ],
  })

  const started = performance.now()
  await t.run('Run something slow')

  expect(performance.now() - started).toBeLessThan(10_000)
  const output = String(t.model.calls[1]!.toolResults[0]!.output)
  expect(output).toContain('started')
  expect(output).toContain(`Command timed out after ${timeout} seconds`)
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

test('a long bash in one session does not hold back file writes in another session', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'sleep 1.5' }),
      fauxToolCall('write', { path: 'other.txt', content: 'written' }),
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

test('tool_execution_end carries edit diff details for display, the model gets only the summary (like pi)', async () => {
  const t = createTestVela({
    files: { 'a.txt': 'one\ntwo\n' },
    responses: [
      fauxToolCall('edit', {
        path: 'a.txt',
        edits: [{ oldText: 'two', newText: 'TWO' }],
      }),
      fauxToolCall('plain', {}),
      fauxText('done'),
    ],
  })
  t.internals.registry.register({
    name: 'plain',
    description: 'Returns a plain value',
    inputSchema: z.object({}),
    execute: async () => 'ok',
  })

  await t.run('edit')

  const [direct, plain] = t.eventsOf('tool_execution_end')
  expect(direct!.details).toMatchObject({
    diff: expect.stringContaining('+2 TWO'),
    patch: expect.stringContaining('-two'),
    firstChangedLine: 2,
  })
  expect(t.model.calls[1]!.toolResults[0]!.output).toBe(
    'Successfully replaced 1 block(s) in a.txt.',
  )
  // Tools that return plain values have no details
  expect('details' in plain!).toBe(false)
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
