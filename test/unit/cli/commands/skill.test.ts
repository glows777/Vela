import { afterEach, expect, test } from 'bun:test'
import { fauxText } from '../../../../src/testing/faux'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
  type TestVela,
  type TestVelaOptions,
} from '../../../support/vela'

const BODY = '## 审查清单\n- 运行 diff\n- 确认没有回归'
const SKILL = { name: 'code-review', description: '审查代码变更', body: BODY }

afterEach(cleanupTestVelas)

const fixture = (options: TestVelaOptions = {}) =>
  createTestVela({ skills: [SKILL], ...options })

function countOccurrences(text: string, needle: string): number {
  return needle ? text.split(needle).length - 1 : 0
}

function allPromptText(t: TestVela): string {
  const system = t.session.buildSystem()
  const messages = t.messages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')
  return `${system}\n${messages}`
}

test('/skill list 打印可用列表', async () => {
  const t = fixture()
  const { output } = await captureConsole(() => {
    expect(t.dispatch('/skill')).toBe(true)
    expect(t.dispatch('/skill list')).toBe(true)
  })
  expect(output).toContain('/code-review')
  expect(output).toContain('审查代码变更')
  expect(output).not.toContain('已激活')
})

test('/skill load 激活并注入正文一次（system prompt 无正文）', async () => {
  const t = fixture()
  await captureConsole(() =>
    expect(t.dispatch('/skill load code-review')).toBe(true),
  )
  expect(t.session.activeSkills.has('code-review')).toBe(true)
  expect(t.messages).toHaveLength(1)
  expect(t.messages[0]!.content).toContain(BODY)
  expect(countOccurrences(allPromptText(t), BODY)).toBe(1)
})

test('/skill unload 移除激活状态', async () => {
  const t = fixture()
  await captureConsole(() => {
    t.dispatch('/skill load code-review')
    expect(t.dispatch('/skill unload code-review')).toBe(true)
  })
  expect(t.session.activeSkills.has('code-review')).toBe(false)
})

test('/<skill> 触发：activeSkills 更新、正文以消息注入一次、system prompt 仍只含索引', async () => {
  const t = fixture({ responses: [fauxText('审查完成')] })
  const { result } = await captureConsole(() => t.command('/code-review extra'))
  expect(result).toBe(true)
  expect(t.session.activeSkills.has('code-review')).toBe(true)
  expect(String(t.messages[0]!.content)).toBe(`${BODY}\n\n用户指令: extra`)

  const system = t.session.buildSystem()
  expect(system).not.toContain(BODY)
  expect(system).toContain('/code-review — 审查代码变更 ✓ 已激活')
  expect(countOccurrences(allPromptText(t), BODY)).toBe(1)

  // 模型收到的是 skill 正文 + 用户指令，回复写回会话并落盘
  expect(t.model.calls[0]!.lastUserText).toBe(`${BODY}\n\n用户指令: extra`)
  expect(t.lastAssistantText()).toBe('审查完成')
  expect(await t.readData('sessions/default.jsonl')).toContain('审查完成')
})

test('/<skill> 不带参数：正文即为消息内容', async () => {
  const t = fixture({ responses: [fauxText('ok')] })
  await captureConsole(() => t.command('/code-review'))
  expect(t.messages[0]!.content).toBe(BODY)
})

test('未知 /<skill> 放行给普通对话', () => {
  const t = fixture()
  expect(t.dispatch('/not-a-skill')).toBe(false)
})

test('/skill load 不存在的名字返回 true 且提示', async () => {
  const t = fixture()
  const { result, output } = await captureConsole(() =>
    t.dispatch('/skill load nope'),
  )
  expect(result).toBe(true)
  expect(output).toContain('找不到 skill: nope')
})

test('无 skill 目录时 system prompt 不含可用的 Skills 索引', () => {
  const t = createTestVela()
  expect(t.session.buildSystem()).not.toContain('可用的 Skills')
})

test('P0-3: 残缺子命令被拦截，不穿透为 skill 触发', async () => {
  const t = fixture()
  const { output } = await captureConsole(() => {
    expect(t.dispatch('/skill load')).toBe(true)
    expect(t.dispatch('/skill unload')).toBe(true)
    expect(t.dispatch('/skill bogus-command')).toBe(true)
  })
  expect(output).toContain('用法: /skill load <name>')
  expect(output).toContain('未知子命令')
  expect(t.session.activeSkills.size).toBe(0)
  expect(t.messages).toHaveLength(0)
})

test('P0-2: busy 锁拒绝并发触发', () => {
  const t = fixture()
  t.session.busy.locked = true
  expect(t.dispatch('/code-review extra')).toBe(true)
  expect(t.session.activeSkills.has('code-review')).toBe(false)
  expect(t.messages).toHaveLength(0)
})

test('P0-2: /skill load 重复执行不重复注入正文', async () => {
  const t = fixture()
  await captureConsole(() => {
    expect(t.dispatch('/skill load code-review')).toBe(true)
    expect(t.dispatch('/skill load code-review')).toBe(true)
  })
  expect(t.messages).toHaveLength(1)
  expect(countOccurrences(allPromptText(t), BODY)).toBe(1)
})

test('P0-2: load 之后再触发不注入第二份正文', async () => {
  const t = fixture({ responses: [fauxText('ok')] })
  await captureConsole(async () => {
    expect(t.dispatch('/skill load code-review')).toBe(true)
    expect(await t.command('/code-review extra')).toBe(true)
  })
  expect(t.messages.filter((m) => m.role === 'user')).toHaveLength(2)
  expect(countOccurrences(allPromptText(t), BODY)).toBe(1)
})

test('P0-2: 正文已注入时二次触发只追加注记，不重复正文', async () => {
  const t = fixture({ responses: [fauxText('first'), fauxText('second')] })
  await captureConsole(async () => {
    expect(await t.command('/code-review extra')).toBe(true)
    expect(await t.command('/code-review extra')).toBe(true)
  })
  const lastUser = t.messages.filter((m) => m.role === 'user').at(-1)!
  expect(String(lastUser.content)).toContain('[skill 已加载]')
  expect(String(lastUser.content)).not.toContain(BODY)
  expect(countOccurrences(allPromptText(t), BODY)).toBe(1)
})

test('skill persists the updated summary produced during preparation', async () => {
  const t = fixture({ responses: [fauxText('ok')] })
  await t.session.contextManager.commit([], 'old summary')
  t.session.prepareContext = async () => {
    await t.session.contextManager.commit(t.messages.slice(), 'new summary')
  }
  await captureConsole(() => t.command('/code-review'))
  expect((await t.session.store.loadState()).summary).toBe('new summary')
})
