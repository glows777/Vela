import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EmbeddingFn } from '../../src/index.ts'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { createFauxEmbedder } from '../../src/testing/faux-embedder.ts'
import {
  cleanupTestVelas,
  createTestVela,
  type TestVela,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

const GUIDE = [
  '# Deployment guide',
  '',
  'Production uses blue-green deployment. To roll back, run the deploy rollback command.',
  '',
  '# Monitoring',
  '',
  'Alerts are sent by the Feishu bot; the on-call rota is in the oncall doc.',
].join('\n')

test('without an embedder the RAG tools are not registered', () => {
  const t = createTestVela()
  const names = t.internals.registry.getAllTools().map((tool) => tool.name)
  expect(names).toContain('read_file')
  expect(names).not.toContain('rag_search')
  expect(names).not.toContain('rag_ingest')
})

test('ingest a document relative to cwd, then search it, offline with the faux embedder', async () => {
  const t = createTestVela({
    embedder: true,
    files: { 'docs/guide.md': GUIDE },
    responses: [
      (req) => {
        expect(req.tools).toEqual(
          expect.arrayContaining(['rag_ingest', 'rag_search']),
        )
        expect(req.system).not.toContain('[knowledge base]')
        return fauxToolCall('rag_ingest', { path: 'docs/guide.md' })
      },
      (req) => {
        expect(req.toolResults[0]!.output).toContain('Ingested')
        // The knowledge base overview is written into the system prompt at the start of each prompt and stays fixed for the round (keeps the prompt cache)
        expect(req.system).not.toContain('[knowledge base]')
        return fauxToolCall('rag_search', {
          query: 'how to roll back a deployment',
          top_k: 1,
        })
      },
      (req) => {
        expect(req.toolResults[0]!.output).toContain('deploy rollback')
        // top_k applies: only one chunk is returned
        expect(req.toolResults[0]!.output).not.toContain('[2]')
        return fauxText('Run deploy rollback')
      },
    ],
  })

  await t.run('Ingest the deployment guide, then tell me how to roll back')

  expect(t.lastAssistantText()).toBe('Run deploy rollback')
  await t.run('/rag')
  expect(notes(t)).toMatch(/\[knowledge base\] [1-9]\d* chunks/)
  expect(notes(t)).toContain('Sources: docs/guide.md')
})

test('searching an empty knowledge base tells the model to ingest first', async () => {
  const t = createTestVela({
    embedder: true,
    responses: [
      fauxToolCall('rag_search', { query: 'anything' }),
      fauxText('The knowledge base is empty'),
    ],
  })
  await t.run('Search for it')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain(
    'The knowledge base is empty',
  )
})

test('the knowledge base persists in the data dir across restarts', async () => {
  const t = createTestVela({
    embedder: true,
    files: { 'docs/guide.md': GUIDE },
    responses: [
      fauxToolCall('rag_ingest', { path: 'docs/guide.md' }),
      fauxText('ok'),
    ],
  })
  await t.run('Ingest it')

  const again = createTestVela({
    cwd: t.cwd,
    // A new session: the saved default session would need resume()
    sessionId: 'after-restart',
    embedder: true,
    responses: [fauxText('ok')],
  })
  await again.run('What is in the knowledge base')
  expect(again.model.calls[0]!.system).toContain('sources: docs/guide.md')
})

// ---------- Commands (registered by the rag extension; output goes through ui.notify) ----------

const notes = (t: TestVela) =>
  t
    .eventsOf('notify')
    .map((e) => e.message)
    .join('\n')

test('/rag shows an empty knowledge base; /rag ingest <path> imports without the model', async () => {
  const t = createTestVela({
    embedder: true,
    files: { 'docs/guide.md': GUIDE },
  })
  await t.run('/rag')
  expect(notes(t)).toContain('0 chunks')
  await t.run('/rag ingest docs/guide.md')
  expect(notes(t)).toContain('Processing docs/guide.md')
  expect(notes(t)).toContain('Ingested')
  expect(t.model.calls).toHaveLength(0)
})

test('re-ingesting a changed document replaces its old chunks', async () => {
  const t = createTestVela({
    embedder: true,
    // Three paragraphs of ~900 characters: one chunk each
    files: {
      'docs/guide.md': ['a', 'b', 'c']
        .map((p) => `${p} `.repeat(450))
        .join('\n\n'),
    },
  })
  await t.run('/rag ingest docs/guide.md')
  expect(notes(t)).toContain('The knowledge base has 3 chunks')
  writeFileSync(join(t.cwd, 'docs/guide.md'), 'Only one short paragraph now.')
  await t.run('/rag ingest docs/guide.md')
  expect(notes(t)).not.toContain('failed')
  expect(notes(t)).toContain('The knowledge base has 1 chunks')
})

test('session.abort() stops a running /rag ingest', async () => {
  let signal: AbortSignal | undefined
  const hanging: EmbeddingFn = (_texts, s) =>
    new Promise((_resolve, reject) => {
      signal = s
      s?.addEventListener('abort', () => reject(s.reason), { once: true })
    })
  const t = createTestVela({
    embedder: hanging,
    files: { 'docs/guide.md': 'Cancel the ingest' },
  })
  const done = t.run('/rag ingest docs/guide.md')
  while (!signal) await Bun.sleep(1)
  expect(t.session.signal).toBe(signal)
  t.session.abort(new Error('cancel import'))
  await done
  expect(signal.aborted).toBe(true)
  expect(notes(t)).toContain('[ingest] Stopped: cancel import')
  expect(t.session.signal).toBeUndefined()
})

test('without an embedder there is no /rag command; the text goes to the model', async () => {
  const t = createTestVela({ responses: [fauxText('No knowledge base')] })
  await t.run('/rag')
  expect(t.model.calls).toHaveLength(1)
})

test('the embedding cache is shared by every session of one Vela', async () => {
  const calls: string[][] = []
  const t = createTestVela({
    embedder: createFauxEmbedder({ onCall: (texts) => calls.push(texts) }),
    files: { 'docs/guide.md': GUIDE },
  })
  await t.run('/rag ingest docs/guide.md')
  expect(calls).toHaveLength(1)

  // The rag extension builds its embedder once per Vela, so another session
  // re-ingesting the same text must hit the cache instead of calling it again
  await t.vela.session('other').prompt('/rag ingest docs/guide.md')
  expect(calls).toHaveLength(1)
})
