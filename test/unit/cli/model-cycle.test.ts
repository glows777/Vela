import { expect, test } from 'bun:test'
import { nextModel, scopedModels } from '../../../src/cli/model-cycle.ts'
import type { ModelInfo } from '../../../src/models/index.ts'

const info = (ref: string): ModelInfo => {
  const [provider, id] = [
    ref.slice(0, ref.indexOf('/')),
    ref.slice(ref.indexOf('/') + 1),
  ]
  return { provider, id, ref } as ModelInfo
}
const models = [
  'anthropic/claude-a',
  'openai/gpt-5',
  'openrouter/openai/gpt-5',
].map(info)

test('enabledModels patterns pick the cycle in pattern order', () => {
  expect(scopedModels(models, undefined)).toEqual(models)
  expect(scopedModels(models, ['gpt-5']).map((m) => m.ref)).toEqual([
    'openai/gpt-5',
  ])
  expect(
    scopedModels(models, ['openrouter/*', 'anthropic/*']).map((m) => m.ref),
  ).toEqual(['openrouter/openai/gpt-5', 'anthropic/claude-a'])
  // Nothing matches: all models, rather than an empty cycle
  expect(scopedModels(models, ['nope/*'])).toEqual(models)
})

test('nextModel wraps around in both directions', () => {
  expect(nextModel(models, 'openai/gpt-5')?.ref).toBe('openrouter/openai/gpt-5')
  expect(nextModel(models, 'openrouter/openai/gpt-5')?.ref).toBe(
    'anthropic/claude-a',
  )
  expect(nextModel(models, 'anthropic/claude-a', -1)?.ref).toBe(
    'openrouter/openai/gpt-5',
  )
  expect(nextModel(models, 'elsewhere/x')?.ref).toBe('anthropic/claude-a')
  expect(nextModel(models.slice(0, 1), undefined)).toBeUndefined()
})
