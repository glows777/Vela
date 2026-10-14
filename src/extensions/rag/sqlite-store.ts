import * as sqliteVec from 'sqlite-vec'
import type { Chunk } from './chunker.ts'
import { DIMS, type EmbeddingFn, embed } from './embedder.ts'
import {
  mmrSelect,
  normalizeFtsQuery,
  normalizeMinMax,
  type SearchResult,
} from './search.ts'
import {
  closeSqlite,
  openSqlite,
  type SqliteDatabase,
  transaction,
} from './sqlite.ts'

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

/** Embedder id used when the embedding function has none */
export const UNNAMED_EMBEDDER = 'custom'

export class SqliteVectorStore {
  private db: SqliteDatabase
  private closed = false
  /** Id of the embedder this store embeds with */
  readonly embedder: string
  /** True when the file had chunks but no embedder record (built before Vela 0.2.0) and `embedder` was assumed */
  readonly assumedEmbedder: boolean = false

  constructor(
    dbPath: string = 'knowledge.db',
    options: { embedder?: string } = {},
  ) {
    this.db = openSqlite(dbPath)
    sqliteVec.load(this.db) // vector search extension
    this.createTables()
    this.embedder = options.embedder ?? UNNAMED_EMBEDDER
    if (this.readMeta('embedder') === undefined) {
      this.assumedEmbedder = this.size() > 0
      this.writeMeta('embedder', this.embedder)
    }
  }

  /** Releases the native database immediately; repeated calls are harmless. */
  close(): void {
    if (this.closed) return
    closeSqlite(this.db)
    this.closed = true
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('The knowledge base is closed')
  }

  /** The embedder that made the stored vectors (the file's record); an empty store belongs to the configured one */
  storedEmbedder(): string {
    this.assertOpen()
    const recorded = this.readMeta('embedder')
    return recorded === undefined || this.size() === 0
      ? this.embedder
      : recorded
  }

  /**
   * Fails when the stored vectors come from another embedder: their scores can't be compared with this one's.
   * Read from the file on every call, because another process (another project's settings) may share the data dir.
   * An empty store is taken over by the configured embedder.
   */
  private assertEmbedder(): void {
    this.assertOpen()
    const recorded = this.readMeta('embedder')
    if (recorded === this.embedder) return
    if (recorded === undefined || this.size() === 0) {
      this.writeMeta('embedder', this.embedder)
      return
    }
    throw new Error(
      `The knowledge base was built with the embedder "${recorded}", but the configured embedder is "${this.embedder}". Vectors from different models can't be compared: switch back to "${recorded}", or run /rag clear and ingest the documents again.`,
    )
  }

  private assertDimensions(vector: number[]): void {
    if (vector.length !== DIMS)
      throw new Error(
        `The embedder "${this.embedder}" returned ${vector.length}-dimension vectors; the knowledge base stores ${DIMS} dimensions`,
      )
  }

  private readMeta(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(key) as { value: string } | undefined
    return row?.value
  }

  private writeMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(key, value)
  }

  private createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
    this.assertEmbedder()
    this.assertDimensions(embedding)
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
    this.assertEmbedder()
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
    this.assertEmbedder()
    this.assertDimensions(queryEmbedding)
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
    this.assertOpen()
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
    this.assertOpen()
    return (
      this.db.prepare('SELECT COUNT(*) as n FROM chunks').get() as { n: number }
    ).n
  }

  /** Deletes every chunk; the store then belongs to the configured embedder. */
  clear(): void {
    this.assertOpen()
    transaction(this.db, () => {
      this.db.exec(
        'DELETE FROM chunks; DELETE FROM chunks_vec; DELETE FROM chunks_fts;',
      )
      this.writeMeta('embedder', this.embedder)
    })
  }

  sources(): string[] {
    this.assertOpen()
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
    this.assertEmbedder()

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
