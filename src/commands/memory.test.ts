import { afterEach, expect, spyOn, test } from 'bun:test'
import { createTestFixture, type TestFixture } from '../testing/harness'
import { memoryCommands } from './memory'

let fixtures: TestFixture[] = []
afterEach(() => {
  for (const f of fixtures) f.cleanup()
  fixtures = []
})

function fixture(): TestFixture {
  const f = createTestFixture({ commands: memoryCommands })
  fixtures.push(f)
  f.memoryStore.save({
    name: 'openai-null-chars',
    description: 'openai 接口返回 null 字符问题',
    type: 'feedback',
    content: '正文',
  })
  return f
}

function run(f: TestFixture, cmd: string): { result: boolean | 'async'; output: string } {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    const result = f.dispatch(cmd, f.ctx)
    return { result, output: log.mock.calls.flat().join('\n') }
  } finally {
    log.mockRestore()
  }
}

test('/memory 列出记忆条目', () => {
  const { result, output } = run(fixture(), '/memory')
  expect(result).toBe(true)
  expect(output).toContain('共 1 条记忆')
  expect(output).toContain('openai-null-chars')
})

test('/lint 无问题时报健康', () => {
  const { result, output } = run(fixture(), '/lint')
  expect(result).toBe(true)
  expect(output).toContain('记忆库健康')
})

test('/memory search 用 BM25 返回命中', () => {
  const { result, output } = run(fixture(), '/memory search null 字符')
  expect(result).toBe(true)
  expect(output).toContain('BM25 搜索')
  expect(output).toContain('openai-null-chars')
})

test('搜记忆 别名等价于 /memory search', () => {
  const { result, output } = run(fixture(), '搜记忆 null 字符')
  expect(result).toBe(true)
  expect(output).toContain('BM25 搜索')
  expect(output).toContain('openai-null-chars')
})
