import { afterEach, expect, test } from 'bun:test'
import type { VelaLogger } from '../../src/logger'
import { createVela } from '../../src/vela'
import type { ProviderDefinition } from '../../src/models'
import { createFauxModel, fauxText } from '../../src/testing/faux'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
  tempDir,
} from '../support/vela'

afterEach(cleanupTestVelas)

/** 一个 provider "fake"：big 有 32k 窗口和价格，plain 不支持 thinking；每个模型一个 faux */
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
  big.push(fauxText('来自 big', { usage: { input: 3, output: 1 } }))
  const t = createTestVela({ model: 'fake/big', providers })

  expect(t.vela.models().map((m) => m.ref)).toEqual(['fake/big', 'fake/plain'])
  expect(t.session.modelInfo).toMatchObject({
    provider: 'fake',
    id: 'big',
    ref: 'fake/big',
    contextWindow: 32_768,
  })
  expect(t.session.limits.tokenBudget).toBe(32_768)
  expect(t.session.tracker.contextWindow).toBe(32_768)

  await t.run('你好')
  expect(t.lastAssistantText()).toBe('来自 big')
  // models.json 里的价格优先于内置价目表：3 个输入 token × $1/token
  expect(t.session.usage.totals.cost).toBeCloseTo(3)
})

test('setModel switches the model for the next prompt and recomputes limits', async () => {
  const { big, plain, providers } = fakeProvider()
  big.push(fauxText('big'))
  plain.push(fauxText('plain'))
  const t = createTestVela({ model: 'fake/big', providers })

  await t.run('一')
  t.session.setModel('fake/plain')
  expect(t.session.modelInfo.ref).toBe('fake/plain')
  // plain 没写窗口：回到默认上限
  expect(t.session.limits.tokenBudget).toBe(200_000)
  expect(t.session.tracker.contextWindow).toBe(200_000)
  await t.run('二')

  expect(big.calls.map((c) => c.lastUserText)).toEqual(['一'])
  expect(plain.calls.map((c) => c.lastUserText)).toEqual(['二'])
  // 第二个模型看到完整历史
  expect(JSON.stringify(plain.calls[0]!.prompt)).toContain('一')

  expect(() => t.session.setModel('nope/x')).toThrow('没有名为 nope 的 provider')
  expect(() => t.session.setModel('fake')).toThrow('provider/id')
  expect(t.session.modelInfo.ref).toBe('fake/plain')
})

test('sessions pick models independently', async () => {
  const { big, plain, providers } = fakeProvider()
  big.push(fauxText('a'))
  plain.push(fauxText('b'))
  const t = createTestVela({ model: 'fake/big', providers })
  const other = t.vela.session('other', { model: 'fake/plain' })

  await t.run('问 a')
  await other.prompt('问 b')
  expect(big.calls).toHaveLength(1)
  expect(plain.calls).toHaveLength(1)
  expect(t.vela.model).toBe(big)
})

test('thinking levels map to the reasoning call option', async () => {
  const { big, plain, providers } = fakeProvider()
  big.push(fauxText('1'), fauxText('2'), fauxText('3'), fauxText('4'))
  plain.push(fauxText('5'))
  const t = createTestVela({ model: 'fake/big', providers })

  await t.run('默认')
  t.session.setThinkingLevel('high')
  await t.run('high')
  t.session.setThinkingLevel('max')
  await t.run('max')
  t.session.setThinkingLevel('off')
  await t.run('off')
  // 不支持 thinking 的模型不发 reasoning
  t.session.setModel('fake/plain')
  await t.run('plain')

  expect(big.calls.map((c) => c.reasoning)).toEqual([
    undefined,
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
    a.session.setThinkingLevel('medium')
    first.plain.push(fauxText('saved'))
    await a.run('保存')
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
    expect(b.session.thinkingLevel).toBe('medium')
    await b.run('继续')
    expect(second.plain.calls).toHaveLength(1)
    expect(second.big.calls).toHaveLength(0)
    await b.cleanup()
  } finally {
    dir.cleanup()
  }
})

test('a saved model that no longer resolves warns and keeps the current one', async () => {
  const dir = tempDir()
  try {
    const first = fakeProvider()
    first.plain.push(fauxText('saved'))
    const a = createTestVela({
      cwd: dir.path,
      model: 'fake/plain',
      providers: first.providers,
    })
    await a.run('保存')
    await a.cleanup()

    // 新的 Vela 没有 fake provider，只有直接传入的 faux 模型
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
    await expect(session.prompt('hi')).rejects.toThrow('没有选模型')
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
  expect(list.output).toContain('当前: fake/big')
  expect(list.output).toContain('* fake/big (33k)')
  expect(list.output).toContain('fake/plain (无 thinking)')

  const bad = await captureConsole(() => t.command('/model nope/x'))
  expect(bad.output).toContain('没有名为 nope 的 provider')
  await captureConsole(() => t.command('/model fake/plain'))
  expect(t.session.modelInfo.ref).toBe('fake/plain')

  await captureConsole(() => t.command('/thinking high'))
  expect(t.session.thinkingLevel).toBe('high')
  const wrong = await captureConsole(() => t.command('/thinking huge'))
  expect(wrong.output).toContain('只能是')
  expect(t.session.thinkingLevel).toBe('high')
  await captureConsole(() => t.command('/thinking default'))
  expect(t.session.thinkingLevel).toBeUndefined()
})
