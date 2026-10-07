import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { MemoryStore } from '../../../../src/extensions/memory/store'

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

test('save 后 list 能读回完整条目', () => {
  const store = makeTempStore()
  store.save({
    name: 'feedback-test',
    description: '用户反馈测试',
    type: 'feedback',
    content: '正文',
  })
  const entries = store.list()
  expect(entries).toHaveLength(1)
  expect(entries[0]!.name).toBe('feedback-test')
  expect(entries[0]!.filePath).toContain('feedback_feedback-test.md')
})

test('search 用 BM25 召回相关记忆', () => {
  const store = makeTempStore()
  store.save({
    name: 'bm25-demo',
    description: '搜索引擎使用 BM25 算法',
    type: 'reference',
    content: 'BM25 常用来做全文检索排序',
  })
  store.save({
    name: 'deploy-flow',
    description: '发布流程',
    type: 'project',
    content: '先跑测试再发布',
  })

  const hits = store.search('BM25 搜索')
  expect(hits.length).toBeGreaterThan(0)
  expect(hits[0]!.entry.name).toBe('bm25-demo')
  expect(hits[0]!.score).toBeGreaterThan(0)

  expect(store.search('不存在的关键词xyz')).toHaveLength(0)
})

test('lint 报告过期路径条目', () => {
  const store = makeTempStore()
  store.save({
    name: 'good-entry',
    description: '正常条目',
    type: 'project',
    content: '内容',
  })
  store.save({
    name: 'stale-entry',
    description: '引用过期路径',
    type: 'project',
    content: '注意 src/ghost-helper.ts 这个文件',
  })

  const reports = store.lint()
  const stale = reports.find((r) => r.entry.name === 'stale-entry')
  expect(stale?.issues[0]?.kind).toBe('stale_path')
  expect(reports.find((r) => r.entry.name === 'good-entry')).toBeUndefined()
})

test('delete 删除文件并清理索引行', () => {
  const store = makeTempStore()
  const file = store.save({
    name: 'to-delete',
    description: '将被删除',
    type: 'reference',
    content: '内容',
  })
  expect(store.delete(file)).toBe(true)
  expect(store.list()).toHaveLength(0)
  expect(store.loadIndex()).not.toContain('to-delete')
})

test('buildPromptSection 输出记忆索引与使用说明', () => {
  const store = makeTempStore()
  store.save({
    name: 'kept-memory',
    description: '重要记忆',
    type: 'project',
    content: '内容',
  })
  const section = store.buildPromptSection()
  expect(section).toContain('[记忆系统] 共 1 条记忆')
  expect(section).toContain('kept-memory')
  expect(section).toContain('记忆使用原则')
})
