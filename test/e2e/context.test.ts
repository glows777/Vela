import { afterEach, expect, test } from 'bun:test'
import {
  createRequestSnapshot,
  estimateRequestTokens,
} from '../../src/context/request.ts'
import {
  fauxHang,
  fauxSummary,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux.ts'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
  type TestVela,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

/** 估算 t 当前状态下发给模型的请求有多少 token（与 ContextManager 用的是同一个估算） */
async function requestTokens(t: TestVela): Promise<number> {
  return estimateRequestTokens(
    await createRequestSnapshot(
      t.vela.model,
      t.session.buildSystem(),
      t.internals.registry.toAISDKFormat(),
      t.messages,
    ),
  )
}

const bigFile = (i: number) =>
  `// file ${i}\n${'export const value = 42 // padding\n'.repeat(120)}`

test('microcompact folds old tool results once more than five calls have completed', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`f${i}.ts`, bigFile(i)]),
  )
  const t = createTestVela({
    files,
    // 每次请求前都尝试微压缩；摘要永远不会触发
    limits: {
      microcompactThreshold: 1,
      minMicroSavings: 1,
      summaryThreshold: 1e9,
    },
    responses: [
      ...Array.from({ length: 8 }, (_, i) =>
        fauxToolCall('read_file', { path: `f${i}.ts` }),
      ),
      fauxText('都读完了'),
    ],
  })

  await t.run('把 f0 到 f7 都读一遍')

  const micro = t.eventsOf('context').filter((e) => e.action === 'micro')
  expect(micro.length).toBeGreaterThan(0)
  expect(micro[0]!.after).toBeLessThan(micro[0]!.before)

  // 最后一次请求里，最早的工具结果已被折叠成引用，最近 5 个保持原样
  const last = JSON.stringify(t.model.calls.at(-1)!.prompt)
  expect(last).toContain('tool result preview omitted')
  expect(last).toContain('// file 7')
  // 折叠后的结果可以通过路径找回原文
  const saved = await t.readData('sessions/default.jsonl')
  expect(saved).toContain('tool result preview omitted')
  expect(t.lastAssistantText()).toBe('都读完了')
})

test('summary compaction replaces old history with a grounded summary and keeps recent messages', async () => {
  const filler = (i: number) =>
    `第 ${i} 个问题：${'很长的背景说明。'.repeat(150)}`
  const probe = createTestVela()
  const base = await requestTokens(probe)
  await probe.cleanup()

  const t = createTestVela({
    // 4 轮问答之后（8 条消息）再发第 5 个问题时触发摘要
    limits: { microcompactThreshold: 1e9, summaryThreshold: base + 4 * 400 },
    responses: [...Array.from({ length: 5 }, (_, i) => fauxText(`回答 ${i}`))],
    generate: [fauxSummary()],
  })
  for (let i = 0; i < 5; i++) await t.run(filler(i))

  const summary = t.eventsOf('context').find((e) => e.action === 'summary')
  expect(summary).toBeDefined()
  // 至少保留最近 6 条且切在完整的一轮问答处：第一轮（2 条）被摘要替换
  expect(summary!.messages).toBe(2)

  // 摘要请求走 generateText，看到的是压缩控制指令
  const generate = t.model.calls.find((c) => c.kind === 'generate')!
  expect(generate.lastUserText).toContain('context_compaction')
  expect(generate.responseFormat?.type).toBe('json')

  // 摘要后的主请求：第一条是摘要，最近的消息原样保留
  const after = t.model.calls.at(-1)!
  expect(after.kind).toBe('stream')
  const firstUser = after.prompt.find((m) => m.role === 'user')!
  expect(JSON.stringify(firstUser.content)).toContain('[之前对话的摘要]')
  expect(JSON.stringify(firstUser.content)).toContain('第 0 个问题')
  expect(after.lastUserText).toContain('第 4 个问题')
  expect(t.session.contextManager.state.summary).toContain('## 用户目标')
  expect(
    t
      .tracker()
      .recent(10)
      .some((r) => r.kind === 'summary'),
  ).toBe(true)

  // 摘要落盘，新的 Vela 恢复后带着它
  const resumed = createTestVela({ cwd: t.cwd, responses: [fauxText('ok')] })
  expect(await resumed.session.resume()).toBe(true)
  expect(resumed.session.contextManager.state.summary).toBe(
    t.session.contextManager.state.summary,
  )
  await resumed.run('继续')
  expect(JSON.stringify(resumed.model.calls[0]!.prompt)).toContain(
    '[之前对话的摘要]',
  )
})

test('a summary that fails validation stops the turn and leaves history untouched', async () => {
  const probe = createTestVela()
  const base = await requestTokens(probe)
  await probe.cleanup()
  const t = createTestVela({
    limits: { microcompactThreshold: 1e9, summaryThreshold: base + 4 * 400 },
    responses: Array.from({ length: 4 }, (_, i) => fauxText(`回答 ${i}`)),
    generate: [fauxText('好的，摘要准备完成。')],
  })
  for (let i = 0; i < 4; i++)
    await t.run(`问题 ${i}：${'很长的背景说明。'.repeat(150)}`)
  const before = JSON.stringify(t.messages)

  await expect(
    t.run(`问题 4：${'很长的背景说明。'.repeat(150)}`),
  ).rejects.toThrow('原历史保留')

  expect(JSON.stringify(t.messages.slice(0, 8))).toBe(before)
  expect(t.session.contextManager.state.summary).toBe('')
})

test('/defend applies microcompact only and never pays for a summary', async () => {
  const t = createTestVela({
    limits: {
      microcompactThreshold: 1,
      minMicroSavings: 1,
      summaryThreshold: 1,
    },
  })
  const { output } = await captureConsole(async () => {
    t.dispatch('sim')
    await t.command('defend')
  })
  expect(output).toContain('[模拟完成]')
  // 超过摘要阈值但 /defend 不允许摘要：只报告需要摘要，不发请求
  expect(t.eventsOf('context').map((e) => e.action)).toContain(
    'summary-required',
  )
  expect(t.model.calls).toHaveLength(0)
})

test('session.compact() summarizes old history on demand, with an optional focus', async () => {
  const t = createTestVela({
    responses: Array.from({ length: 4 }, (_, i) => fauxText(`回答 ${i}`)),
    generate: [fauxSummary()],
  })
  for (let i = 0; i < 4; i++) await t.run(`第 ${i} 个问题`)

  await t.session.compact('保留第 0 个问题')

  const compact = t.eventsOf('context').find((e) => e.action === 'compact')
  expect(compact?.messages).toBe(2)
  const generate = t.model.calls.find((c) => c.kind === 'generate')!
  expect(generate.lastUserText).toContain('保留第 0 个问题')
  expect(t.session.contextManager.state.summary).toContain('## 用户目标')
  expect(await t.readData('sessions/default.jsonl')).toContain('第 0 个问题')
  expect(t.session.isRunning).toBe(false)
})

test('session.compact() refuses while a task is running', async () => {
  const t = createTestVela({ responses: [fauxHang('想')] })
  const running = t.run('慢慢想')
  while (!t.streamedText()) await Bun.sleep(1)

  await expect(t.session.compact()).rejects.toThrow('有任务正在执行中')
  await t.session.abort()
  await expect(running).rejects.toThrow()
})
