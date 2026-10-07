import { APICallError } from '@ai-sdk/provider'
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
    responses: [
      fauxError('429 Too Many Requests'),
      fauxError('503 overloaded'),
      fauxText('终于好了'),
    ],
  })

  await t.run('hi')

  expect(t.eventsOf('retry').map((e) => [e.attempt, e.maxRetries])).toEqual([
    [1, 3],
    [2, 3],
  ])
  expect(t.lastAssistantText()).toBe('终于好了')
  expect(t.eventsOf('agent_end').at(-1)).toEqual({
    type: 'agent_end',
    reason: 'done',
  })
  // 失败的请求不留下半截消息
  expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
})

test('a provider 429 whose message has no status code is still retried', async () => {
  const t = createTestVela({
    responses: [
      fauxError(
        new APICallError({
          message: 'Rate limit reached for requests',
          statusCode: 429,
          url: 'https://api.example.com/v1/chat/completions',
          requestBodyValues: {},
        }),
      ),
      fauxText('好了'),
    ],
  })

  await t.run('hi')

  expect(t.eventsOf('retry')).toHaveLength(1)
  expect(t.lastAssistantText()).toBe('好了')
})

test('a stream that breaks midway is retried from scratch', async () => {
  const t = createTestVela({
    responses: [
      fauxStreamError('ECONNRESET', '半截的回'),
      fauxText('完整的回答'),
    ],
  })

  await t.run('hi')

  expect(t.eventsOf('retry')).toHaveLength(1)
  expect(t.lastAssistantText()).toBe('完整的回答')
  expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  expect(JSON.stringify(t.messages)).not.toContain('半截的回')
})

test('a 400 is not retried: the run fails and the user message stays in the saved session', async () => {
  const t = createTestVela({
    responses: [fauxError('400 Bad Request: invalid model')],
  })

  await expect(t.run('hi')).rejects.toThrow('400 Bad Request')

  expect(t.eventsOf('retry')).toHaveLength(0)
  expect(t.eventsOf('agent_end').at(-1)).toMatchObject({
    type: 'agent_end',
    reason: 'error',
  })
  expect(t.session.busy.locked).toBe(false)
  expect(await t.readData('sessions/default.jsonl')).toContain('"hi"')
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
  const t = createTestVela({
    responses: [fauxHang('正在想'), fauxText('第二次正常')],
  })

  const running = t.run('慢慢想')
  while (!t.streamedText()) await Bun.sleep(1)
  t.session.abort()

  await expect(running).rejects.toThrow()
  expect(t.eventsOf('agent_end').at(-1)).toMatchObject({
    type: 'agent_end',
    reason: 'aborted',
  })
  expect(t.session.busy.locked).toBe(false)

  await t.run('再来')
  expect(t.lastAssistantText()).toBe('第二次正常')
})

test('aborting while a tool runs cancels the tool and records it as cancelled', async () => {
  const t = createTestVela({ responses: [fauxToolCall('slow', {})] })
  let started!: () => void
  const toolStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  t.internals.registry.register({
    name: 'slow',
    description: 'slow',
    inputSchema: z.object({}),
    execute: (_input, context) =>
      new Promise<string>((resolve) => {
        started()
        context?.signal?.addEventListener(
          'abort',
          () => resolve('stopped early'),
          {
            once: true,
          },
        )
      }),
  })

  const running = t.run('跑个慢工具')
  await toolStarted
  t.session.abort()

  await expect(running).rejects.toThrow()
  expect(t.eventsOf('agent_end').at(-1)).toMatchObject({
    type: 'agent_end',
    reason: 'aborted',
  })
  // 只请求过一次模型：中断后不会再开新一轮
  expect(t.model.calls).toHaveLength(1)
  const history = await Bun.file(t.session.registry.results.indexPath).text()
  expect(history).toContain('"status":"cancelled"')
})

test('a second run while one is in flight is refused', async () => {
  const t = createTestVela({ responses: [fauxHang()] })
  const running = t.run('first')
  await expect(t.run('second')).rejects.toThrow('有任务正在执行中')
  while (t.model.calls.length === 0) await Bun.sleep(1)
  t.session.abort()
  await expect(running).rejects.toThrow()
})

test('repeating the same tool call trips the loop detector: warning, then critical stop', async () => {
  const same = () => fauxToolCall('list_directory', { path: '.' })
  const t = createTestVela({
    // 检测发生在记录之前：第 11 次同参调用时已有 10 次 → warning，第 21 次 → critical
    responses: Array.from({ length: 21 }, same),
  })

  await t.run('一直列目录')

  const detections = t.eventsOf('loop_detected')
  expect(detections[0]).toMatchObject({
    level: 'warning',
    detector: 'generic_repeat',
  })
  expect(detections.at(-1)).toMatchObject({ level: 'critical' })
  expect(t.eventsOf('agent_end').at(-1)).toEqual({
    type: 'agent_end',
    reason: 'loop',
  })
  // 警告以 system message 的形式提醒模型，并且排在触发它的那次调用和结果之后
  const firstWarning = t.messages.findIndex(
    (m) =>
      m.role === 'user' &&
      String(m.content).includes("Don't repeat the same tool call again"),
  )
  expect(firstWarning).toBeGreaterThan(0)
  expect(
    t.messages.slice(firstWarning - 2, firstWarning).map((m) => m.role),
  ).toEqual(['assistant', 'tool'])
  expect(JSON.stringify(t.messages[firstWarning - 2]!.content)).toContain(
    'faux-call-11-1',
  )
  expect(t.model.calls).toHaveLength(21)
})

test('there is no turn limit: the loop runs until the model stops calling tools (same as pi)', async () => {
  const t = createTestVela({
    responses: [
      ...Array.from({ length: 20 }, (_, i) =>
        fauxToolCall('glob', { pattern: `*${i}` }),
      ),
      fauxText('做完了'),
    ],
  })

  await t.run('一直干活')

  expect(t.eventsOf('turn_start')).toHaveLength(21)
  expect(t.eventsOf('agent_end').at(-1)).toEqual({
    type: 'agent_end',
    reason: 'done',
  })
})

test('a request over maxInputTokens is stopped before it is sent', async () => {
  const t = createTestVela({ limits: { maxInputTokens: 10 }, responses: [] })
  await expect(t.run('hi')).rejects.toThrow('安全容量')
  expect(t.model.calls).toHaveLength(0)
})
