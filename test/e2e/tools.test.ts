import { afterEach, expect, test } from 'bun:test'
import z from 'zod'
import { fauxText, fauxToolCall } from '../../src/testing/faux'
import { captureConsole, cleanupTestVelas, createTestVela } from '../support/vela'

afterEach(cleanupTestVelas)

test('several tool calls in one response all run and all results go back together', async () => {
  const t = createTestVela({
    files: { 'src/a.ts': 'export const a = 1\n', 'src/b.ts': 'export const b = 2\n' },
    responses: [
      [
        fauxToolCall('glob', { pattern: 'src/*.ts' }),
        fauxToolCall('grep', { pattern: 'export const', path: 'src' }),
        fauxToolCall('read_file', { path: 'src/b.ts' }),
      ],
      fauxText('找到 a 和 b'),
    ],
  })

  await t.run('看看 src 里有什么')

  expect(t.eventsOf('tool_call').map((e) => e.toolName)).toEqual(['glob', 'grep', 'read_file'])
  expect(t.eventsOf('tool_result')).toHaveLength(3)
  const second = t.model.calls[1]!
  expect(second.toolResults.map((r) => r.toolName).sort()).toEqual(['glob', 'grep', 'read_file'])
  expect(second.toolResults.find((r) => r.toolName === 'read_file')!.output).toContain(
    'export const b = 2',
  )
  expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
})

test('write_file writes into cwd and is reported as an audit event; edit_file changes it', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('write_file', { path: 'out/hello.txt', content: 'hello world\n' }),
      fauxToolCall('edit_file', {
        path: 'out/hello.txt',
        old_string: 'world',
        new_string: 'vela',
      }),
      fauxText('写好了'),
    ],
  })

  await t.run('写个文件')

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
    responses: [fauxToolCall('bash', { command: 'ls && echo BASH_OK' }), fauxText('ok')],
  })

  await t.run('跑个命令')

  const output = t.model.calls[1]!.toolResults[0]!.output
  expect(output).toContain('marker.txt')
  expect(output).toContain('BASH_OK')
  expect(output).toMatch(/\[\d{4}-\d{2}-\d{2}T[^\]]+Z\]\\n/)
})

test('a dangerous bash command is refused before it runs and the model sees why', async () => {
  const t = createTestVela({
    files: { 'keep.txt': 'important' },
    responses: [fauxToolCall('bash', { command: 'rm -rf /' }), fauxText('好的，不删')],
  })

  await t.run('清理一下')

  expect(await t.readFile('keep.txt')).toBe('important')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain('[拒绝执行] 检测到危险操作')
  expect(t.events.at(-1)).toEqual({ type: 'agent_end', reason: 'done' })
})

test('a tool that throws becomes a tool error the model can react to', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('read_file', { path: 'missing.txt' }),
      fauxText('文件不存在'),
    ],
  })

  await t.run('读 missing.txt')

  expect(t.eventTypes().slice(0, 3)).toEqual(['turn_start', 'tool_call', 'tool_error'])
  const result = t.model.calls[1]!.toolResults[0]!
  expect(result.toolName).toBe('read_file')
  expect(result.raw).toMatchObject({ type: 'error-text' })
  expect(result.output).toContain('ENOENT')
  expect(t.lastAssistantText()).toBe('文件不存在')
  expect(t.events.at(-1)).toEqual({ type: 'agent_end', reason: 'done' })
})

test('an unknown tool and invalid arguments are rejected without crashing the loop', async () => {
  const t = createTestVela({
    responses: [
      [
        fauxToolCall('no_such_tool', { x: 1 }),
        fauxToolCall('read_file', { wrong: 'shape' }),
      ],
      fauxText('换个方式'),
    ],
  })

  await t.run('试试')

  expect(t.eventsOf('tool_error').map((e) => e.toolName).sort()).toEqual([
    'no_such_tool',
    'read_file',
  ])
  expect(t.model.calls[1]!.toolResults).toHaveLength(2)
  expect(t.events.at(-1)).toEqual({ type: 'agent_end', reason: 'done' })
  // 被拒绝的调用也写进了工具历史
  const history = await Bun.file(t.vela.registry.results.indexPath).text()
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
      (req) => fauxText(`查到：${req.toolResults[0]!.output}`),
    ],
  })
  t.vela.registry.register({
    name: 'mcp__fake__lookup',
    description: '[MCP:fake] look something up',
    inputSchema: z.object({ id: z.string() }),
    shouldDefer: true,
    execute: async ({ id }: { id: string }) => `record ${id}`,
  })

  await t.run('查一下 42')

  expect(t.lastAssistantText()).toBe('查到：record 42')
})

test('a guest cannot use bash: the call is refused and recorded', async () => {
  const t = createTestVela({
    responses: [
      (req) => {
        // guest 拿不到 bash，但模型仍可能凭历史调用它
        expect(req.tools).not.toContain('bash')
        return fauxToolCall('bash', { command: 'echo hi' })
      },
      fauxText('没有权限'),
    ],
  })
  await captureConsole(() => t.dispatch('/role guest'))

  await t.run('跑 echo')

  expect(t.eventsOf('tool_result')).toHaveLength(0)
  expect(t.eventsOf('tool_error')).toHaveLength(1)
  expect(t.lastAssistantText()).toBe('没有权限')
})
