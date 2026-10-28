import { expect, test } from 'bun:test'
import {
  clampThinkingLevel,
  supportedThinkingLevels,
} from '../../../src/models/catalog.ts'
import {
  catalogLookup,
  catalogModels,
  THINKING_LEVELS,
} from '../../../src/models/index.ts'

test('the catalog has the built-in providers, with pi metadata', () => {
  for (const provider of ['anthropic', 'openai', 'openrouter']) {
    const models = catalogModels(provider)
    expect(models.length).toBeGreaterThan(0)
    for (const model of models) {
      expect(model.id).toBeTruthy()
      expect([
        'anthropic-messages',
        'openai-responses',
        'openai-completions',
      ]).toContain(model.api)
    }
  }
  expect(catalogLookup('anthropic', 'claude-opus-4-8')).toMatchObject({
    contextWindow: expect.any(Number),
    cost: { input: expect.any(Number), output: expect.any(Number) },
  })
  // Another provider's id is found too; an unknown id is not
  expect(catalogLookup('my-proxy', 'claude-opus-4-8')?.id).toBe(
    'claude-opus-4-8',
  )
  expect(catalogLookup('anthropic', 'no-such-model')).toBeUndefined()
})

test('supported thinking levels and clamping follow pi', () => {
  const all = THINKING_LEVELS
  expect(supportedThinkingLevels({}, all)).toEqual([...all])
  expect(supportedThinkingLevels({ reasoning: false }, all)).toEqual(['off'])
  // xhigh / max only when the map names them
  expect(supportedThinkingLevels({ reasoning: true }, all)).toEqual([
    'off',
    'minimal',
    'low',
    'medium',
    'high',
  ])
  const map = { reasoning: true, thinkingLevelMap: { off: null, max: 'max' } }
  expect(supportedThinkingLevels(map, all)).toEqual([
    'minimal',
    'low',
    'medium',
    'high',
    'max',
  ])
  // Up first, then down
  expect(clampThinkingLevel('off', map, all)).toBe('minimal')
  expect(clampThinkingLevel('xhigh', map, all)).toBe('max')
  expect(clampThinkingLevel('xhigh', { reasoning: true }, all)).toBe('high')
  expect(clampThinkingLevel('high', { reasoning: false }, all)).toBe('off')
})
