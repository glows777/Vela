import { afterEach, expect, test } from 'bun:test'
import {
  fauxError,
  fauxHang,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux'
import { cleanupTestVelas, createTestVela } from '../support/vela'

afterEach(cleanupTestVelas)

// 运行中排队的消息（steer / followUp，同 pi）。faux 的响应函数在请求到达时执行，
// 在里面排队就能确定地模拟“模型正在跑时用户又输入了一条”。

test('steer is injected after the current step, before the next model request', async () => {
  const t = createTestVela({
    files: { 'a.txt': 'A' },
    responses: [
      () => {
        void t.session.steer('改成读 b')
        return fauxToolCall('read_file', { path: 'a.txt' })
      },
      fauxText('好的'),
    ],
  })

  await t.run('读 a')

  // 第二次请求：工具结果之后紧跟 steer 消息
  expect(t.model.calls[1]!.lastUserText).toBe('改成读 b')
  expect(t.messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'user',
    'assistant',
  ])
  expect(t.eventsOf('agent_start')).toHaveLength(1)
  expect(t.eventsOf('queue_update')).toEqual([
    { type: 'queue_update', steering: ['改成读 b'], followUp: [] },
    { type: 'queue_update', steering: [], followUp: [] },
  ])
  expect(t.eventTypes().at(-1)).toBe('agent_settled')
})

test('a steer that arrives on the final answer keeps the loop going', async () => {
  const t = createTestVela({
    responses: [
      () => {
        void t.session.steer('再补一句')
        return fauxText('第一句')
      },
      fauxText('第二句'),
    ],
  })

  await t.run('说点什么')

  expect(t.model.calls).toHaveLength(2)
  expect(t.lastAssistantText()).toBe('第二句')
  expect(t.eventsOf('agent_end')).toEqual([
    { type: 'agent_end', reason: 'done' },
  ])
})

test('followUp waits until the model would stop, then continues in the same loop (pi)', async () => {
  const t = createTestVela({
    files: { 'a.txt': 'A' },
    responses: [
      () => {
        void t.session.followUp('然后总结一下')
        return fauxToolCall('read_file', { path: 'a.txt' })
      },
      fauxText('读完了'),
      fauxText('总结：A'),
    ],
  })

  await t.run('读 a')

  // followUp 没有插进第一个任务：第二次请求看到的还是工具结果
  expect(t.model.calls[1]!.toolResults).toHaveLength(1)
  expect(t.model.calls[2]!.lastUserText).toBe('然后总结一下')
  expect(t.eventsOf('agent_start').map((e) => e.input)).toEqual(['读 a'])
  expect(t.eventsOf('agent_end')).toEqual([
    { type: 'agent_end', reason: 'done' },
  ])
  expect(
    t.eventTypes().filter((type) => type === 'agent_settled'),
  ).toHaveLength(1)
  expect(t.lastAssistantText()).toBe('总结：A')
})

test('one-at-a-time takes one queued steer per step; all takes them together', async () => {
  const t = createTestVela({
    responses: [
      () => {
        void t.session.steer('一')
        void t.session.steer('二')
        return fauxText('a')
      },
      fauxText('b'),
      fauxText('c'),
      () => {
        void t.session.steer('三')
        void t.session.steer('四')
        return fauxText('d')
      },
      fauxText('e'),
    ],
  })

  await t.run('开始')
  expect(t.model.calls.map((c) => c.lastUserText)).toEqual(['开始', '一', '二'])

  t.session.steeringMode = 'all'
  await t.run('再来')
  expect(t.model.calls.at(-1)!.prompt.slice(-2)).toMatchObject([
    { role: 'user', content: [{ type: 'text', text: '三' }] },
    { role: 'user', content: [{ type: 'text', text: '四' }] },
  ])
})

test('prompt() while running needs a streamingBehavior; with one it queues', async () => {
  const t = createTestVela({ responses: [fauxHang('想')] })
  const running = t.run('慢慢想')
  while (!t.streamedText()) await Bun.sleep(1)

  await expect(t.session.prompt('插一句')).rejects.toThrow('steer()')
  await t.session.prompt('插一句', { streamingBehavior: 'followUp' })
  expect(t.session.queue).toEqual({ steering: [], followUp: ['插一句'] })

  // 中断前清空队列（TUI / RPC 的做法），abort 等真正停下
  expect(t.session.clearQueue()).toEqual({ steering: [], followUp: ['插一句'] })
  await t.session.abort()
  expect(t.session.isRunning).toBe(false)
  await expect(running).rejects.toThrow()
  expect(t.eventTypes().at(-1)).toBe('agent_settled')
})

test('abort stops the task and leaves queued messages in the queue', async () => {
  const t = createTestVela({ responses: [fauxHang('想')] })
  const running = t.run('慢慢想')
  while (!t.streamedText()) await Bun.sleep(1)
  await t.session.followUp('之后再做')

  await t.session.abort()

  await expect(running).rejects.toThrow()
  expect(t.model.calls).toHaveLength(1)
  expect(t.session.queue.followUp).toEqual(['之后再做'])
})

test('queued messages still run after the task fails; prompt() then rejects with the failure', async () => {
  const t = createTestVela({
    responses: [
      () => {
        void t.session.followUp('换个问题')
        return fauxError('400 Bad Request')
      },
      fauxText('好的'),
    ],
  })

  await expect(t.run('坏请求')).rejects.toThrow('400 Bad Request')

  expect(t.eventsOf('agent_end').map((e) => e.reason)).toEqual([
    'error',
    'done',
  ])
  expect(t.lastAssistantText()).toBe('好的')
})

test('steer and followUp on an idle session behave like prompt()', async () => {
  const t = createTestVela({ responses: [fauxText('一'), fauxText('二')] })

  await t.session.steer('你好')
  await t.session.followUp('再见')

  expect(t.model.calls.map((c) => c.lastUserText)).toEqual(['你好', '再见'])
})

test('thinking text from the model is streamed as thinking_delta', async () => {
  const t = createTestVela({
    responses: [{ reasoning: '先想一想', text: '答案' }],
  })

  await t.run('问题')

  expect(
    t
      .eventsOf('thinking_delta')
      .map((e) => e.text)
      .join(''),
  ).toBe('先想一想')
  expect(t.streamedText()).toBe('答案')
})

test('an extension command can abort the running task without waiting on itself', async () => {
  const t = createTestVela({
    responses: [fauxHang('想')],
    extensions: [
      (vela) =>
        vela.registerCommand('stop', {
          handler: async (_args, ctx) => {
            await ctx.session.abort()
            ctx.ui.notify('stopped')
          },
        }),
    ],
  })
  const running = t.run('慢慢想')
  while (!t.streamedText()) await Bun.sleep(1)

  await t.run('/stop')

  await expect(running).rejects.toThrow()
  expect(t.eventsOf('notify').map((e) => e.message)).toEqual(['stopped'])
})

test('messages cannot be queued while a non-prompt task (compact) holds the session', async () => {
  const t = createTestVela({
    responses: [fauxText('一'), fauxText('二'), fauxText('三'), fauxText('四')],
    generate: [fauxHang()],
    // 压缩可能在发出摘要请求前就被中断
    allowPendingResponses: true,
  })
  for (const q of ['1', '2', '3', '4']) await t.run(q)
  const compacting = t.session.compact()
  expect(t.session.isRunning).toBe(true)

  await expect(t.session.steer('插队')).rejects.toThrow('有任务正在执行中')
  await t.session.abort()
  await expect(compacting).rejects.toThrow()
})
