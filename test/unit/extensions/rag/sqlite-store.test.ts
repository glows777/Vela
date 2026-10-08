import { expect, test } from 'bun:test'
import { SqliteVectorStore } from '../../../../src/extensions/rag/sqlite-store.ts'

const embedding = Array.from({ length: 128 }, (_, index) => index / 128)

test('keyword search safely handles terms, unicode, emoji, and empty input', () => {
  const store = new SqliteVectorStore(':memory:')
  store.add(
    {
      id: 'test.md#0',
      text: 'sqlite-vec is an English vector extension for 中文检索 🚀',
      source: 'test.md',
      index: 0,
      tokenEstimate: 16,
    },
    embedding,
  )

  expect(() => store.keywordSearch('sqlite-vec', 5)).not.toThrow()
  expect(
    store.keywordSearch('sqlite-vec', 5).map((result) => result.chunk.id),
  ).toEqual(['test.md#0'])
  expect(store.keywordSearch('English', 5)).toHaveLength(1)

  for (const query of ['中文', '🚀', '!!!', '']) {
    expect(() => store.keywordSearch(query, 5)).not.toThrow()
  }
})

const chunk = (source: string, index: number, text: string) => ({
  id: `${source}#${index}`,
  text,
  source,
  index,
  tokenEstimate: Math.ceil(text.length / 4),
})

test('re-ingesting a source replaces all of its old chunks', () => {
  const store = new SqliteVectorStore(':memory:')
  store.replaceSource('a.md', [
    { chunk: chunk('a.md', 0, 'alpha first'), embedding },
    { chunk: chunk('a.md', 1, 'alpha second'), embedding },
    { chunk: chunk('a.md', 2, 'alpha third'), embedding },
  ])
  store.replaceSource('b.md', [{ chunk: chunk('b.md', 0, 'beta only'), embedding }])

  // Same ids again (vec0 rejects INSERT OR REPLACE), and fewer chunks than before
  store.replaceSource('a.md', [{ chunk: chunk('a.md', 0, 'alpha rewritten'), embedding }])

  expect(store.size()).toBe(2)
  expect(store.sources().sort()).toEqual(['a.md', 'b.md'])
  expect(store.keywordSearch('alpha', 10).map((r) => r.chunk.text)).toEqual([
    'alpha rewritten',
  ])
  expect(store.vectorSearch(embedding, 10).map((r) => r.chunk.id).sort()).toEqual([
    'a.md#0',
    'b.md#0',
  ])
})

test('adding a chunk with an existing id replaces it in every table', () => {
  const store = new SqliteVectorStore(':memory:')
  store.add(chunk('a.md', 0, 'old text'), embedding)
  store.add(chunk('a.md', 0, 'new text'), embedding)
  expect(store.size()).toBe(1)
  expect(store.keywordSearch('old', 10)).toEqual([])
  expect(store.keywordSearch('new', 10)).toHaveLength(1)
  expect(store.vectorSearch(embedding, 10)).toHaveLength(1)
})
