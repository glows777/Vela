import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { MemoryStore } from '../../src/extensions/memory/store'
import { fauxHang, fauxText, fauxToolCall } from '../../src/testing/faux'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
  type TestVela,
} from '../support/vela'

afterEach(cleanupTestVelas)

const save = {
  action: 'save',
  name: 'favorite-language',
  description: '用户最喜欢的编程语言',
  type: 'user',
  content: '用户最喜欢 TypeScript',
}

test('a memory saved through the tool shows up in the next system prompt and survives a restart', async () => {
  const t = createTestVela({
    responses: [
      (req) => {
        expect(req.system).toContain('当前没有存储任何记忆')
        return fauxToolCall('memory', save)
      },
      fauxText('记住了'),
      (req) => {
        expect(req.system).toContain('用户最喜欢的编程语言')
        return fauxText('你喜欢 TypeScript')
      },
    ],
  })

  await t.run('记住：我最喜欢 TypeScript')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain('已保存到记忆')
  await t.run('我最喜欢什么语言？')
  expect(t.lastAssistantText()).toBe('你喜欢 TypeScript')

  const index = await t.readData('memory/MEMORY.md')
  expect(index).toContain('favorite-language')

  const restarted = createTestVela({ cwd: t.cwd, responses: [fauxText('ok')] })
  await restarted.run('你好')
  expect(restarted.model.calls[0]!.system).toContain('用户最喜欢的编程语言')
})

test('the model can search and read memories back', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('memory', save),
      fauxToolCall('memory', {
        action: 'search',
        query: 'TypeScript',
        filename: '',
      }),
      (req) => {
        expect(req.toolResults[0]!.output).toContain('favorite-language')
        return fauxText('找到了')
      },
    ],
  })
  await t.run('存一下再找出来')
  expect(t.lastAssistantText()).toBe('找到了')
})

test('the memory tool rejects a save without content', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('memory', {
        action: 'save',
        name: 'x',
        type: 'user',
        filename: '',
      }),
      fauxText('好'),
    ],
  })
  await t.run('存个空的')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain('保存失败')
  expect(new MemoryStore(join(t.dataDir, 'memory')).list()).toHaveLength(0)
})

test('read and delete need a filename; with one they work', async () => {
  const t = createTestVela({
    responses: [
      [
        fauxToolCall('memory', { action: 'read' }),
        fauxToolCall('memory', { action: 'delete' }),
      ],
      fauxToolCall('memory', save),
      fauxToolCall('memory', { action: 'list' }),
      (req) => {
        const filename =
          req.toolResults[0]!.output.match(/\S+\.md/)?.[0] ??
          'user_favorite-language.md'
        return fauxToolCall('memory', { action: 'delete', filename })
      },
      fauxText('删掉了'),
    ],
  })
  await t.run('读、删、存、列、删')
  const outputs = t.model.calls[1]!.toolResults.map((r) => r.output).join('\n')
  expect(outputs).toContain('读取失败：需要 filename')
  expect(outputs).toContain('删除失败：需要 filename')
  expect(t.model.calls[4]!.toolResults[0]!.output).toContain('已删除')
  expect(new MemoryStore(join(t.dataDir, 'memory')).list()).toHaveLength(0)
})

// ---------- 命令（memory 扩展注册，输出走 ui.notify） ----------

function withMemory(options: Parameters<typeof createTestVela>[0] = {}) {
  const t = createTestVela(options)
  new MemoryStore(join(t.dataDir, 'memory')).save({
    name: 'openai-null-chars',
    description: 'openai 接口返回 null 字符问题',
    type: 'feedback',
    content: '正文',
  })
  return t
}

const notes = (t: TestVela) =>
  t
    .eventsOf('notify')
    .map((e) => e.message)
    .join('\n')

test('/memory lists memories, /memory search uses BM25, /memory lint reports health', async () => {
  const t = withMemory()
  await t.run('/memory')
  expect(notes(t)).toContain('共 1 条记忆')
  expect(notes(t)).toContain('openai-null-chars')
  await t.run('/memory search null 字符')
  expect(notes(t)).toContain('BM25 搜索')
  await t.run('/memory lint')
  expect(notes(t)).toContain('记忆库健康')
  // 命令不发给模型
  expect(t.model.calls).toHaveLength(0)
})

test('/dream hands the memory clean-up prompt to the model', async () => {
  const t = withMemory({ responses: [fauxText('记忆已整理')] })
  await t.run('/dream')
  expect(t.model.calls).toHaveLength(1)
  expect(t.model.calls[0]!.lastUserText).toContain('memory lint')
  expect(t.lastAssistantText()).toBe('记忆已整理')
  expect(notes(t)).toContain('[dream] 完成')
  expect(t.session.busy.locked).toBe(false)
})

test('/context previews the memory section before the first prompt', async () => {
  const t = withMemory()
  // 段落每次 prompt 才算，还没 prompt 过时这一轮是空的
  expect(t.session.promptContext().extensionSections?.memory).toBeUndefined()
  const sections = await t.session.previewSections()
  expect(sections.memory).toContain('openai-null-chars')
  expect(t.session.buildSystem(sections)).toContain('openai-null-chars')
  // 预览不替换这一轮的段落
  expect(t.session.promptContext().extensionSections?.memory).toBeUndefined()
  const { output } = await captureConsole(() => t.command('/context'))
  // 以前没 prompt 过时这里是 0 tokens
  const memoryRow = output.split('\n').find((line) => line.includes('Memory'))
  expect(memoryRow).toBeDefined()
  expect(memoryRow).not.toMatch(/\b0 tokens/)
  expect(t.model.calls).toHaveLength(0)
})

test('aborting the prompt signal of /dream stops the model run it started', async () => {
  const t = withMemory({ responses: [fauxHang()] })
  const controller = new AbortController()
  const run = t.run('/dream', { signal: controller.signal })
  while (t.model.calls.length === 0) await Bun.sleep(1)
  controller.abort(new Error('stop dream'))
  await expect(run).rejects.toThrow()
  expect(t.eventsOf('agent_end').at(-1)?.reason).toBe('aborted')
  expect(t.session.busy.locked).toBe(false)
})

test('guest sessions cannot run memory commands; the text goes to the model', async () => {
  const t = withMemory({
    responses: [fauxText('普通回答')],
    session: { role: 'guest' },
  })
  await t.run('/memory')
  expect(notes(t)).not.toContain('openai-null-chars')
  expect(t.model.calls).toHaveLength(1)
})
