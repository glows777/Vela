import { afterEach, expect, test } from 'bun:test'
import { fauxText, fauxToolCall } from '../../src/testing/faux'
import { captureConsole, cleanupTestVelas, createTestVela } from '../support/vela'

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
  const names = t.vela.registry.getAllTools().map((tool) => tool.name)
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
        expect(req.tools).toEqual(expect.arrayContaining(['rag_ingest', 'rag_search']))
        expect(req.system).not.toContain('[知识库]')
        return fauxToolCall('rag_ingest', { path: 'docs/guide.md' })
      },
      (req) => {
        expect(req.toolResults[0]!.output).toContain('已导入')
        // 导入后 system prompt 带上知识库概况
        expect(req.system).toContain('[知识库] 已导入')
        return fauxToolCall('rag_search', { query: '怎么回滚部署' })
      },
      (req) => {
        expect(req.toolResults[0]!.output).toContain('deploy rollback')
        return fauxText('执行 deploy rollback')
      },
    ],
  })

  await t.run('导入部署指南，然后告诉我怎么回滚')

  expect(t.lastAssistantText()).toBe('执行 deploy rollback')
  expect(t.vela.vectorStore.size()).toBeGreaterThan(0)
  expect(t.vela.vectorStore.sources()).toEqual(['docs/guide.md'])
  const { output } = await captureConsole(() => t.dispatch('/rag'))
  expect(output).toContain('来源: docs/guide.md')
})

test('searching an empty knowledge base tells the model to ingest first', async () => {
  const t = createTestVela({
    embedder: true,
    responses: [fauxToolCall('rag_search', { query: 'anything' }), fauxText('知识库是空的')],
  })
  await t.run('搜一下')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain('知识库为空')
})

test('the knowledge base persists in the data dir across restarts', async () => {
  const t = createTestVela({
    embedder: true,
    files: { 'docs/guide.md': GUIDE },
    responses: [fauxToolCall('rag_ingest', { path: 'docs/guide.md' }), fauxText('ok')],
  })
  await t.run('导入')
  const size = t.vela.vectorStore.size()

  const again = createTestVela({ cwd: t.cwd, embedder: true })
  expect(again.vela.vectorStore.size()).toBe(size)
  expect(again.vela.buildSystem()).toContain('[知识库] 已导入')
})
