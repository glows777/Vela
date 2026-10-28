import { expect, test } from 'bun:test'
import {
  type PromptContext,
  PromptPipeline,
} from '../../../src/prompt/pipeline.ts'

const ctx: PromptContext = {
  toolCount: 1,
  deferredToolSummary: '',
  sessionMessageCount: 0,
  sessionId: 'test',
}

test('build skips null sections and joins the rest with blank lines in registration order', () => {
  const pipeline = new PromptPipeline()
    .pipe('a', () => null)
    .pipe('b', () => 'BBB')
    .pipe('c', () => 'CCC')
    .pipe('d', () => null)
  expect(pipeline.build(ctx)).toBe('BBB\n\nCCC')
})

test('build outputs an empty string when every section is null', () => {
  const pipeline = new PromptPipeline().pipe('a', () => null)
  expect(pipeline.build(ctx)).toBe('')
})

test('status reports whether each module is enabled and its character count', () => {
  const pipeline = new PromptPipeline()
    .pipe('on', () => 'x')
    .pipe('off', () => null)
  expect(pipeline.status(ctx)).toEqual([
    { name: 'on', chars: 1 },
    { name: 'off', chars: null },
  ])
})

test('pipe passes the context to every function', () => {
  const pipeline = new PromptPipeline().pipe(
    'ctx-aware',
    (c) => `count=${c.toolCount}`,
  )
  expect(pipeline.build(ctx)).toBe('count=1')
})
