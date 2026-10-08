import { afterEach, expect, test } from 'bun:test'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import type { EmbeddingFn } from '../../src/index.ts'
import {
  cleanupTestVelas,
  createTestVela,
  type TestVela,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

const GUIDE = [
  '# 部署指南',
  '',
  '生产环境使用 blue-green 部署。回滚时执行 deploy rollback 命令。',
  '',
  '# 监控',
  '',
  '告警通过飞书机器人发送，值班表在 oncall 文档里。',
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
        expect(req.system).not.toContain('[知识库]')
        return fauxToolCall('rag_ingest', { path: 'docs/guide.md' })
      },
      (req) => {
        expect(req.toolResults[0]!.output).toContain('已导入')
        // 知识库概况在每次 prompt 开始时写入 system prompt，这一轮里不变（保持 prompt 缓存）
        expect(req.system).not.toContain('[知识库]')
        return fauxToolCall('rag_search', { query: '怎么回滚部署', top_k: 1 })
      },
      (req) => {
        expect(req.toolResults[0]!.output).toContain('deploy rollback')
        // top_k 生效：只返回一个片段
        expect(req.toolResults[0]!.output).not.toContain('[2]')
        return fauxText('执行 deploy rollback')
      },
    ],
  })

  await t.run('导入部署指南，然后告诉我怎么回滚')

  expect(t.lastAssistantText()).toBe('执行 deploy rollback')
  await t.run('/rag')
  expect(notes(t)).toMatch(/\[知识库\] [1-9]\d* 个片段/)
  expect(notes(t)).toContain('来源: docs/guide.md')
})

test('searching an empty knowledge base tells the model to ingest first', async () => {
  const t = createTestVela({
    embedder: true,
    responses: [
      fauxToolCall('rag_search', { query: 'anything' }),
      fauxText('知识库是空的'),
    ],
  })
  await t.run('搜一下')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain('知识库为空')
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
  await t.run('导入')

  const again = createTestVela({
    cwd: t.cwd,
    embedder: true,
    responses: [fauxText('ok')],
  })
  await again.run('知识库里有什么')
  expect(again.model.calls[0]!.system).toContain('来源: docs/guide.md')
})

// ---------- 命令（rag 扩展注册，输出走 ui.notify） ----------

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
  expect(notes(t)).toContain('0 个片段')
  await t.run('/rag ingest docs/guide.md')
  expect(notes(t)).toContain('正在处理 docs/guide.md')
  expect(notes(t)).toContain('已导入')
  expect(t.model.calls).toHaveLength(0)
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
    files: { 'docs/guide.md': '取消导入' },
  })
  const done = t.run('/rag ingest docs/guide.md')
  while (!signal) await Bun.sleep(1)
  expect(t.session.signal).toBe(signal)
  t.session.abort(new Error('cancel import'))
  await done
  expect(signal.aborted).toBe(true)
  expect(notes(t)).toContain('[导入] 已停止: cancel import')
  expect(t.session.signal).toBeUndefined()
})

test('without an embedder there is no /rag command; the text goes to the model', async () => {
  const t = createTestVela({ responses: [fauxText('没有知识库')] })
  await t.run('/rag')
  expect(t.model.calls).toHaveLength(1)
})
