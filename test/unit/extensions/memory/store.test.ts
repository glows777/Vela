import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { MemoryStore } from '../../../../src/extensions/memory/store.ts'

const tempDirs: string[] = []
function makeTempStore(): MemoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-memory-'))
  tempDirs.push(dir)
  const store = new MemoryStore(dir)
  store.init()
  return store
}
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

test('list reads back the full entry after save', () => {
  const store = makeTempStore()
  store.save({
    name: 'feedback-test',
    description: 'User feedback test',
    type: 'feedback',
    content: 'Body',
  })
  const entries = store.list()
  expect(entries).toHaveLength(1)
  expect(entries[0]!.name).toBe('feedback-test')
  expect(entries[0]!.filePath).toContain('feedback_feedback-test.md')
})

test('search recalls relevant memories with BM25', () => {
  const store = makeTempStore()
  store.save({
    name: 'bm25-demo',
    description: 'The search engine uses the BM25 algorithm',
    type: 'reference',
    content: 'BM25 is commonly used to rank full-text retrieval',
  })
  store.save({
    name: 'deploy-flow',
    description: 'Release process',
    type: 'project',
    content: 'Run the tests before releasing',
  })

  const hits = store.search('BM25 search')
  expect(hits.length).toBeGreaterThan(0)
  expect(hits[0]!.entry.name).toBe('bm25-demo')
  expect(hits[0]!.score).toBeGreaterThan(0)

  expect(store.search('nonexistentkeyword xyz')).toHaveLength(0)
})

test('lint reports entries with stale paths', () => {
  const store = makeTempStore()
  store.save({
    name: 'good-entry',
    description: 'Normal entry',
    type: 'project',
    content: 'Content',
  })
  store.save({
    name: 'stale-entry',
    description: 'References a stale path',
    type: 'project',
    content: 'Watch out for the file src/ghost-helper.ts',
  })

  const reports = store.lint()
  const stale = reports.find((r) => r.entry.name === 'stale-entry')
  expect(stale?.issues[0]?.kind).toBe('stale_path')
  expect(reports.find((r) => r.entry.name === 'good-entry')).toBeUndefined()
})

test('delete removes the file and cleans up the index line', () => {
  const store = makeTempStore()
  const file = store.save({
    name: 'to-delete',
    description: 'Will be deleted',
    type: 'reference',
    content: 'Content',
  })
  expect(store.delete(file)).toBe(true)
  expect(store.list()).toHaveLength(0)
  expect(store.loadIndex()).not.toContain('to-delete')
})

test('buildPromptSection outputs the memory index and usage guidance', () => {
  const store = makeTempStore()
  store.save({
    name: 'kept-memory',
    description: 'Important memory',
    type: 'project',
    content: 'Content',
  })
  const section = store.buildPromptSection()
  expect(section).toContain('[memory] 1 memories')
  expect(section).toContain('kept-memory')
  expect(section).toContain('How to use memory:')
})

test('memory files and the index are private (0600), the directory 0700', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vela-memory-')), 'memory')
  tempDirs.push(path.dirname(dir))
  const store = new MemoryStore(dir)
  const filename = store.save({
    name: 'private',
    description: 'Permissions',
    type: 'user',
    content: 'Secret preference',
  })
  // A file created earlier with looser permissions is tightened on the next write
  fs.chmodSync(path.join(dir, filename), 0o644)
  store.loadFile(filename)
  const mode = (file: string) => fs.statSync(path.join(dir, file)).mode & 0o777
  expect(mode(filename)).toBe(0o600)
  expect(mode('MEMORY.md')).toBe(0o600)
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
})
