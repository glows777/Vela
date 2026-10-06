import { afterEach, expect, test } from 'bun:test'
import z from 'zod'
import {
  fauxError,
  fauxHang,
  fauxStreamError,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux'
import { cleanupTestVelas, createTestVela } from '../support/vela'

afterEach(cleanupTestVelas)

test('a 429 is retried and the turn then succeeds', async () => {
  const t = createTestVela({
    responses: [fauxError('429 Too Many Requests'), fauxError('503 overloaded'), fauxText('终于好了')],
  })

  await t.run('hi')

  expect(t.eventsOf('retry').map((e) => [e.attempt, e.maxRetries])).toEqual([
    [1, 3],
    [2, 3],
  ])
  expect(t.lastAssistantText()).toBe('终于好了')
  expect(t.events.at(-1)).toEqual({ type: 'agent_end', reason: 'done' })
  // 失败的请求不留下半截消息
  expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
})

test('a stream that breaks midway is retried from scratch', async () => {
  const t = createTestVela({
    responses: [fauxStreamError('ECONNRESET', '半截的回'), fauxText('完整的回答')],
  })

  await t.run('hi')

  expect(t.eventsOf('retry')).toHaveLength(1)
  expect(t.lastAssistantText()).toBe('完整的回答')
  expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  expect(JSON.stringify(t.messages)).not.toContain('半截的回')
})

test('a 400 is not retried: the run fails and the user message stays in the saved session', async () => {
  const t = createTestVela({ responses: [fauxError('400 Bad Request: invalid model')] })

  await expect(t.run('hi')).rejects.toThrow('400 Bad Request')

  expect(t.eventsOf('retry')).toHaveLength(0)
  expect(t.events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'error' })
  expect(t.vela.busy.locked).toBe(false)
  expect(await t.readData('.sessions/default.jsonl')).toContain('"hi"')
})

test('retries give up after maxRetries', async () => {
  const t = createTestVela({
    limits: { maxRetries: 2 },
    responses: [fauxError('500 a'), fauxError('500 b'), fauxError('500 c')],
  })

  await expect(t.run('hi')).rejects.toThrow('500 c')
  expect(t.eventsOf('retry')).toHaveLength(2)
})

test('aborting while the model is streaming stops the run; the next run works', async () => {
  const t = createTestVela({ responses: [fauxHang('正在想'), fauxText('第二次正常')] })

  const running = t.run('慢慢想')
  while (!t.streamedText()) await Bun.sleep(1)
  t.vela.abort()

  await expect(running).rejects.toThrow()
  expect(t.events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'aborted' })
  expect(t.vela.busy.locked).toBe(false)

  await t.run('再来')
  expect(t.lastAssistantText()).toBe('第二次正常')
})

test('aborting while a tool runs cancels the tool and records it as cancelled', async () => {
  const t = createTestVela({ responses: [fauxToolCall('slow', {})] })
  let started!: () => void
  const toolStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  t.vela.registry.register({
    name: 'slow',
    description: 'slow',
    inputSchema: z.object({}),
    execute: (_input, context) =>
      new Promise<string>((resolve) => {
        started()
        context?.signal?.addEventListener('abort', () => resolve('stopped early'), {
          once: true,
        })
      }),
  })

  const running = t.run('跑个慢工具')
  await toolStarted
  t.vela.abort()

  await expect(running).rejects.toThrow()
  expect(t.events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'aborted' })
  // 只请求过一次模型：中断后不会再开新一轮
  expect(t.model.calls).toHaveLength(1)
  const history = await Bun.file(t.vela.registry.results.indexPath).text()
  expect(history).toContain('"status":"cancelled"')
})

test('a second run while one is in flight is refused', async () => {
  const t = createTestVela({ responses: [fauxHang()] })
  const running = t.run('first')
  await expect(t.run('second')).rejects.toThrow('有任务正在执行中')
  while (t.model.calls.length === 0) await Bun.sleep(1)
  t.vela.abort()
  await expect(running).rejects.toThrow()
})

test('repeating the same tool call trips the loop detector: warning, then critical stop', async () => {
  const same = () => fauxToolCall('list_directory', { path: '.' })
  const t = createTestVela({
    limits: { maxTurns: 30 },
    // 检测发生在记录之前：第 11 次同参调用时已有 10 次 → warning，第 21 次 → critical
    responses: Array.from({ length: 21 }, same),
  })

  await t.run('一直列目录')

  const detections = t.eventsOf('loop_detected')
  expect(detections[0]).toMatchObject({ level: 'warning', detector: 'generic_repeat' })
  expect(detections.at(-1)).toMatchObject({ level: 'critical' })
  expect(t.events.at(-1)).toEqual({ type: 'agent_end', reason: 'loop' })
  // 警告以 system message 的形式提醒模型
  expect(JSON.stringify(t.messages)).toContain("Don't repeat the same tool call again")
  expect(t.model.calls).toHaveLength(21)
})

test('the loop stops at maxTurns', async () => {
  const t = createTestVela({
    limits: { maxTurns: 3 },
    responses: [
      fauxToolCall('list_directory', { path: '.' }),
      fauxToolCall('glob', { pattern: '*' }),
      fauxToolCall('list_directory', { path: '..' }),
    ],
  })

  await t.run('一直干活')

  expect(t.eventsOf('turn_start')).toHaveLength(3)
  expect(t.eventsOf('turn_end')).toHaveLength(3)
  expect(t.events.at(-1)).toEqual({ type: 'agent_end', reason: 'max_turns' })
})

test('the token budget warns near the limit and stops above it', async () => {
  const t = createTestVela({
    limits: { tokenBudget: 1000 },
    responses: [
      fauxToolCall('list_directory', { path: '.' }, { usage: { input: 920, output: 0 } }),
      fauxToolCall('list_directory', { path: 'x' }, { usage: { input: 200, output: 0 } }),
    ],
  })

  await t.run('干活')

  const warnings = t.eventsOf('budget_warning')
  expect(warnings[0]).toEqual({ type: 'budget_warning', used: 920, limit: 1000 })
  expect(t.eventTypes().slice(-3)).toEqual(['budget_warning', 'turn_end', 'agent_end'])
  expect(t.events.at(-1)).toEqual({ type: 'agent_end', reason: 'budget' })
})

test('a request over maxInputTokens is stopped before it is sent', async () => {
  const t = createTestVela({ limits: { maxInputTokens: 10 }, responses: [] })
  await expect(t.run('hi')).rejects.toThrow('安全容量')
  expect(t.model.calls).toHaveLength(0)
})
