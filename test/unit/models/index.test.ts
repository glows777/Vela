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
  // 没列出的 id 也能用（没有内置模型目录），id 里可以有 /
  const unlisted = registry.resolve('p/vendor/model-x')
  expect(unlisted.info).toEqual({ id: 'vendor/model-x', provider: 'p', ref: 'p/vendor/model-x' })
  expect((unlisted.model as { modelId: string }).modelId).toBe('vendor/model-x')
  expect(registry.list().map((m) => m.ref)).toEqual(['p/m'])
})

test('resolve and register report mistakes', () => {
  const registry = new ModelRegistry({ p: provider() })
  expect(() => registry.resolve('m')).toThrow('模型要写成 provider/id')
  expect(() => registry.resolve('p/')).toThrow('模型要写成 provider/id')
  expect(() => registry.resolve('q/m')).toThrow('没有名为 q 的 provider（已有: p）')
  expect(() => registry.register('p', provider())).toThrow('provider p 已经注册过')
  expect(() => registry.register('a b', provider())).toThrow('无效的 provider 名')
})

test('thinking levels map to the AI SDK reasoning option', () => {
  const m = { id: 'm', provider: 'p', ref: 'p/m' }
  expect(reasoningOption('off', m)).toBe('none')
  expect(reasoningOption('high', m)).toBe('high')
  expect(reasoningOption('max', m)).toBe('xhigh')
  // 声明不支持 thinking 的模型：off 不发参数，其它级别报错而不是悄悄忽略
  expect(reasoningOption('off', { ...m, reasoning: false })).toBeUndefined()
  expect(() => reasoningOption('medium', { ...m, reasoning: false })).toThrow(
    '模型 p/m 不支持 thinking',
  )
})

test('context limits follow the model window; explicit limits win', () => {
  expect(limitsForModel({})).toEqual({ ...DEFAULT_LIMITS })
  const small = limitsForModel({ contextWindow: 32_768 })
  expect(small).toMatchObject({
    // 同 pi：给输出留 16384
    maxInputTokens: 16_384,
    // 摘要请求本身要放得下：比输入上限低 10% 窗口
    summaryThreshold: 13_108,
    microcompactThreshold: 10_486,
    minMicroSavings: 3_276,
    maxRetries: DEFAULT_LIMITS.maxRetries,
  })
  // 200k 窗口得到的就是现在的默认值
  expect(limitsForModel({ contextWindow: 200_000 })).toEqual({ ...DEFAULT_LIMITS })
  // 很小的窗口最多留一半给输出
  expect(limitsForModel({ contextWindow: 16_000 }).maxInputTokens).toBe(8_000)
  expect(
    limitsForModel({ contextWindow: 32_768 }, { maxInputTokens: 30_000 })
      .maxInputTokens,
  ).toBe(30_000)
})
