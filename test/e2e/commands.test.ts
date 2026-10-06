import { afterEach, expect, test } from 'bun:test'
import type { IncomingMessage, OutgoingMessage } from '../../src/channels/types'
import { supabasePlugin } from '../../src/plugins/built-in-plugins/supabase-plugin'
import { fauxText, fauxToolCall } from '../../src/testing/faux'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
} from '../support/vela'

afterEach(cleanupTestVelas)

test('/context and /usage report the conversation after a run', async () => {
  const t = createTestVela({
    responses: [fauxText('ok', { usage: { input: 1234, output: 56 } })],
  })
  await t.run('hi')

  const { output } = await captureConsole(() => {
    expect(t.dispatch('/context')).toBe(true)
    expect(t.dispatch('/usage')).toBe(true)
    expect(t.dispatch('status')).toBe(true)
  })
  expect(output).toContain('Usage Summary')
  expect(output).toContain('1 步累计')
  expect(output).toMatch(/Input\s+1\.2k tokens/)
  expect(output).toContain('[状态] 2 条消息')
})

test('/plugin load registers plugin tools the model can call right away', async () => {
  const t = createTestVela({
    plugins: new Map([['supabase', supabasePlugin]]),
    responses: [
      (req) => {
        expect(req.tools).toContain('supabase__list_tables')
        return fauxToolCall('supabase__list_tables', {})
      },
      (req) =>
        fauxText(
          req.toolResults[0]!.output.includes('users') ? '有 users 表' : '?',
        ),
    ],
  })

  await captureConsole(async () => {
    expect(t.dispatch('/plugin load supabase')).toBe(true)
    while (!t.vela.pluginManager.get('supabase')) await Bun.sleep(1)
  })
  await t.run('有哪些表？')
  expect(t.lastAssistantText()).toBe('有 users 表')

  await captureConsole(async () => {
    t.dispatch('/plugin unload supabase')
    while (t.vela.pluginManager.get('supabase')) await Bun.sleep(1)
  })
  expect(t.vela.registry.getAllTools().map((tool) => tool.name)).not.toContain(
    'supabase__list_tables',
  )
})

test('a message from a channel runs through the same model and tools, and the reply is sent back', async () => {
  const sent: OutgoingMessage[] = []
  let deliver!: (msg: IncomingMessage) => void
  const t = createTestVela({
    files: { 'faq.md': '营业时间：9:00-18:00' },
    responses: [
      fauxToolCall('read_file', { path: 'faq.md' }),
      fauxText('我们 9 点到 18 点营业'),
    ],
  })
  t.vela.gateway.register({
    name: 'fake',
    description: 'test channel',
    start: () => {},
    stop: () => {},
    send: async (message) => {
      sent.push(message)
    },
    onMessage: (handler) => {
      deliver = handler
    },
  })

  await captureConsole(async () => {
    deliver({
      channelId: 'c1',
      senderId: 'u1',
      senderName: '小王',
      text: '几点营业？',
    })
    while (sent.length === 0) await Bun.sleep(1)
  })

  expect(sent).toEqual([
    { channelId: 'c1', recipientId: 'u1', text: '我们 9 点到 18 点营业' },
  ])
  expect(t.eventsOf('tool_call')[0]).toMatchObject({ toolName: 'read_file' })
  // 通道会话独立于 CLI 会话
  expect(t.messages).toEqual([])
  const { output } = await captureConsole(() => t.dispatch('/channel list'))
  expect(output).toContain('fake — test channel')
})
