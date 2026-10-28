import { afterEach, expect, test } from 'bun:test'
import type { ProviderDefinition, VelaLogger } from '@glows777/vela-core'
import { createFauxModel, fauxText } from '@glows777/vela-core/testing'
import { wrapLanguageModel } from 'ai'
import { z } from 'zod'
import { DEFAULT_LIMITS } from '../../packages/core/src/limits.ts'
import { describeModel } from '../../packages/core/src/models/index.ts'
import { createVela } from '../support/compat-vela.ts'
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
        models: [
          {
            id: 'big',
            cost: { input: 2_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
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
    'max',
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

test('the thinking level is clamped to what the model supports, like pi', async () => {
  const { big, plain, providers } = fakeProvider()
  plain.push(fauxText('plain'))
  big.push(fauxText('big'))
  const t = createTestVela({ model: 'fake/plain', providers })
  // A model without thinking: the level is off, and no reasoning option is sent
  expect(t.session.thinkingLevel).toBe('off')
  expect(t.session.availableThinkingLevels()).toEqual(['off'])
  t.session.setThinkingLevel('high')
  expect(t.session.thinkingLevel).toBe('off')
  await t.run('Hello')
  expect(plain.calls[0]!.reasoning).toBeUndefined()
  // A model with thinking uses the requested level again
  t.session.setModel('fake/big')
  expect(t.session.thinkingLevel).toBe('high')
  await t.run('Again')
  expect(big.calls[0]!.reasoning).toBe('high')
})

test('levels missing from a thinkingLevelMap move to the nearest supported one', async () => {
  const model = createFauxModel({ modelId: 'mapped' })
  const t = createTestVela({
    model: 'fake/mapped',
    providers: {
      fake: {
        models: [
          {
            id: 'mapped',
            reasoning: true,
            thinkingLevelMap: { off: null, minimal: null, xhigh: 'xhigh' },
          },
        ],
        createModel: () => model,
      },
    },
  })
  expect(t.session.availableThinkingLevels()).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
  ])
  t.session.setThinkingLevel('off')
  expect(t.session.thinkingLevel).toBe('low')
  t.session.setThinkingLevel('max')
  expect(t.session.thinkingLevel).toBe('xhigh')
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
    expect(await a.readData('sessions/default.jsonl')).not.toContain('"model"')
    await a.cleanup()
  } finally {
    dir.cleanup()
  }
})

test('without a chosen model, the first provider with a credential supplies the model (like pi)', async () => {
  const { big, providers } = fakeProvider()
  big.push(fauxText('ok'))
  const none = createVela({ extensions: [] })
  const vela = createVela({ providers, extensions: [] })
  try {
    await expect(none.session().prompt('hi')).rejects.toThrow(
      'No model selected',
    )
    const session = vela.session()
    await session.prompt('hi')
    expect(session.modelInfo.ref).toBe('fake/big')
    expect(big.calls).toHaveLength(1)
    // Saved like a chosen model, so a resumed session keeps it when credentials change later
    expect(
      session
        .getEntries()
        .filter((e) => e.type === 'model_change')
        .map((e) => (e as { model: string }).model),
    ).toEqual(['fake/big'])
  } finally {
    await none.dispose()
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

  const clamped = await captureConsole(() => t.command('/thinking high'))
  expect(clamped.output).toContain(
    'fake/plain does not support high; using off',
  )
  await captureConsole(() => t.command('/model fake/big'))
  expect(t.session.thinkingLevel).toBe('high')
  const wrong = await captureConsole(() => t.command('/thinking huge'))
  expect(wrong.output).toContain('Must be one of')
  expect(t.session.thinkingLevel).toBe('high')
  expect(wrong.output).not.toContain('default')
})

test('an extension provider reads its /login credential per request, and an expiring OAuth token is refreshed once', async () => {
  const model = createFauxModel({ modelId: 'm' })
  model.push(fauxText('one'), fauxText('two'))
  const tokens: (string | undefined)[] = []
  let refreshes = 0
  const provider: ProviderDefinition = {
    oauth: {
      name: 'Sign in with Fake',
      login: async () => ({
        type: 'oauth',
        access: 'a1',
        refresh: 'r1',
        expires: Date.now() + 1000,
      }),
      async refresh(credential) {
        refreshes++
        return { ...credential, access: 'a2', expires: Date.now() + 3_600_000 }
      },
    },
    authSource: (credential) => credential && 'auth.json',
    createModel: (_id, ctx) =>
      wrapLanguageModel({
        model: model as never,
        middleware: {
          specificationVersion: 'v4',
          transformParams: async ({ params }) => {
            const credential = await ctx.credential()
            tokens.push(
              credential?.type === 'oauth' ? credential.access : undefined,
            )
            return params
          },
        },
      }),
  }
  const t = createTestVela({ providers: { fake: provider } })
  // Nothing is available before signing in
  expect(t.vela.models()).toEqual([])
  expect(t.vela.models({ all: true })).toEqual([])
  await t.vela.login('fake', 'oauth', {
    signal: new AbortController().signal,
    prompt: async () => '',
    notify: () => {},
  })
  t.session.setModel('fake/m')
  await t.run('first')
  await t.run('second')
  // The stored token expired within 5 minutes: refreshed before the first request, then reused
  expect(tokens).toEqual(['a2', 'a2'])
  expect(refreshes).toBe(1)
  expect(await t.vela.logout('fake')).toBe(true)
  expect(await t.vela.logout('fake')).toBe(false)
})

test('switching models drops an earlier model reasoning and keeps its own', async () => {
  const a = createFauxModel({ modelId: 'a' })
  const b = createFauxModel({ modelId: 'b' })
  const providers = {
    fake: {
      createModel: (id: string) => {
        if (id === 'a') return a
        if (id === 'b') return b
        throw new Error(`unknown model ${id}`)
      },
    },
  }
  a.push({ text: 'from a', reasoning: 'thinking of a' })
  b.push(fauxText('from b'))
  b.push(fauxText('from b after a resume'))
  a.push(fauxText('from a again'))
  const t = createTestVela({ model: 'fake/a', providers })

  await t.run('one')
  t.session.setModel('fake/b')
  await t.run('two')

  // A resumed session still knows which model wrote the reasoning of its history
  const resumed = createTestVela({ cwd: t.cwd, model: 'fake/b', providers })
  expect(await resumed.session.resume()).toBe(true)
  await resumed.session.prompt('three')
  resumed.session.setModel('fake/a')
  await resumed.session.prompt('four')

  const reasoningIn = (model: typeof a) =>
    model.calls.flatMap((call) =>
      call.prompt.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.flatMap((part) =>
              part.type === 'reasoning' ? [part.text] : [],
            )
          : [],
      ),
    )
  // The other model never receives it; the model that wrote it still gets it back
  expect(reasoningIn(b)).toEqual([])
  expect(reasoningIn(a)).toEqual(['thinking of a'])
})

test('a model switched during a run keeps the reasoning with the model of that run', async () => {
  const a = createFauxModel({ modelId: 'a' })
  const b = createFauxModel({ modelId: 'b' })
  let release!: () => void
  const blocked = new Promise<void>((resolve) => (release = resolve))
  const providers = {
    fake: {
      createModel: (id: string) => {
        if (id === 'a') return a
        if (id === 'b') return b
        throw new Error(`unknown model ${id}`)
      },
    },
  }
  a.push({
    reasoning: 'thinking of a',
    toolCalls: [{ name: 'wait_tool', input: {} }],
  })
  a.push(fauxText('from a'))
  const t = createTestVela({ model: 'fake/a', providers })
  t.internals.registry.register({
    name: 'wait_tool',
    description: 'waits until the test lets it finish',
    inputSchema: z.object({}),
    execute: async () => {
      await blocked
      return 'done'
    },
  })

  const running = t.run('go')
  while (t.eventsOf('tool_execution_start').length === 0) await Bun.sleep(1)
  // The run continues with the model it started with
  t.session.setModel('fake/b')
  release()
  await running

  // The second step still goes to A, and A gets its own reasoning back
  expect(JSON.stringify(a.calls[1]!.prompt).includes('thinking of a')).toBe(
    true,
  )
  // Both assistant messages of the run belong to A, not to the model chosen meanwhile
  const producer = describeModel(a).ref
  const producedBy = t.session
    .getEntries()
    .flatMap((entry) =>
      entry.type === 'message' && entry.message.role === 'assistant'
        ? [entry.producedBy]
        : [],
    )
  expect(producedBy).toEqual([producer, producer])
  // So the model chosen during the run does not get that run's reasoning afterwards
  b.push(fauxText('from b'))
  await t.session.prompt('after')
  expect(JSON.stringify(b.calls[0]!.prompt).includes('thinking of a')).toBe(
    false,
  )
})

test('a model selected by a before_agent_start hook sends and records its own reasoning', async () => {
  const a = createFauxModel({ modelId: 'a' })
  const b = createFauxModel({ modelId: 'b' })
  const providers = {
    fake: {
      createModel: (id: string) => {
        if (id === 'a') return a
        if (id === 'b') return b
        throw new Error(`unknown model ${id}`)
      },
    },
  }
  a.push({ text: 'from a', reasoning: 'thinking of a' })
  // The hook sends this prompt to B: B runs, so B's reasoning is B's
  b.push({ text: 'from b', reasoning: 'thinking of b' })
  a.push(fauxText('from a again'))
  const t = createTestVela({
    model: 'fake/a',
    providers,
    extensions: [
      (vela) => {
        vela.on('before_agent_start', (event, ctx) => {
          if (event.prompt === 'route to b') ctx.session.setModel('fake/b')
        })
      },
    ],
  })

  await t.run('one')
  await t.run('route to b')
  t.session.setModel('fake/a')
  await t.run('three')

  // B never got A's reasoning, and A never got B's
  expect(JSON.stringify(b.calls[0]!.prompt)).not.toContain('thinking of a')
  expect(JSON.stringify(a.calls[1]!.prompt)).not.toContain('thinking of b')
  expect(JSON.stringify(a.calls[1]!.prompt)).toContain('thinking of a')
  // Each message is recorded with the model that produced it
  const identities = [describeModel(a).ref, describeModel(b).ref]
  expect(
    t.session
      .getEntries()
      .flatMap((entry) =>
        entry.type === 'message' && entry.message.role === 'assistant'
          ? [entry.producedBy]
          : [],
      ),
  ).toEqual([identities[0], identities[1], identities[0]])
})

test('selecting the same model object again keeps its own reasoning', async () => {
  const a = createFauxModel({ modelId: 'a' })
  const providers = {
    fake: {
      createModel: (id: string) => {
        if (id === 'a') return a
        throw new Error(`unknown model ${id}`)
      },
    },
  }
  a.push({ text: 'from a', reasoning: 'thinking of a' })
  a.push(fauxText('from a again'))
  const t = createTestVela({ model: 'fake/a', providers })

  await t.run('one')
  // The same model, now chosen as the object it is: nothing changed for the provider
  t.session.setModel(t.session.model)
  await t.run('two')

  expect(JSON.stringify(a.calls[1]!.prompt)).toContain('thinking of a')
})
