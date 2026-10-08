import { expect, test } from 'bun:test'
import {
  PromptPipeline,
  type PromptContext,
} from '../../../src/prompt/pipeline.ts'

const ctx: PromptContext = {
  toolCount: 1,
  deferredToolSummary: '',
  sessionMessageCount: 0,
  sessionId: 'test',
}

test('build 跳过 null 片段，其余按注册顺序用空行连接', () => {
  const pipeline = new PromptPipeline()
    .pipe('a', () => null)
    .pipe('b', () => 'BBB')
    .pipe('c', () => 'CCC')
    .pipe('d', () => null)
  expect(pipeline.build(ctx)).toBe('BBB\n\nCCC')
})

test('build 全部为 null 时输出空字符串', () => {
  const pipeline = new PromptPipeline().pipe('a', () => null)
  expect(pipeline.build(ctx)).toBe('')
})

test('status 报告每个模块是否启用和字符数', () => {
  const pipeline = new PromptPipeline()
    .pipe('on', () => 'x')
    .pipe('off', () => null)
  expect(pipeline.status(ctx)).toEqual([
    { name: 'on', chars: 1 },
    { name: 'off', chars: null },
  ])
})

test('pipe 管道提供上下文给每个函数', () => {
  const pipeline = new PromptPipeline().pipe(
    'ctx-aware',
    (c) => `count=${c.toolCount}`,
  )
  expect(pipeline.build(ctx)).toBe('count=1')
})
