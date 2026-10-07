import { afterEach, expect, test } from 'bun:test'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
} from '../../../support/vela'

afterEach(cleanupTestVelas)

function fixture() {
  const t = createTestVela()
  t.vela.memoryStore.save({
    name: 'openai-null-chars',
    description: 'openai 接口返回 null 字符问题',
    type: 'feedback',
    content: '正文',
  })
  return t
}

const run = (command: string) =>
  captureConsole(() => fixture().dispatch(command))

test('/memory 列出记忆条目', async () => {
  const { result, output } = await run('/memory')
  expect(result).toBe(true)
  expect(output).toContain('共 1 条记忆')
  expect(output).toContain('openai-null-chars')
})

test('/lint 无问题时报健康', async () => {
  const { result, output } = await run('/lint')
  expect(result).toBe(true)
  expect(output).toContain('记忆库健康')
})

test('/memory search 用 BM25 返回命中', async () => {
  const { result, output } = await run('/memory search null 字符')
  expect(result).toBe(true)
  expect(output).toContain('BM25 搜索')
  expect(output).toContain('openai-null-chars')
})

test('搜记忆 别名等价于 /memory search', async () => {
  const { result, output } = await run('搜记忆 null 字符')
  expect(result).toBe(true)
  expect(output).toContain('BM25 搜索')
  expect(output).toContain('openai-null-chars')
})
