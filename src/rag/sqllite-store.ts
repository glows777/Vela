import { existsSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import * as sqliteVec from 'sqlite-vec'
import type { Chunk } from './chunker'
import { type EmbeddingFn, embed } from './embedder'
import { mmrSelect, normalizeMinMax, type SearchResult } from './search'

export interface StoredChunk extends Chunk {
  embedding: number[]
  addedAt: number
}

// bun:sqlite 内置的 sqlite 不带 loadExtension，无法加载 sqlite-vec 扩展；
// 需要换成系统里带扩展支持的 sqlite3（macOS 上是 Homebrew 装的）
const CUSTOM_SQLITE_CANDIDATES = [
  '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib', // Apple Silicon Mac
  '/usr/local/opt/sqlite/lib/libsqlite3.dylib', // Intel Mac
  '/usr/lib/x86_64-linux-gnu/libsqlite3.so.0', // Linux x64
  '/usr/lib/aarch64-linux-gnu/libsqlite3.so.0', // Linux ARM64
]

let customSqliteLoaded = false

function loadCustomSqlite(): void {
  if (customSqliteLoaded) return
  const path = CUSTOM_SQLITE_CANDIDATES.find((p) => existsSync(p))
  if (!path) {
    throw new Error(
      '未找到带扩展支持的 sqlite3：请安装 Homebrew sqlite（brew install sqlite3），bun:sqlite 内置库不支持 sqlite-vec',
    )
  }
  Database.setCustomSQLite(path)
  customSqliteLoaded = true
}

export class SqliteVectorStore {
  private db: Database

  constructor(dbPath: string = 'knowledge.db') {
    loadCustomSqlite()
    this.db = new Database(dbPath)
    sqliteVec.load(this.db) // 加载向量搜索扩展
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

  add(chunk: Chunk, embedding: number[]): void {
    const now = Date.now()
    // 三表联动写入
    this.db
      .prepare(`INSERT OR REPLACE INTO chunks
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
      .prepare(`INSERT OR REPLACE INTO chunks_vec (id, embedding)
      VALUES (?, ?)`)
      .run(chunk.id, Buffer.from(new Float32Array(embedding).buffer))

    this.db
      .prepare(`INSERT OR REPLACE INTO chunks_fts (id, text, source)
      VALUES (?, ?, ?)`)
      .run(chunk.id, chunk.text, chunk.source)
  }

  addBatch(items: Array<{ chunk: Chunk; embedding: number[] }>): void {
    const tx = this.db.transaction(() => {
      for (const { chunk, embedding } of items) this.add(chunk, embedding)
    })
    tx() // 事务批量写入，比逐条快很多
  }

  vectorSearch(
    queryEmbedding: number[],
    topK: number,
  ): Array<{ chunk: StoredChunk; score: number }> {
    const buf = Buffer.from(new Float32Array(queryEmbedding).buffer)
    const rows = this.db
      .prepare(`
      SELECT v.id, v.distance, c.text, c.source, c.chunk_index, c.embedding
      FROM chunks_vec v
      JOIN chunks c ON c.id = v.id
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance
    `)
      .all(buf, topK) as any[]

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
    const rows = this.db
      .prepare(`
      SELECT f.id, bm25(chunks_fts) AS rank, c.text, c.source, c.chunk_index, c.embedding
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.id
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `)
      .all(query, topK) as any[]

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
    return (this.db.prepare('SELECT COUNT(*) as n FROM chunks').get() as any).n
  }

  clear(): void {
    this.db.exec(
      'DELETE FROM chunks; DELETE FROM chunks_vec; DELETE FROM chunks_fts;',
    )
  }

  sources(): string[] {
    return (
      this.db.prepare('SELECT DISTINCT source FROM chunks').all() as any[]
    ).map((r) => r.source)
  }

  // 混合搜索：直接在 SQLite 层完成向量 + 关键词双路检索
  async hybridSearch(
    embedFn: EmbeddingFn,
    query: string,
    topK: number = 5,
  ): Promise<SearchResult[]> {
    const candidateCount = Math.min(topK * 4, this.size())
    if (candidateCount === 0) return []

    const [queryVec] = await embed(embedFn, [query])

    if (!queryVec) {
      throw new Error('query embed 失败')
    }

    // 路径 1: sqlite-vec 向量搜索
    const vectorResults = this.vectorSearch(queryVec, candidateCount)

    // 路径 2: FTS5 关键词搜索
    const keywordResults = this.keywordSearch(query, candidateCount)

    // 归一化 + 加权合并
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
