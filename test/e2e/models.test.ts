import { afterEach, expect, test } from 'bun:test'
import { DEFAULT_LIMITS } from '../../src/limits.ts'
import type { VelaEvent } from '../../src/agent/events.ts'
import type { VelaLogger } from '../../src/logger.ts'
import { createVela } from '../../src/vela.ts'
import type { ProviderDefinition } from '../../src/models/index.ts'
import { createFauxModel, fauxText } from '../../src/testing/faux.ts'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
  tempDir,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

/** A provider "fake": big has a 32k window and pricing, plain has no thinking; one faux per model */
function fakeProvider() {
  const big = createFauxModel({ modelId: 'big' })
  const plain = createFauxModel({ modelId: 'plain' })
  const provider: ProviderDefinition = {
    models: [
      {
        id: 'big',
        contextWindow: 32_768,
        cost: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      { id: 'plain', reasoning: false },
    ],
    createModel: (id) => {
      if (id === 'big') return big
      if (id === 'plain') return plain
      throw new Error(`unknown model ${id}`)
    },
  }
  return { big, plain, providers: { fake: provider } }
}

function warnings() {
  const lines: string[] = []
  const logger: VelaLogger = {
    debug() {},
    info() {},
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  }
  return { lines, logger }
}

test('a model chosen by name uses its provider, metadata and pricing', async () => {
  const { big, providers } = fakeProvider()
  big.push(fauxText('from big', { usage: { input: 3, output: 1 } }))
  const t = createTestVela({ model: 'fake/big', providers })

  expect(t.vela.models().map((m) => m.ref)).toEqual(['fake/big', 'fake/plain'])
  expect(t.session.modelInfo).toMatchObject({
    provider: 'fake',
    id: 'big',
    ref: 'fake/big',
    contextWindow: 32_768,
  })
  expect(t.session.limits.maxInputTokens).toBe(32_768 - 16_384)
  expect(t.session.tracker.contextWindow).toBe(32_768)

  await t.run('Hello')
  expect(t.lastAssistantText()).toBe('from big')
  // Pricing from models.json beats the built-in price table: 3 input tokens × $1/token
  expect(t.session.usage.totals.cost).toBeCloseTo(3)
})

test('pricing follows the provider, not a shared model id', async () => {
  const { big, providers } = fakeProvider()
  const priced = createFauxModel({ modelId: 'big' })
  const free = createFauxModel({ modelId: 'big' })
  const usage = { usage: { input: 3, output: 0 } }
  big.push(fauxText('a', usage))
  priced.push(fauxText('b', usage))
  free.push(fauxText('c', usage))
  const t = createTestVela({
    model: 'fake/big',
    providers: {
      ...providers,
      priced: {
        models: [{ id: 'big', cost: { input: 2_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        createModel: () => priced,
      },
      // Same model id but no pricing: not in the built-in price table either, so it adds no cost
      free: { createModel: () => free },
    },
  })

  await t.run('one')
  t.session.setModel('priced/big')
  await t.run('two')
  // Earlier requests keep their price at the time: 3×1 + 3×2; no cache, so the baseline cost is the same
  expect(t.session.usage.totals.cost).toBeCloseTo(9)
  expect(t.session.usage.totals.baselineCost).toBeCloseTo(9)
  t.session.setModel('free/big')
  await t.run('three')
  expect(t.session.usage.totals.cost).toBeCloseTo(9)
  expect(t.eventsOf('usage').at(-1)?.record?.cost).toBeUndefined()
})

test('setModel switches the model for the next prompt and recomputes limits', async () => {
  const { big, plain, providers } = fakeProvider()
  big.push(fauxText('big'))
  plain.push(fauxText('plain'))
  const t = createTestVela({ model: 'fake/big', providers })

  await t.run('one')
  t.session.setModel('fake/plain')
  t.session.setThinkingLevel('off')
  expect(t.session.modelInfo.ref).toBe('fake/plain')
  // plain has no window: back to the default limits
  expect(t.session.limits.maxInputTokens).toBe(DEFAULT_LIMITS.maxInputTokens)
  expect(t.session.tracker.contextWindow).toBe(200_000)
  await t.run('two')

  expect(big.calls.map((c) => c.lastUserText)).toEqual(['one'])
  expect(plain.calls.map((c) => c.lastUserText)).toEqual(['two'])
  // The second model sees the full history
  expect(JSON.stringify(plain.calls[0]!.prompt)).toContain('one')

  expect(() => t.session.setModel('nope/x')).toThrow('No provider named nope')
  expect(() => t.session.setModel('fake')).toThrow('provider/id')
  expect(t.session.modelInfo.ref).toBe('fake/plain')
})

test('sessions pick models independently', async () => {
  const { big, plain, providers } = fakeProvider()
  big.push(fauxText('a'))
  plain.push(fauxText('b'))
  const t = createTestVela({ model: 'fake/big', providers })
  const other = t.vela.session('other', {
    model: 'fake/plain',
    thinkingLevel: 'off',
  })

  await t.run('ask a')
  await other.prompt('ask b')
  expect(big.calls).toHaveLength(1)
  expect(plain.calls).toHaveLength(1)
  expect(t.vela.model).toBe(big)
})

test('thinking levels map to the reasoning call option', async () => {
  const { big, plain, providers } = fakeProvider()
  big.push(fauxText('1'), fauxText('2'), fauxText('3'), fauxText('4'))
  plain.push(fauxText('5'))
  const t = createTestVela({ model: 'fake/big', providers })

  await t.run('default')
  t.session.setThinkingLevel('high')
  await t.run('high')
  t.session.setThinkingLevel('max')
  await t.run('max')
  t.session.setThinkingLevel('off')
  await t.run('off')
  // A model declared without thinking: off sends no reasoning
  t.session.setModel('fake/plain')
  await t.run('plain')

  expect(big.calls.map((c) => c.reasoning)).toEqual([
    'medium',
    'high',
    'xhigh',
    'none',
  ])
  expect(plain.calls[0]!.reasoning).toBeUndefined()
  expect(() => t.session.setThinkingLevel('huge' as never)).toThrow()
})

test('the Vela-level thinking level is the default for new sessions', async () => {
  const { big, providers } = fakeProvider()
  big.push(fauxText('ok'))
  const t = createTestVela({
    model: 'fake/big',
    providers,
    thinkingLevel: 'low',
  })
  expect(t.session.thinkingLevel).toBe('low')
  await t.run('hi')
  expect(big.calls[0]!.reasoning).toBe('low')
})

test('a resumed session restores its model and thinking level', async () => {
  const dir = tempDir()
  try {
    const first = fakeProvider()
    first.big.push(fauxText('first'))
    const a = createTestVela({
      cwd: dir.path,
      model: 'fake/big',
      providers: first.providers,
    })
    a.session.setModel('fake/plain')
    a.session.setThinkingLevel('off')
    first.plain.push(fauxText('saved'))
    await a.run('save')
    await a.cleanup()

    const second = fakeProvider()
    second.plain.push(fauxText('resumed'))
    const b = createTestVela({
      cwd: dir.path,
      model: 'fake/big',
      providers: second.providers,
    })
    expect(await b.session.resume()).toBe(true)
    expect(b.session.modelInfo.ref).toBe('fake/plain')
    expect(b.session.thinkingLevel).toBe('off')
    await b.run('continue')
    expect(second.plain.calls).toHaveLength(1)
    expect(second.big.calls).toHaveLength(0)
    await b.cleanup()
  } finally {
    dir.cleanup()
  }
})

test('a thinking level the model does not support fails the prompt with a clear error', async () => {
  const { plain, providers } = fakeProvider()
  const started: VelaEvent[] = []
  const t = createTestVela({ model: 'fake/plain', providers })
  expect(t.session.thinkingLevel).toBe('medium')
  t.vela.subscribe((event) => {
    if (event.type === 'agent_start') started.push(event)
  })
  await expect(t.session.prompt('Hello')).rejects.toThrow(
    'Model fake/plain does not support thinking',
  )
  // No request was sent and the prompt was not added to history
  expect(plain.calls).toHaveLength(0)
  expect(started).toHaveLength(0)
  expect(t.session.messages).toHaveLength(0)
})

test('a saved model that no longer resolves warns and keeps the current one', async () => {
  const dir = tempDir()
  try {
    const first = fakeProvider()
    first.plain.push(fauxText('saved'))
    const a = createTestVela({
      cwd: dir.path,
      model: 'fake/plain',
      thinkingLevel: 'off',
      providers: first.providers,
    })
    await a.run('save')
    await a.cleanup()

    // The new Vela has no fake provider, only the faux model passed in directly
    const { lines, logger } = warnings()
    const b = createTestVela({ cwd: dir.path, logger })
    expect(await b.session.resume()).toBe(true)
    expect(b.session.model).toBe(b.model)
    expect(lines.join('\n')).toContain('fake/plain')
    await b.cleanup()
  } finally {
    dir.cleanup()
  }
})

test('a model passed as an object is not saved with the session', async () => {
  const dir = tempDir()
  try {
    const a = createTestVela({ cwd: dir.path, responses: [fauxText('x')] })
    await a.run('hi')
    expect(await a.readData('sessions/default.jsonl')).not.toContain(
      '"model"',
    )
    await a.cleanup()
  } finally {
    dir.cleanup()
  }
})

test('without a default model a session must pick one before prompting', async () => {
  const { big, providers } = fakeProvider()
  big.push(fauxText('ok'))
  const vela = createVela({ providers, extensions: [] })
  try {
    const session = vela.session()
    await expect(session.prompt('hi')).rejects.toThrow('No model selected')
    session.setModel('fake/big')
    await session.prompt('hi')
    expect(big.calls).toHaveLength(1)
  } finally {
    await vela.dispose()
  }
})

test('/model lists and switches models; /thinking sets the level for the session', async () => {
  const { providers } = fakeProvider()
  const t = createTestVela({ model: 'fake/big', providers })

  const list = await captureConsole(() => t.command('/model'))
  expect(list.output).toContain('Current: fake/big')
  expect(list.output).toContain('* fake/big (33k)')
  expect(list.output).toContain('fake/plain (no thinking)')

  const bad = await captureConsole(() => t.command('/model nope/x'))
  expect(bad.output).toContain('No provider named nope')
  await captureConsole(() => t.command('/model fake/plain'))
  expect(t.session.modelInfo.ref).toBe('fake/plain')

  await captureConsole(() => t.command('/thinking high'))
  expect(t.session.thinkingLevel).toBe('high')
  const wrong = await captureConsole(() => t.command('/thinking huge'))
  expect(wrong.output).toContain('Must be one of')
  expect(t.session.thinkingLevel).toBe('high')
  expect(wrong.output).not.toContain('default')
})
