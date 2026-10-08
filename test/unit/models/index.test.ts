import { expect, test } from 'bun:test'
import { DEFAULT_LIMITS } from '../../../src/limits.ts'
import {
  limitsForModel,
  ModelRegistry,
  reasoningOption,
} from '../../../src/models/index.ts'
import { createFauxModel } from '../../../src/testing/faux.ts'

const provider = (models = [{ id: 'm', contextWindow: 64_000 }]) => ({
  models,
  createModel: (id: string) => createFauxModel({ modelId: id }),
})

test('resolve splits provider/id at the first slash and attaches listed metadata', () => {
  const registry = new ModelRegistry({ p: provider() })
  const listed = registry.resolve('p/m')
  expect(listed.info).toEqual({ id: 'm', contextWindow: 64_000, provider: 'p', ref: 'p/m' })
  // Unlisted ids work too (there is no built-in model catalog), and an id may contain /
  const unlisted = registry.resolve('p/vendor/model-x')
  expect(unlisted.info).toEqual({ id: 'vendor/model-x', provider: 'p', ref: 'p/vendor/model-x' })
  expect((unlisted.model as { modelId: string }).modelId).toBe('vendor/model-x')
  expect(registry.list().map((m) => m.ref)).toEqual(['p/m'])
})

test('resolve and register report mistakes', () => {
  const registry = new ModelRegistry({ p: provider() })
  expect(() => registry.resolve('m')).toThrow('Model must be provider/id')
  expect(() => registry.resolve('p/')).toThrow('Model must be provider/id')
  expect(() => registry.resolve('q/m')).toThrow('No provider named q (available: p)')
  expect(() => registry.register('p', provider())).toThrow('Provider p is already registered')
  expect(() => registry.register('a b', provider())).toThrow('Invalid provider name')
})

test('thinking levels map to the AI SDK reasoning option', () => {
  const m = { id: 'm', provider: 'p', ref: 'p/m' }
  expect(reasoningOption('off', m)).toBe('none')
  expect(reasoningOption('high', m)).toBe('high')
  expect(reasoningOption('max', m)).toBe('xhigh')
  // A model declared without thinking support: off sends no option; other levels throw instead of being silently ignored
  expect(reasoningOption('off', { ...m, reasoning: false })).toBeUndefined()
  expect(() => reasoningOption('medium', { ...m, reasoning: false })).toThrow(
    'Model p/m does not support thinking',
  )
  // Core doesn't know the mode: the hint names the interactive, command-line and SDK ways to turn thinking off
  expect(() => reasoningOption('medium', { ...m, reasoning: false })).toThrow(
    "set the thinking level to off (/thinking off, --thinking off, or setThinkingLevel('off'))",
  )
})

test('context limits follow the model window; explicit limits win', () => {
  expect(limitsForModel({})).toEqual({ ...DEFAULT_LIMITS })
  const small = limitsForModel({ contextWindow: 32_768 })
  expect(small).toMatchObject({
    // Same as pi: reserve 16384 for output
    maxInputTokens: 16_384,
    // The summary request itself must fit: 10% of the window below the input cap
    summaryThreshold: 13_108,
    microcompactThreshold: 10_486,
    minMicroSavings: 3_276,
    maxRetries: DEFAULT_LIMITS.maxRetries,
  })
  // A 200k window yields the current defaults
  expect(limitsForModel({ contextWindow: 200_000 })).toEqual({ ...DEFAULT_LIMITS })
  // A very small window reserves at most half for output
  expect(limitsForModel({ contextWindow: 16_000 }).maxInputTokens).toBe(8_000)
  expect(
    limitsForModel({ contextWindow: 32_768 }, { maxInputTokens: 30_000 })
      .maxInputTokens,
  ).toBe(30_000)
})
