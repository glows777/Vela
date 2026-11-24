import { expect, test } from 'bun:test'
import { memoryCredentialStore } from '../../../../src/providers/auth/store.ts'
import type { OAuthLogin } from '../../../../src/providers/auth/types.ts'
import {
  limitsForModel,
  ModelRegistry,
  reasoningOption,
} from '../../../../src/providers/models/index.ts'
import { DEFAULT_LIMITS } from '../../../../src/shared/limits.ts'
import { createFauxModel } from '../../../../src/testing/core/faux.ts'

const provider = (models = [{ id: 'm', contextWindow: 64_000 }]) => ({
  models,
  createModel: (id: string) => createFauxModel({ modelId: id }),
})

test('resolve splits provider/id at the first slash and attaches listed metadata', () => {
  const registry = new ModelRegistry({ p: provider() })
  const listed = registry.resolve('p/m')
  expect(listed.info).toEqual({
    id: 'm',
    contextWindow: 64_000,
    provider: 'p',
    ref: 'p/m',
  })
  // Unlisted ids work too (there is no built-in model catalog), and an id may contain /
  const unlisted = registry.resolve('p/vendor/model-x')
  expect(unlisted.info).toEqual({
    id: 'vendor/model-x',
    provider: 'p',
    ref: 'p/vendor/model-x',
  })
  expect((unlisted.model as { modelId: string }).modelId).toBe('vendor/model-x')
  expect(registry.list().map((m) => m.ref)).toEqual(['p/m'])
})

test('planLabel names the plan only for a stored subscription sign-in', () => {
  const plan: OAuthLogin = {
    name: 'Sign in with a plan',
    isSubscription: true,
    planLabel: 'ChatGPT plan',
    login: async () => ({ type: 'api_key', key: 'k' }),
  }
  const keyLogin: OAuthLogin = { ...plan, isSubscription: false }
  const credentials = memoryCredentialStore({
    plan: { type: 'oauth', access: 'a', refresh: 'r', expires: 0 },
    key: { type: 'api_key', key: 'k' },
    plain: { type: 'oauth', access: 'a', refresh: 'r', expires: 0 },
  })
  const registry = new ModelRegistry(
    {
      plan: { ...provider(), oauth: plan },
      key: { ...provider(), oauth: plan },
      plain: { ...provider(), oauth: keyLogin },
      none: provider(),
    },
    credentials,
  )
  expect(registry.planLabel('plan')).toBe('ChatGPT plan')
  // An API key pays per token, a non-subscription sign-in is not a plan, and no sign-in has no label
  expect(registry.planLabel('key')).toBeUndefined()
  expect(registry.planLabel('plain')).toBeUndefined()
  expect(registry.planLabel('none')).toBeUndefined()
  expect(registry.planLabel('missing')).toBeUndefined()
})

test('resolve and register report mistakes', () => {
  const registry = new ModelRegistry({ p: provider() })
  expect(() => registry.resolve('m')).toThrow('Model must be provider/id')
  expect(() => registry.resolve('p/')).toThrow('Model must be provider/id')
  expect(() => registry.resolve('q/m')).toThrow(
    'No provider named q (available: p)',
  )
  expect(() => registry.register('p', provider())).toThrow(
    'Provider p is already registered',
  )
  expect(() => registry.register('a b', provider())).toThrow(
    'Invalid provider name',
  )
})

test('thinking levels map to the AI SDK reasoning option', () => {
  const m = { id: 'm', provider: 'p', ref: 'p/m' }
  expect(reasoningOption('off', m)).toBe('none')
  expect(reasoningOption('high', m)).toBe('high')
  expect(reasoningOption('max', m)).toBe('max')
  // A model declared without thinking support: off sends no option (other levels are clamped to off before this)
  expect(reasoningOption('off', { ...m, reasoning: false })).toBeUndefined()
})

test('context limits follow the model window; explicit limits win', () => {
  expect(limitsForModel({})).toEqual({ ...DEFAULT_LIMITS })
  const small = limitsForModel({ contextWindow: 32_768 })
  expect(small).toMatchObject({
    // Same as pi: reserve 16384 for output
    maxInputTokens: 16_384,
    // The summary request itself must fit: 10% of the window below the input cap
    summaryThreshold: 13_108,
    maxRetries: DEFAULT_LIMITS.maxRetries,
  })
  // A 200k window yields the current defaults
  expect(limitsForModel({ contextWindow: 200_000 })).toEqual({
    ...DEFAULT_LIMITS,
  })
  // A very small window reserves at most half for output
  expect(limitsForModel({ contextWindow: 16_000 }).maxInputTokens).toBe(8_000)
  expect(
    limitsForModel({ contextWindow: 32_768 }, { maxInputTokens: 30_000 })
      .maxInputTokens,
  ).toBe(30_000)
})
