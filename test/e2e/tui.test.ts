import { afterEach, expect, test } from 'bun:test'
import confirmDangerous from '../../examples/extensions/confirm-dangerous.ts'
import todo from '../../examples/extensions/todo-command.ts'
import type { ProviderDefinition } from '../../src/models/index.ts'
import {
  createFauxModel,
  fauxHang,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux.ts'
import { KEYS, startTui, stopTuis } from '../support/terminal.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(async () => {
  await stopTuis()
  await cleanupTestVelas()
})

// 交互模式（pi-tui）在假终端里跑：按键直接送给 TUI，断言渲染出来的整屏文字。

test('a prompt shows the user message, tool calls with results and the streamed answer', async () => {
  const t = createTestVela({
    files: { 'a.txt': 'hello from a' },
    responses: [
      fauxToolCall('read_file', { path: 'a.txt' }),
      fauxText('**文件**里是 hello'),
    ],
  })
  const tui = await startTui(t.vela)
  await tui.started

  tui.submit('读 a.txt')
  await tui.until('文件里是 hello')

  const screen = tui.screen()
  expect(screen).toContain('读 a.txt')
  expect(screen).toContain('read_file a.txt')
  expect(screen).toContain('hello from a')
  // 底栏：会话、模型、thinking
  expect(screen).toContain('tui')
  expect(screen).toMatch(/faux.* · medium/)
  await tui.until(() => !t.vela.session('tui').isRunning)
  expect(tui.screen()).not.toContain('Esc 中断)')
})

test('Enter while running steers, Alt+Enter queues a follow-up, Esc puts the queue back and aborts', async () => {
  const t = createTestVela({ responses: [fauxHang('想')] })
  const tui = await startTui(t.vela)
  await tui.started
  tui.submit('慢慢想')
  await tui.until('想')
  const session = t.vela.session('tui')
  expect(session.isRunning).toBe(true)

  tui.submit('插一句')
  tui.terminal.type('之后再做')
  tui.terminal.press(KEYS.altEnter)
  await tui.until('Follow-up: 之后再做')
  expect(session.queue).toEqual({
    steering: ['插一句'],
    followUp: ['之后再做'],
  })
  expect(tui.screen()).toContain('Steering: 插一句')

  tui.terminal.press(KEYS.escape)
  await tui.until('已中断')
  await tui.until(() => !session.isRunning)
  expect(session.queue).toEqual({ steering: [], followUp: [] })
  // 排队的消息放回了输入框
  expect(tui.screen()).toContain('插一句')
  expect(tui.screen()).toContain('之后再做')
  expect(tui.screen()).not.toContain('Follow-up:')
})

test('a steer typed while the model streams is answered in the same run', async () => {
  let tui!: Awaited<ReturnType<typeof startTui>>
  const t = createTestVela({
    responses: [
      () => {
        tui.submit('再补一句')
        return fauxText('第一句')
      },
      fauxText('第二句'),
    ],
  })
  tui = await startTui(t.vela)
  await tui.started
  tui.submit('说点什么')
  await tui.until('第二句')
  expect(t.model.calls.map((c) => c.lastUserText)).toEqual([
    '说点什么',
    '再补一句',
  ])
})

test('an extension confirm opens a dialog in place of the editor', async () => {
  const t = createTestVela({
    extensions: [confirmDangerous],
    responses: [
      fauxToolCall('bash', { command: 'rm -rf build' }),
      fauxText('好的'),
    ],
  })
  const tui = await startTui(t.vela)
  await tui.started
  tui.submit('清理')
  await tui.until('要删除文件')
  expect(tui.screen()).toContain('rm -rf build')
  // 选“否”：↓ 再 Enter
  tui.terminal.press(KEYS.down)
  tui.terminal.press(KEYS.enter)
  await tui.until('好的')
  expect(t.model.calls[1]!.toolResults[0]!.output).toContain('用户没有允许删除')
})

test('slash commands: CLI command output, extension commands and /hotkeys go to the chat', async () => {
  const t = createTestVela({ extensions: [todo] })
  const tui = await startTui(t.vela)
  await tui.started

  tui.submit('/extensions')
  // 命令逐行 print 的输出合成一段，行之间不空行
  await tui.until('[extensions]\n   memory\n     工具: memory')
  tui.submit('/todo 买牛奶')
  await tui.until('买牛奶')
  tui.submit('/hotkeys')
  await tui.until('Alt+Up 把排队的消息拿回输入框')
})

test('terminal control sequences in tool output and channel messages are not written to the terminal', async () => {
  const t = createTestVela({
    files: { 'a.txt': 'x\x1b]0;PWNED\x07y\x1b[31mred\x1b]52;c;ZXZpbA==\x07' },
    responses: [
      fauxToolCall('read_file', { path: 'a.txt' }),
      fauxText('done'),
      fauxText('回复'),
    ],
  })
  t.internals.gateway.register({
    name: 'fake',
    description: 'test channel',
    start: () => {},
    stop: () => {},
    send: async () => {},
  })
  const tui = await startTui(t.vela)
  await tui.started
  tui.submit('读 a.txt')
  await tui.until('done')
  await tui.until(() => !t.vela.session('tui').isRunning)
  // 通道里的人（不受信任）发来的消息
  await t.internals.gateway.handleIncoming('fake', {
    channelId: 'c1',
    senderId: 'guest',
    senderName: 'guest',
    text: 'hi\x1b]0;PWNED\x07there',
  })
  await tui.until('[fake] guest: hithere')
  const raw = tui.mode.tui.render(100).join('\n')
  expect(raw).not.toContain(']0;PWNED')
  expect(raw).not.toContain(']52;')
  expect(tui.screen()).toContain('xyred')
})

test('SIGTERM shuts the TUI down like Ctrl+D', async () => {
  const t = createTestVela()
  const tui = await startTui(t.vela)
  await tui.started
  process.emit('SIGTERM')
  await tui.mode.exited
  expect(tui.exited()).toBe(true)
  expect(process.listenerCount('SIGTERM')).toBe(0)
})

test('slash commands still run while the agent is busy instead of being steered', async () => {
  const t = createTestVela({ responses: [fauxHang('想')] })
  const tui = await startTui(t.vela)
  await tui.started
  tui.submit('慢慢想')
  await tui.until('想')
  tui.submit('/usage')
  await tui.until('Usage Summary')
  expect(t.vela.session('tui').queue.steering).toEqual([])
})

test('model and thinking selectors; Shift+Tab cycles thinking', async () => {
  const big = createFauxModel({ modelId: 'big' })
  const plain = createFauxModel({ modelId: 'plain' })
  const provider: ProviderDefinition = {
    models: [{ id: 'big', contextWindow: 32_768 }, { id: 'plain' }],
    createModel: (id) => (id === 'big' ? big : plain),
  }
  const t = createTestVela({ model: 'fake/big', providers: { fake: provider } })
  const tui = await startTui(t.vela)
  await tui.started
  const session = t.vela.session('tui')

  tui.terminal.press(KEYS.ctrlL)
  await tui.until('选择模型')
  expect(tui.screen()).toContain('fake/big ✓')
  // 光标从当前模型开始
  tui.terminal.press(KEYS.down)
  tui.terminal.press(KEYS.enter)
  await tui.until('模型: fake/plain')
  expect(session.modelInfo.ref).toBe('fake/plain')

  tui.submit('/thinking')
  await tui.until('thinking 级别')
  tui.terminal.press(KEYS.down)
  tui.terminal.press(KEYS.enter)
  await tui.until(() => session.thinkingLevel === 'high')

  tui.terminal.press(KEYS.shiftTab)
  expect(session.thinkingLevel).toBe('xhigh')
})

test('/name, /new and /resume switch between saved sessions', async () => {
  const t = createTestVela({ responses: [fauxText('第一个会话的回答')] })
  const tui = await startTui(t.vela, { sessionId: 'first' })
  await tui.started
  tui.submit('你好')
  await tui.until('第一个会话的回答')
  await tui.until(() => !t.vela.session('first').isRunning)
  tui.submit('/name 打招呼')
  await tui.until('会话名: 打招呼')

  tui.submit('/new')
  await tui.until('会话 tui-new-1')
  expect(tui.screen()).not.toContain('第一个会话的回答')

  tui.submit('/resume')
  await tui.until('选择要恢复的会话')
  expect(tui.screen()).toContain('打招呼')
  tui.terminal.press(KEYS.enter)
  await tui.until('恢复会话 打招呼')
  // 历史重新画出来
  expect(tui.screen()).toContain('第一个会话的回答')
  expect(tui.screen()).toContain('你好')
})

test('-r picks a saved session before the chat starts', async () => {
  const t = createTestVela({ responses: [fauxText('旧回答')] })
  await t.vela.session('old').prompt('旧问题')
  const tui = await startTui(t.vela, { pick: true })
  await tui.until('选择要恢复的会话')
  tui.terminal.press(KEYS.enter)
  await tui.started
  await tui.until('旧回答')
  expect(tui.screen()).toContain('会话 old')
})

test('Ctrl+C clears the editor, twice exits; Ctrl+D on an empty editor exits', async () => {
  const t = createTestVela()
  const tui = await startTui(t.vela)
  await tui.started
  tui.terminal.type('草稿')
  await tui.until('草稿')
  tui.terminal.press(KEYS.ctrlC)
  await tui.until(() => !tui.screen().includes('草稿'))
  expect(tui.exited()).toBe(false)

  tui.terminal.press(KEYS.ctrlD)
  await tui.mode.exited
  expect(tui.exited()).toBe(true)
})
