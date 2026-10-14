import { afterEach, expect, spyOn, test } from 'bun:test'
import { readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { EmbeddingFn } from '../../src/extensions/rag/embedder.ts'
import { SqliteVectorStore } from '../../src/extensions/rag/sqlite-store.ts'
import { fauxToolCall } from '../../src/testing/faux.ts'
import { createFauxEmbedder } from '../../src/testing/faux-embedder.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

function databaseDescriptors(path: string) {
  return readdirSync('/proc/self/fd').filter((fd) => {
    try {
      const target = readlinkSync(`/proc/self/fd/${fd}`)
      return target === path || target.startsWith(`${path}-`)
    } catch {
      return false
    }
  })
}

test('repeated and concurrent disposal closes the shared RAG store once', async () => {
  const close = spyOn(SqliteVectorStore.prototype, 'close')
  try {
    const t = createTestVela({ embedder: true })
    t.vela.session('other')
    await Promise.all([t.vela.dispose(), t.vela.dispose()])
    await t.vela.dispose()
    expect(close).toHaveBeenCalledTimes(1)
    // Keep both the Vela and its registered RAG closures reachable after disposal.
    expect(
      t.internals.registry.getAllTools().map((tool) => tool.name),
    ).toContain('rag_search')
  } finally {
    close.mockRestore()
  }
})

test.skipIf(process.platform !== 'linux')(
  'a retained disposed Vela releases the knowledge database without forced GC',
  async () => {
    const t = createTestVela({
      embedder: true,
      files: { 'guide.md': 'An offline guide to deploying the service.' },
    })
    await t.run('/rag ingest guide.md')
    const path = join(t.dataDir, 'rag', 'knowledge.db')
    expect(databaseDescriptors(path).length).toBeGreaterThan(0)
    await t.vela.dispose()
    expect(databaseDescriptors(path)).toEqual([])
    expect(t.vela.dataDir).toBe(t.dataDir)
  },
)

test('disposal rejects a RAG command waiting for session startup before it can begin embedding', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let embeddings = 0
  const t = createTestVela({
    embedder: createFauxEmbedder({
      onCall: () => {
        embeddings++
      },
    }),
    files: { 'guide.md': 'A guide queued during session startup.' },
    extensions: [
      (vela) => {
        vela.on('session_start', async () => {
          entered.resolve()
          await release.promise
        })
      },
    ],
  })
  const running = t.run('/rag ingest guide.md').then(
    () => undefined,
    (error: unknown) => error,
  )
  await entered.promise
  const disposing = t.vela.dispose()
  try {
    release.resolve()
    const [error] = await Promise.all([running, disposing])
    expect(error).toMatchObject({ message: 'Session default is closed' })
    expect(embeddings).toBe(0)
    expect(t.eventsOf('notify')).toEqual([])
    if (process.platform === 'linux')
      expect(
        databaseDescriptors(join(t.dataDir, 'rag', 'knowledge.db')),
      ).toEqual([])
  } finally {
    release.resolve()
    await Promise.allSettled([running, disposing])
  }
})

test.each(['command', 'ingest', 'search'] as const)(
  'disposal drains an active RAG %s before closing SQLite, even when the embedder ignores abort',
  async (kind) => {
    const entered = Promise.withResolvers<AbortSignal | undefined>()
    const release = Promise.withResolvers<void>()
    const faux = createFauxEmbedder()
    let calls = 0
    let embedderSettled = false
    const embedder: EmbeddingFn = async (texts, signal) => {
      if (++calls === (kind === 'search' ? 2 : 1)) {
        entered.resolve(signal)
        await release.promise
        embedderSettled = true
      }
      return faux(texts)
    }
    const t = createTestVela({
      embedder,
      files: { 'guide.md': 'An offline guide to deploying the service.' },
      responses:
        kind === 'command'
          ? []
          : [
              fauxToolCall(
                kind === 'search' ? 'rag_search' : 'rag_ingest',
                kind === 'search'
                  ? { query: 'deploy service' }
                  : { path: 'guide.md' },
              ),
            ],
    })
    if (kind === 'search') await t.run('/rag ingest guide.md')
    const close = spyOn(SqliteVectorStore.prototype, 'close')
    const running = t
      .run(
        kind === 'command' ? '/rag ingest guide.md' : 'Use the knowledge base',
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    const signal = await entered.promise
    let disposed = false
    const disposing = t.vela.dispose().then(() => {
      disposed = true
    })
    try {
      await Bun.sleep(10)
      expect(signal?.aborted).toBe(true)
      expect(embedderSettled).toBe(false)
      expect(disposed).toBe(false)
      expect(close).not.toHaveBeenCalled()
      release.resolve()
      const [error] = await Promise.all([running, disposing])
      if (error) expect(error).toMatchObject({ name: 'AbortError' })
      expect(embedderSettled).toBe(true)
      expect(close).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(t.events)).not.toContain('database is closed')
      expect(JSON.stringify(t.events)).not.toContain('knowledge base is closed')
    } finally {
      release.resolve()
      await Promise.allSettled([running, disposing])
      close.mockRestore()
    }
  },
)
