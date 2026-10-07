import { expect, test } from 'bun:test'
import { SqliteVectorStore } from '../../../src/rag/sqllite-store'

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
