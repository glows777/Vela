import { expect, test } from 'bun:test'
import {
  mmrSelect,
  normalizeFtsQuery,
  normalizeMinMax,
  type SearchResult,
} from '../../../src/rag/search'

function makeResult(id: string, text: string, score: number): SearchResult {
  return {
    chunk: {
      id,
      text,
      source: 'test.md',
      index: 0,
      tokenEstimate: Math.ceil(text.length / 4),
      embedding: [],
      addedAt: 0,
    },
    score,
    vectorScore: score,
    keywordScore: 0,
  }
}

test('normalizes empty, single, and same-score results to a neutral score', () => {
  expect(normalizeMinMax([])).toEqual([])
  expect(normalizeMinMax([0.42])).toEqual([0.5])
  expect(normalizeMinMax([3, 3, 3])).toEqual([0.5, 0.5, 0.5])
  expect(normalizeMinMax([1, 2, 3])).toEqual([0, 0.5, 1])
})

test('turns natural language into safe FTS5 terms', () => {
  expect(normalizeFtsQuery('sqlite-vec')).toBe('"sqlite" "vec"')
  expect(normalizeFtsQuery('Bun file IO 🚀')).toBe('"bun" "file" "io"')
  expect(normalizeFtsQuery('OR NOT !!!')).toBe('"or" "not"')
})

test('preserves tokenizer-driven MMR deduplication', () => {
  const results = [
    makeResult('first', 'Bun 中文 documentation', 0.9),
    makeResult('duplicate', 'bun 中文 guide', 0.8),
    makeResult('distinct', 'sqlite vector storage', 0.7),
  ]

  expect(mmrSelect(results, 2).map((result) => result.chunk.id)).toEqual([
    'first',
    'distinct',
  ])
})
