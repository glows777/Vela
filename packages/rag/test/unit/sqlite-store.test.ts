import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqlite } from '../../src/sqlite.ts'
import { SqliteVectorStore } from '../../src/sqlite-store.ts'

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
  store.replaceSource('b.md', [
    { chunk: chunk('b.md', 0, 'beta only'), embedding },
  ])

  // Same ids again (vec0 rejects INSERT OR REPLACE), and fewer chunks than before
  store.replaceSource('a.md', [
    { chunk: chunk('a.md', 0, 'alpha rewritten'), embedding },
  ])

  expect(store.size()).toBe(2)
  expect(store.sources().sort()).toEqual(['a.md', 'b.md'])
  expect(store.keywordSearch('alpha', 10).map((r) => r.chunk.text)).toEqual([
    'alpha rewritten',
  ])
  expect(
    store
      .vectorSearch(embedding, 10)
      .map((r) => r.chunk.id)
      .sort(),
  ).toEqual(['a.md#0', 'b.md#0'])
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

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})
const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'vela-rag-'))
  tempDirs.push(dir)
  return join(dir, 'knowledge.db')
}

test('the store records its embedder and refuses vectors from another one', () => {
  const path = tempDb()
  const first = new SqliteVectorStore(path, { embedder: 'model-a' })
  first.add(chunk('a.md', 0, 'alpha'), embedding)

  const other = new SqliteVectorStore(path, { embedder: 'model-b' })
  expect(other.storedEmbedder()).toBe('model-a')
  const mismatch =
    /built with the embedder "model-a", but the configured embedder is "model-b"/
  expect(() => other.vectorSearch(embedding, 5)).toThrow(mismatch)
  expect(() => other.add(chunk('b.md', 0, 'beta'), embedding)).toThrow(mismatch)
  expect(() => other.replaceSource('b.md', [])).toThrow(mismatch)
  // Keyword search needs no vectors
  expect(other.keywordSearch('alpha', 5)).toHaveLength(1)

  // Clearing hands the store to the configured embedder, also for later opens
  other.clear()
  other.add(chunk('b.md', 0, 'beta'), embedding)
  expect(new SqliteVectorStore(path, { embedder: 'model-b' }).size()).toBe(1)
  expect(() =>
    new SqliteVectorStore(path, { embedder: 'model-a' }).vectorSearch(
      embedding,
      5,
    ),
  ).toThrow(/built with the embedder "model-b"/)
})

test('an empty store takes the configured embedder', () => {
  const path = tempDb()
  new SqliteVectorStore(path, { embedder: 'model-a' })
  const store = new SqliteVectorStore(path, { embedder: 'model-b' })
  expect(store.storedEmbedder()).toBe('model-b')
  store.add(chunk('a.md', 0, 'alpha'), embedding)
  expect(store.assumedEmbedder).toBe(false)
})

test('a store without an embedder record (Vela 0.1.0) assumes the configured one and says so', () => {
  const path = tempDb()
  new SqliteVectorStore(path, { embedder: 'model-a' }).add(
    chunk('a.md', 0, 'alpha'),
    embedding,
  )
  openSqlite(path).exec('DROP TABLE meta')
  const store = new SqliteVectorStore(path, { embedder: 'model-b' })
  expect(store.assumedEmbedder).toBe(true)
  expect(store.storedEmbedder()).toBe('model-b')
  expect(store.vectorSearch(embedding, 5)).toHaveLength(1)
  expect(
    new SqliteVectorStore(path, { embedder: 'model-b' }).assumedEmbedder,
  ).toBe(false)
})

test('vectors with the wrong number of dimensions are refused with a clear error', () => {
  const store = new SqliteVectorStore(':memory:', { embedder: 'small' })
  expect(() => store.add(chunk('a.md', 0, 'alpha'), [0.1, 0.2])).toThrow(
    'The embedder "small" returned 2-dimension vectors; the knowledge base stores 128 dimensions',
  )
})

test('two open stores on one file (two processes sharing the data dir) never mix embedders', () => {
  const path = tempDb()
  // Both open while the file is empty
  const a = new SqliteVectorStore(path, { embedder: 'model-a' })
  const b = new SqliteVectorStore(path, { embedder: 'model-b' })
  b.add(chunk('b.md', 0, 'beta'), embedding)
  expect(() => a.add(chunk('a.md', 0, 'alpha'), embedding)).toThrow(
    /built with the embedder "model-b", but the configured embedder is "model-a"/,
  )
  expect(a.storedEmbedder()).toBe('model-b')

  // A clear in one store is seen by the other: the empty file belongs to whoever writes next
  a.clear()
  expect(() => b.vectorSearch(embedding, 5)).not.toThrow()
  a.add(chunk('a.md', 0, 'alpha'), embedding)
  expect(() => b.vectorSearch(embedding, 5)).toThrow(
    /built with the embedder "model-a"/,
  )
})
