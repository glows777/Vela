import { expect, test } from 'bun:test'
import { createFauxEmbedder } from '../../../src/testing/faux-embedder'

const cosine = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i]!, 0)

test('same text, same unit vector of the configured size', async () => {
  const embed = createFauxEmbedder()
  const [a, b] = await embed(['部署回滚', '部署回滚'])
  expect(a).toHaveLength(128)
  expect(a).toEqual(b!)
  expect(Math.hypot(...a!)).toBeCloseTo(1)
})

test('overlapping words score higher than unrelated text', async () => {
  const embed = createFauxEmbedder()
  const [query, close, far] = await embed(['怎么回滚部署', '回滚部署时执行 deploy rollback', '告警通过飞书机器人发送'])
  expect(cosine(query!, close!)).toBeGreaterThan(cosine(query!, far!))
})

test('empty text still yields a valid vector and the call can be observed', async () => {
  const calls: string[][] = []
  const embed = createFauxEmbedder({ dims: 8, onCall: (texts) => calls.push(texts) })
  const [v] = await embed([''])
  expect(v).toHaveLength(8)
  expect(calls).toEqual([['']])
})
