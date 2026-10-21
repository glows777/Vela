import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type EmbeddingFn, rag } from '../../src/index.ts'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { createFauxEmbedder } from '../../src/testing/faux-embedder.ts'
import {
  captureConsole,
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

test('unconfigured RAG stays silent and /rag explains configuration without model or database work', async () => {
  const diagnostics: string[] = []
  const log = (message: string) => diagnostics.push(message)
  const t = createTestVela({
    extensions: [rag()],
    logger: { debug: log, info: log, warn: log, error: log },
  })
  expect(diagnostics).toEqual([])
  expect(t.vela.extensions().find((ext) => ext.name === 'rag')).toMatchObject({
    tools: [],
    commands: ['rag'],
  })
  const { output } = await captureConsole(() => t.dispatch('/extensions'))
  expect(output).toContain('Commands: /rag')
  await t.run('/rag')
  expect(t.model.calls).toHaveLength(0)
  expect(t.exists('rag')).toBe(false)
  expect(diagnostics).toEqual([])
  const message = notes(t)
  expect(message).toContain('Knowledge base disabled')
  expect(message).toContain('extensionConfig.rag.embedding')
  for (const key of [
    'baseUrl',
    'model',
    'apiKey',
    'settings.json',
    'EMBEDDING_MODEL_BASE_URL',
    'EMBEDDING_MODEL',
    'EMBEDDING_MODEL_KEY',
  ])
    expect(message).toContain(key)
})

test('configured RAG registers tools', async () => {
  const t = createTestVela({
    extensions: [rag()],
    extensionConfig: {
      rag: {
        embedding: {
          baseUrl: 'https://example.invalid/embeddings',
          model: 'test-embedding',
          apiKey: 'offline-test',
        },
      },
    },
    responses: [fauxText('Hello')],
  })
  await t.run('hello')
  expect(t.model.calls[0]!.tools).toEqual(
    expect.arrayContaining(['rag_search', 'rag_ingest']),
  )
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
        // The summary is decided at the start of each prompt and stays fixed for the round (keeps the prompt cache)
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
    responses: [fauxText('ok'), fauxText('ok again')],
  })
  await again.run('What is in the knowledge base')
  const call = again.model.calls[0]!
  expect(call.system).not.toContain('[knowledge base]')
  expect(call.lastUserText).toContain('sources: docs/guide.md')
  // Unchanged sources are not sent again on the next turn
  await again.run('Anything else?')
  expect(again.model.calls[1]!.lastUserText).not.toContain('[knowledge base]')
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

test('when the RAG extension is not loaded, /rag goes to the model', async () => {
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

test('switching embedders fails loudly until /rag clear', async () => {
  const t = createTestVela({
    embedder: createFauxEmbedder({ id: 'model-a' }),
    files: { 'docs/guide.md': GUIDE },
  })
  await t.run('/rag ingest docs/guide.md')

  const switched = createTestVela({
    cwd: t.cwd,
    sessionId: 'switched',
    embedder: createFauxEmbedder({ id: 'model-b' }),
    responses: [
      fauxToolCall('rag_search', { query: 'roll back' }),
      fauxText('The embedder changed'),
    ],
  })
  await switched.run('Search for it')
  const result = switched.model.calls[1]!.toolResults[0]!
  expect((result.raw as { type: string }).type).toBe('error-text')
  expect(result.output).toContain(
    'The knowledge base was built with the embedder "model-a", but the configured embedder is "model-b"',
  )
  await switched.run('/rag')
  expect(notes(switched)).toContain(
    'Embedder: model-a, but the configured embedder is model-b',
  )

  await switched.run('/rag clear')
  expect(notes(switched)).toMatch(
    /Deleted [1-9]\d* chunks; new documents are embedded with "model-b"/,
  )
  await switched.run('/rag ingest docs/guide.md')
  expect(notes(switched)).toContain('Ingested')
})
