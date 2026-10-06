import { afterEach, expect, test } from 'bun:test'
import { fauxText, fauxToolCall } from '../../src/testing/faux'
import { cleanupTestVelas, createTestVela } from '../support/vela'

afterEach(cleanupTestVelas)

const save = {
  action: 'save',
  name: 'favorite-language',
  description: '用户最喜欢的编程语言',
  type: 'user',
  content: '用户最喜欢 TypeScript',
  // 当前 schema 要求所有动作都带 filename（见 HANDOFF 里的待办）
  filename: '',
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

  const index = await t.readData('.memory/MEMORY.md')
  expect(index).toContain('favorite-language')

  const restarted = createTestVela({ cwd: t.cwd })
  expect(restarted.vela.buildSystem()).toContain('用户最喜欢的编程语言')
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
  expect(t.vela.memoryStore.list()).toHaveLength(0)
})
