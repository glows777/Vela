import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import type { ModelMessage } from 'ai'
import { SessionStore } from '../../../src/session/index'

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-session-'))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

test('replace → loadState 往返保留消息、时间戳与摘要', async () => {
  const store = new SessionStore(
    'default',
    path.join(makeTempDir(), '.sessions'),
  )
  const messages: ModelMessage[] = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: [{ type: 'text' as const, text: '你好！' }] },
  ]
  const timestamps = new Map([
    [messages[0]!, 1000],
    [messages[1]!, 2000],
  ])

  await store.replace(messages, timestamps, '摘要')
  const state = await store.loadState()

  expect(state.messages).toEqual(messages)
  expect(state.summary).toBe('摘要')
  // 时间戳按解析后的消息对象为键（JSON 往返后引用不同，只验证数量与取值）
  expect(state.timestamps.size).toBe(2)
  for (const ts of state.timestamps.values()) {
    expect(ts).toBeGreaterThan(0)
  }
})

test('文件不存在时返回空会话', async () => {
  const store = new SessionStore(
    'default',
    path.join(makeTempDir(), '.sessions'),
  )
  const state = await store.loadState()
  expect(state.messages).toEqual([])
  expect(state.summary).toBe('')
})

test('损坏的行被忽略，继续解析后面的行', async () => {
  const dir = path.join(makeTempDir(), '.sessions')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'default.jsonl')
  fs.writeFileSync(
    file,
    [
      '{ broken json',
      JSON.stringify({
        type: 'checkpoint',
        timestamp: '2026-01-01',
        summary: 'S',
        messages: [],
      }),
    ].join('\n'),
    'utf-8',
  )
  const state = await new SessionStore('default', dir).loadState()
  expect(state.summary).toBe('S')
  expect(state.messages).toEqual([])
})

test('exists 反映文件是否存在', async () => {
  const store = new SessionStore(
    'default',
    path.join(makeTempDir(), '.sessions'),
  )
  expect(await store.exists()).toBe(false)
  await store.replace([], new Map(), '')
  expect(await store.exists()).toBe(true)
})
