import { expect, test } from 'bun:test'
import { embed } from '../../../../src/extensions/rag/embedder.ts'
import { createFauxEmbedder } from '../../../../src/testing/faux-embedder.ts'

test('embed() caches vectors per text for the same embedder', async () => {
  const calls: string[][] = []
  const embedder = createFauxEmbedder({ onCall: (texts) => calls.push(texts) })
  const [first] = await embed(embedder, ['cache me'])
  const [second] = await embed(embedder, ['cache me', 'new text'])
  expect(second).toEqual(first)
  expect(calls).toEqual([['cache me'], ['new text']])
})

test('switching embedder does not reuse vectors cached by the old one', async () => {
  const oldCalls: string[][] = []
  const newCalls: string[][] = []
  const oldEmbedder = createFauxEmbedder({
    dims: 8,
    onCall: (t) => oldCalls.push(t),
  })
  const newEmbedder = createFauxEmbedder({
    dims: 16,
    onCall: (t) => newCalls.push(t),
  })

  const [oldVec] = await embed(oldEmbedder, ['same text'])
  const [newVec] = await embed(newEmbedder, ['same text'])

  expect(oldVec).toHaveLength(8)
  expect(newVec).toHaveLength(16)
  expect(oldCalls).toEqual([['same text']])
  expect(newCalls).toEqual([['same text']])
})
