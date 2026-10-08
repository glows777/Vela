import * as sqliteVec from 'sqlite-vec'
import type { Chunk } from './chunker.ts'
import { type EmbeddingFn, embed } from './embedder.ts'
import {
  mmrSelect,
  normalizeFtsQuery,
  normalizeMinMax,
  type SearchResult,
} from './search.ts'
import { openSqlite, type SqliteDatabase, transaction } from './sqlite.ts'

export interface StoredChunk extends Chunk {
  embedding: number[]
  addedAt: number
}

/** A row joined from the chunks table (embedding stored as a JSON string) */
interface ChunkRow {
  id: string
  text: string
  source: string
  chunk_index: number
  embedding: string
}

export class SqliteVectorStore {
  private db: SqliteDatabase

  constructor(dbPath: string = 'knowledge.db') {
    this.db = openSqlite(dbPath)
    sqliteVec.load(this.db) // vector search extension
    this.createTables()
  }

  private createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        embedding TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'text-embedding-v3',
        updated_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[128]
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text, id UNINDEXED, source UNINDEXED
      );
    `)
  }

  /** Adds a chunk; a chunk with the same id is replaced in all three tables. */
  add(chunk: Chunk, embedding: number[]): void {
    const now = Date.now()
    // vec0 rejects INSERT OR REPLACE and chunks_fts has no primary key, so delete first
    this.deleteId(chunk.id)
    // Write all three tables
    this.db
      .prepare(`INSERT INTO chunks
      (id, text, source, chunk_index, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        chunk.id,
        chunk.text,
        chunk.source,
        chunk.index,
        JSON.stringify(embedding),
        now,
      )

    this.db
      .prepare(`INSERT INTO chunks_vec (id, embedding)
      VALUES (?, ?)`)
      .run(chunk.id, new Uint8Array(new Float32Array(embedding).buffer))

    this.db
      .prepare(`INSERT INTO chunks_fts (id, text, source)
      VALUES (?, ?, ?)`)
      .run(chunk.id, chunk.text, chunk.source)
  }

  /** Replaces every chunk of `source` with `items` in one transaction (re-ingesting a document). */
  replaceSource(
    source: string,
    items: Array<{ chunk: Chunk; embedding: number[] }>,
  ): void {
    transaction(this.db, () => {
      this.deleteSource(source)
      for (const { chunk, embedding } of items) this.add(chunk, embedding)
    })
  }

  /** Deletes all chunks of `source` from all three tables. */
  private deleteSource(source: string): void {
    const rows = this.db
      .prepare('SELECT id FROM chunks WHERE source = ?')
      .all(source) as { id: string }[]
    for (const { id } of rows) this.deleteId(id)
  }

  /** Deletes one chunk id from all three tables. */
  private deleteId(id: string): void {
    this.db.prepare('DELETE FROM chunks WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM chunks_vec WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM chunks_fts WHERE id = ?').run(id)
  }

  vectorSearch(
    queryEmbedding: number[],
    topK: number,
  ): Array<{ chunk: StoredChunk; score: number }> {
    const buf = new Uint8Array(new Float32Array(queryEmbedding).buffer)
    const rows = this.db
      .prepare(`
      SELECT v.id, v.distance, c.text, c.source, c.chunk_index, c.embedding
      FROM chunks_vec v
      JOIN chunks c ON c.id = v.id
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance
    `)
      .all(buf, topK) as (ChunkRow & { distance: number })[]

    return rows.map((r) => ({
      chunk: {
        id: r.id,
        text: r.text,
        source: r.source,
        index: r.chunk_index,
        tokenEstimate: Math.ceil(r.text.length / 4),
        embedding: JSON.parse(r.embedding),
        addedAt: 0,
      },
      score: 1 - r.distance, // distance → similarity
    }))
  }

  keywordSearch(
    query: string,
    topK: number,
  ): Array<{ chunk: StoredChunk; score: number }> {
    const ftsQuery = normalizeFtsQuery(query)
    if (!ftsQuery) return []

    const rows = this.db
      .prepare(`
      SELECT f.id, bm25(chunks_fts) AS rank, c.text, c.source, c.chunk_index, c.embedding
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.id
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `)
      .all(ftsQuery, topK) as (ChunkRow & { rank: number })[]

    return rows.map((r) => ({
      chunk: {
        id: r.id,
        text: r.text,
        source: r.source,
        index: r.chunk_index,
        tokenEstimate: Math.ceil(r.text.length / 4),
        embedding: JSON.parse(r.embedding),
        addedAt: 0,
      },
      score: r.rank < 0 ? -r.rank / (1 - r.rank) : 1 / (1 + r.rank),
    }))
  }

  size(): number {
    return (
      this.db.prepare('SELECT COUNT(*) as n FROM chunks').get() as { n: number }
    ).n
  }

  clear(): void {
    this.db.exec(
      'DELETE FROM chunks; DELETE FROM chunks_vec; DELETE FROM chunks_fts;',
    )
  }

  sources(): string[] {
    return (
      this.db.prepare('SELECT DISTINCT source FROM chunks').all() as {
        source: string
      }[]
    ).map((r) => r.source)
  }

  // Hybrid search: vector and keyword retrieval, both done in SQLite
  async hybridSearch(
    embedFn: EmbeddingFn,
    query: string,
    topK: number = 5,
  ): Promise<SearchResult[]> {
    const candidateCount = Math.min(topK * 4, this.size())
    if (candidateCount === 0) return []

    const [queryVec] = await embed(embedFn, [query])

    if (!queryVec) {
      throw new Error('Failed to embed the query')
    }

    // Path 1: sqlite-vec vector search
    const vectorResults = this.vectorSearch(queryVec, candidateCount)

    // Path 2: FTS5 keyword search
    const keywordResults = this.keywordSearch(query, candidateCount)

    // Normalize, then merge with weights
    const vecScores = normalizeMinMax(vectorResults.map((r) => r.score))
    const kwScores = normalizeMinMax(keywordResults.map((r) => r.score))

    const candidates = new Map<string, SearchResult>()
    for (let i = 0; i < vectorResults.length; i++) {
      const id = vectorResults[i]!.chunk.id
      candidates.set(id, {
        chunk: vectorResults[i]!.chunk,
        score: vecScores[i]! * 0.7,
        vectorScore: vecScores[i]!,
        keywordScore: 0,
      })
    }
    for (let i = 0; i < keywordResults.length; i++) {
      const id = keywordResults[i]!.chunk.id
      const existing = candidates.get(id)
      if (existing) {
        existing.keywordScore = kwScores[i]!
        existing.score += kwScores[i]! * 0.3
      } else {
        candidates.set(id, {
          chunk: keywordResults[i]!.chunk,
          score: kwScores[i]! * 0.3,
          vectorScore: 0,
          keywordScore: kwScores[i]!,
        })
      }
    }

    const sorted = [...candidates.values()].sort((a, b) => b.score - a.score)

    // MMR deduplication
    return mmrSelect(sorted, topK)
  }
}
