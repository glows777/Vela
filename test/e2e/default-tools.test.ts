import { afterEach, expect, test } from 'bun:test'
import { createVela, type SessionOptions } from '@glows777/vela'
import {
  cleanupTestVelas,
  createFauxModel,
  createTestVela,
  fauxText,
  fauxToolCall,
  tempDir,
} from '@glows777/vela/testing'

afterEach(cleanupTestVelas)

/** The tools the first request of a bare SDK Vela (no extensions) declares. */
async function requestTools(session?: SessionOptions): Promise<string[]> {
  const dir = tempDir()
  const model = createFauxModel({ responses: [fauxText('ok')] })
  const vela = createVela({ model, cwd: dir.path })
  try {
    await vela.session('default', session).prompt('hi')
    return model.calls[0]!.tools
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
}

test('a session declares only read_file, bash, edit_file, write_file and tool_search by default', async () => {
  expect(await requestTools()).toEqual([
    'read_file',
    'write_file',
    'edit_file',
    'bash',
    'tool_search',
  ])
})

test('`+name` turns a default-off tool back on and `-name` turns a default tool off', async () => {
  expect(await requestTools({ tools: ['+grep'] })).toEqual([
    'read_file',
    'write_file',
    'edit_file',
    'grep',
    'bash',
    'tool_search',
  ])
  expect(await requestTools({ tools: ['-bash'] })).toEqual([
    'read_file',
    'write_file',
    'edit_file',
    'tool_search',
  ])
})

test('tool modifiers leave tools registered by extensions alone', async () => {
  const t = createTestVela({
    responses: [fauxText('ok')],
    session: { tools: ['+grep'] },
  })
  await t.run('hi')
  expect(t.model.calls[0]!.tools).toContain('memory')
  expect(t.model.calls[0]!.tools).toContain('grep')
  expect(t.model.calls[0]!.tools).not.toContain('find')
})

test('a model call to a default-off tool fails and names the tools it can call', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('grep', { pattern: 'x' }),
      fauxText('grep is off'),
    ],
  })
  await t.run('search')
  const [end] = t.eventsOf('tool_execution_end')
  expect(end).toMatchObject({ toolName: 'grep', isError: true })
  expect(end?.result).toContain("unavailable tool 'grep'")
  expect(end?.result).toContain('read_file')
  expect(end?.result).not.toContain('list_directory')
})
