import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { channelSessionId } from '../../src/channels/gateway.ts'
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from '../../src/channels/types.ts'
import { fauxHang, fauxText } from '../../src/testing/faux.ts'
import {
  cleanupTestVelas,
  createTestVela,
  type TestVela,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

/** 注册一个假的通道，返回投递消息的函数和已发送的回复 */
function fakeChannel(t: TestVela, name = 'fake') {
  const sent: OutgoingMessage[] = []
  const channel: ChannelDefinition = {
    name,
    description: 'test channel',
    start: () => {},
    stop: () => {},
    send: async (message) => {
      sent.push(message)
    },
  }
  t.internals.gateway.register(channel)
  const deliver = (senderId: string, text: string) =>
    t.internals.gateway.handleIncoming(name, {
      channelId: 'c1',
      senderId,
      senderName: senderId,
      text,
    } satisfies IncomingMessage)
  return { sent, deliver }
}

test('each sender gets its own persisted session', async () => {
  // 两个会话并发，请求先后不确定：按请求里的用户消息回答
  const answer = (req: { lastUserText: string }) =>
    fauxText(`你好 ${req.lastUserText.slice(-2)}`)
  const t = createTestVela({ responses: [answer, answer] })
  const { sent, deliver } = fakeChannel(t)

  await Promise.all([deliver('u1', '我是 u1'), deliver('u2', '我是 u2')])

  expect(
    sent
      .map((m) => [m.recipientId, m.text])
      .sort((a, b) => a[0]!.localeCompare(b[0]!)),
  ).toEqual([
    ['u1', '你好 u1'],
    ['u2', '你好 u2'],
  ])
  expect(channelSessionId('fake', 'u1')).toBe('fake-u1')
  expect(await t.readData('sessions/fake-u1.jsonl')).toContain('我是 u1')
  expect(await t.readData('sessions/fake-u2.jsonl')).not.toContain('我是 u1')
  expect(t.eventsIn('fake-u1').map((e) => e.type)).toContain('channel_reply')
  // CLI 的默认会话不受影响
  expect(t.session.messages).toEqual([])
  expect(t.exists('sessions/default.jsonl')).toBe(false)
})

test('a sender continues the conversation after a restart', async () => {
  const first = createTestVela({ responses: [fauxText('记住了：蓝色')] })
  await fakeChannel(first).deliver('u1', '我喜欢蓝色')
  await first.cleanup({ keepDir: true })

  const second = createTestVela({
    cwd: first.cwd,
    responses: [
      (req) =>
        fauxText(
          JSON.stringify(req.prompt).includes('我喜欢蓝色') ? '蓝色' : '不知道',
        ),
    ],
  })
  try {
    const { sent, deliver } = fakeChannel(second)
    await deliver('u1', '我喜欢什么颜色？')
    expect(sent.at(-1)?.text).toBe('蓝色')
  } finally {
    await second.cleanup()
    rmSync(first.cwd, { recursive: true, force: true })
  }
})

test('messages from the same sender are handled one after another', async () => {
  const t = createTestVela({
    responses: [fauxText('第一条的回复'), fauxText('第二条的回复')],
  })
  const { sent, deliver } = fakeChannel(t)

  await Promise.all([deliver('u1', '第一条'), deliver('u1', '第二条')])

  expect(sent.map((m) => m.text)).toEqual(['第一条的回复', '第二条的回复'])
  // 第二次请求看到了第一轮的完整历史
  expect(JSON.stringify(t.model.calls[1]!.prompt)).toContain('第一条的回复')
  expect(
    t.eventsIn('fake-u1').filter((e) => e.type === 'channel_error'),
  ).toEqual([])
})

test('stopping the gateway aborts a running channel session and reports it', async () => {
  const t = createTestVela({ responses: [fauxHang()] })
  const { sent, deliver } = fakeChannel(t)

  const handled = deliver('u1', '一直想')
  while (t.model.calls.length === 0) await Bun.sleep(1)
  await t.internals.gateway.stopAll()
  await handled

  expect(sent).toEqual([])
  expect(t.eventsOf('channel_error')).toMatchObject([
    { channel: 'fake', senderId: 'u1', aborted: true },
  ])
})

test('senders whose ids sanitize to the same string get separate sessions', async () => {
  // 只替换非法字符会让 a@b 和 a_b、或 (fake, x-y) 和 (fake-x, y) 落到同一个会话文件，互相看到历史
  expect(channelSessionId('fake', 'a@b')).not.toBe(
    channelSessionId('fake', 'a_b'),
  )
  expect(channelSessionId('fake', 'x-y')).not.toBe(
    channelSessionId('fake-x', 'y'),
  )
  const long = 'u'.repeat(200)
  expect(channelSessionId('fake', `${long}1`)).not.toBe(
    channelSessionId('fake', `${long}2`),
  )
  // 普通 id 保持可读
  expect(channelSessionId('feishu', 'ou_123')).toBe('feishu-ou_123')

  const t = createTestVela({ responses: [fauxText('好'), fauxText('不知道')] })
  const { deliver } = fakeChannel(t)
  await deliver('a@b', '我的密码是 hunter2')
  await deliver('a_b', '你知道什么？')
  expect(JSON.stringify(t.model.calls[1]?.prompt)).not.toContain('hunter2')
})

test('a channel session closed while idle resumes its history when reopened', async () => {
  const t = createTestVela({
    responses: [
      fauxText('记住了：蓝色'),
      (req) =>
        fauxText(
          JSON.stringify(req.prompt).includes('我喜欢蓝色') ? '蓝色' : '不知道',
        ),
    ],
  })
  const { sent, deliver } = fakeChannel(t)
  await deliver('u1', '我喜欢蓝色')
  // 长期运行的机器人可能关掉空闲会话释放内存
  await t.vela.session(channelSessionId('fake', 'u1')).close()

  await deliver('u1', '我喜欢什么颜色？')
  expect(sent.at(-1)?.text).toBe('蓝色')
  expect(await t.readData('sessions/fake-u1.jsonl')).toContain('我喜欢蓝色')
})
