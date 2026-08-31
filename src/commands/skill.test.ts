import { afterEach, expect, spyOn, test } from 'bun:test'
import { createTestFixture, type TestFixture } from '../testing/harness'

const BODY = '## 审查清单\n- 运行 diff\n- 确认没有回归'
const SKILL = { name: 'code-review', description: '审查代码变更', body: BODY }

let fixtures: TestFixture[] = []
afterEach(() => {
  for (const f of fixtures) f.cleanup()
  fixtures = []
})

function fixture(): TestFixture {
  const f = createTestFixture({ skill: SKILL })
  fixtures.push(f)
  return f
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = text.indexOf(needle)
  while (index !== -1) {
    count++
    index = text.indexOf(needle, index + needle.length)
  }
  return count
}

function allPromptText(f: TestFixture): string {
  const system = f.ctx.builder.build(f.ctx.makePromptCtx())
  const messages = f.ctx.messages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')
  return `${system}\n${messages}`
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await Bun.sleep(50)
  }
}

test('/skill list 打印可用列表', () => {
  const f = fixture()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    expect(f.dispatch('/skill', f.ctx)).toBe(true)
    expect(f.dispatch('/skill list', f.ctx)).toBe(true)
    const output = log.mock.calls.flat().join('\n')
    expect(output).toContain('/code-review')
    expect(output).toContain('审查代码变更')
    expect(output).not.toContain('已激活')
  } finally {
    log.mockRestore()
  }
})

test('/skill load 激活并注入正文一次（system prompt 无正文）', () => {
  const f = fixture()
  expect(f.dispatch('/skill load code-review', f.ctx)).toBe(true)
  expect(f.activeSkills.has('code-review')).toBe(true)
  expect(f.ctx.messages).toHaveLength(1)
  expect(f.ctx.messages[0]!.content).toContain(BODY)

  expect(countOccurrences(allPromptText(f), BODY)).toBe(1)
})

test('/skill unload 移除激活状态', () => {
  const f = fixture()
  f.dispatch('/skill load code-review', f.ctx)
  expect(f.dispatch('/skill unload code-review', f.ctx)).toBe(true)
  expect(f.activeSkills.has('code-review')).toBe(false)
})

test('/<skill> 触发：activeSkills 更新、正文以消息注入一次、system prompt 仍只含索引', async () => {
  const f = fixture()
  expect(f.dispatch('/code-review extra', f.ctx)).toBe('async')
  expect(f.activeSkills.has('code-review')).toBe(true)
  expect(f.ctx.messages).toHaveLength(1)
  expect(String(f.ctx.messages[0]!.content)).toBe(`${BODY}\n\n用户指令: extra`)

  const system = f.ctx.builder.build(f.ctx.makePromptCtx())
  expect(system).not.toContain(BODY)
  expect(system).toContain('/code-review — 审查代码变更 ✓ 已激活')
  expect(countOccurrences(allPromptText(f), BODY)).toBe(1)

  await waitFor(() => f.askCount() > 0)
})

test('/<skill> 不带参数：正文即为消息内容', () => {
  const f = fixture()
  expect(f.dispatch('/code-review', f.ctx)).toBe('async')
  expect(f.ctx.messages[0]!.content).toBe(BODY)
})

test('未知 /<skill> 放行给普通对话', () => {
  const f = fixture()
  expect(f.dispatch('/not-a-skill', f.ctx)).toBe(false)
})

test('/skill load 不存在的名字返回 true 且提示', () => {
  const f = fixture()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    expect(f.dispatch('/skill load nope', f.ctx)).toBe(true)
    expect(log.mock.calls.flat().join('\n')).toContain('找不到 skill: nope')
  } finally {
    log.mockRestore()
  }
})

test('无 skill 目录时 system prompt 不含可用的 Skills 索引', () => {
  const f = createTestFixture()
  fixtures.push(f)
  expect(f.ctx.builder.build(f.ctx.makePromptCtx())).not.toContain('可用的 Skills')
})

test('P0-3: 残缺子命令被拦截，不穿透为 skill 触发', () => {
  const f = fixture()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    expect(f.dispatch('/skill load', f.ctx)).toBe(true)
    expect(log.mock.calls.flat().join('\n')).toContain('用法: /skill load <name>')
    expect(f.dispatch('/skill unload', f.ctx)).toBe(true)
    expect(f.dispatch('/skill bogus-command', f.ctx)).toBe(true)
    expect(log.mock.calls.flat().join('\n')).toContain('未知子命令')
    expect(f.activeSkills.size).toBe(0)
    expect(f.ctx.messages).toHaveLength(0)
  } finally {
    log.mockRestore()
  }
})

test('P0-2: busy 锁拒绝并发触发', () => {
  const f = fixture()
  f.ctx.busy.locked = true
  expect(f.dispatch('/code-review extra', f.ctx)).toBe(true)
  expect(f.activeSkills.has('code-review')).toBe(false)
  expect(f.ctx.messages).toHaveLength(0)
})

test('P0-2: /skill load 重复执行不重复注入正文', () => {
  const f = fixture()
  expect(f.dispatch('/skill load code-review', f.ctx)).toBe(true)
  expect(f.ctx.messages).toHaveLength(1)

  expect(f.dispatch('/skill load code-review', f.ctx)).toBe(true)
  expect(f.ctx.messages).toHaveLength(1)
  expect(countOccurrences(allPromptText(f), BODY)).toBe(1)
})

test('P0-2: load 之后再触发不注入第二份正文', async () => {
  const f = fixture()
  expect(f.dispatch('/skill load code-review', f.ctx)).toBe(true)
  expect(f.dispatch('/code-review extra', f.ctx)).toBe('async')
  expect(f.ctx.messages).toHaveLength(2)
  expect(countOccurrences(allPromptText(f), BODY)).toBe(1)
  await waitFor(() => f.askCount() > 0)
}, 20_000)

test('P0-2: 正文已注入时二次触发只追加注记，不重复正文', async () => {
  // 两轮 mock agentLoop 略慢，放宽单测默认 5s 超时
  const f = fixture()
  expect(f.dispatch('/code-review extra', f.ctx)).toBe('async')
  await waitFor(() => f.askCount() > 0)

  const beforeLen = f.ctx.messages.length
  expect(f.dispatch('/code-review extra', f.ctx)).toBe('async')
  expect(f.ctx.messages).toHaveLength(beforeLen + 1)
  const last = f.ctx.messages[f.ctx.messages.length - 1]!
  expect(String(last.content)).toContain('[skill 已加载]')
  expect(String(last.content)).not.toContain(BODY)
  expect(countOccurrences(allPromptText(f), BODY)).toBe(1)
  await waitFor(() => f.askCount() > 1)
}, 20_000)
