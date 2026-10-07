import { afterEach, expect, test } from 'bun:test'
import { z } from 'zod'
import type { VelaEvent } from '../../src/agent/events'
import { fauxHang, fauxText, fauxToolCall } from '../../src/testing/faux'
import { cleanupTestVelas, createTestVela } from '../support/vela'

afterEach(cleanupTestVelas)

const waitFor = async (check: () => boolean) => {
  while (!check()) await Bun.sleep(1)
}

test('two sessions run at the same time with separate history, files, locks and usage', async () => {
  const t = createTestVela({
    responses: [fauxHang('a 在想'), fauxText('b 的回答')],
    allowPendingResponses: true,
  })
  const a = t.vela.session('a')
  const b = t.vela.session('b')

  const running = a.prompt('问 a')
  await waitFor(() => t.model.calls.length === 1)
  expect(a.busy.locked).toBe(true)
  expect(b.busy.locked).toBe(false)

  await b.prompt('问 b')
  expect(b.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  expect(t.model.calls[1]!.lastUserText).toBe('问 b')
  expect(JSON.stringify(t.model.calls[1]!.prompt)).not.toContain('问 a')

  a.abort()
  await expect(running).rejects.toThrow()
  expect(a.busy.locked).toBe(false)
  expect(a.messages.map((m) => m.role)).toEqual(['user'])

  expect(await t.readData('.sessions/b.jsonl')).toContain('b 的回答')
  expect(await t.readData('.sessions/a.jsonl')).not.toContain('b 的回答')
  expect(b.usage.totals.steps).toBe(1)
  expect(a.usage.totals.steps).toBe(0)
  expect(t.session.messages).toEqual([])
})

test('vela.session(id) returns the open session and rejects ids that are not safe file names', () => {
  const t = createTestVela()
  expect(t.vela.session('default')).toBe(t.session)
  expect(t.vela.session()).toBe(t.session)
  expect(t.vela.session('x')).toBe(t.vela.session('x'))
  expect(t.vela.sessions().map((s) => s.id)).toEqual(['default', 'x'])
  for (const bad of ['../evil', 'a/b', '.hidden', '', 'feishu:ou_1'])
    expect(() => t.vela.session(bad)).toThrow('无效的会话 id')
})

test('session.subscribe only sees its own events; vela.subscribe sees all with the session id', async () => {
  const t = createTestVela({
    responses: [fauxText('一'), fauxText('二'), fauxText('三')],
  })
  const other = t.vela.session('other')
  const mine: VelaEvent['type'][] = []
  const all: string[] = []
  const off = t.session.subscribe((event) => mine.push(event.type))
  const offAll = t.vela.subscribe((event, id) => {
    if (event.type === 'agent_end') all.push(id)
  })

  await t.run('1')
  await other.prompt('2')
  off()
  await t.run('3')
  offAll()

  expect(mine.filter((type) => type === 'agent_end')).toHaveLength(1)
  expect(all).toEqual(['default', 'other', 'default'])
  expect(t.eventsIn('other').at(-1)).toEqual({
    type: 'agent_end',
    reason: 'done',
  })
})

test('tools discovered with tool_search are only active in the session that searched', async () => {
  const t = createTestVela({
    responses: [
      fauxToolCall('tool_search', { query: 'deferred_echo' }),
      fauxText('找到了'),
      fauxText('另一个会话'),
    ],
  })
  t.internals.registry.register({
    name: 'deferred_echo',
    description: 'echo',
    inputSchema: z.object({ text: z.string() }),
    exposure: 'deferred',
    execute: async ({ text }: { text: string }) => text,
  })

  await t.run('找 deferred_echo')
  expect(t.model.calls[1]!.tools).toContain('deferred_echo')

  await t.vela.session('other').prompt('你有哪些工具')
  expect(t.model.calls[2]!.tools).not.toContain('deferred_echo')
  expect(t.model.calls[2]!.system).toContain('deferred_echo')
})

test('active skills belong to the session', () => {
  const t = createTestVela({
    skills: [{ name: 'review', description: '代码评审', body: '按清单评审' }],
  })
  t.session.activeSkills.add('review')
  expect(t.session.buildSystem()).toContain('✓ 已激活')
  expect(t.vela.session('other').buildSystem()).not.toContain('✓ 已激活')
})

test('close() stops a running prompt, saves it and removes the session', async () => {
  const t = createTestVela({
    responses: [fauxHang()],
  })
  const s = t.vela.session('closing')
  const running = s.prompt('一直想')
  await waitFor(() => t.model.calls.length === 1)

  await s.close()
  await expect(running).rejects.toThrow()
  expect(t.vela.sessions().map((x) => x.id)).toEqual(['default'])
  expect(await t.readData('.sessions/closing.jsonl')).toContain('一直想')
  await expect(s.prompt('again')).rejects.toThrow('已关闭')
  // 同一个 id 再打开是一个新会话，可以从磁盘恢复
  const reopened = t.vela.session('closing')
  expect(reopened).not.toBe(s)
  expect(await reopened.resume()).toBe(true)
})

test('vela.dispose() aborts running sessions and refuses new ones', async () => {
  const t = createTestVela({ responses: [fauxHang()] })
  const running = t.run('一直想')
  await waitFor(() => t.model.calls.length === 1)

  await t.vela.dispose()
  await expect(running).rejects.toThrow()
  expect(t.session.busy.locked).toBe(false)
  expect(() => t.vela.session('late')).toThrow('dispose')
})

test('resume() refuses to replace the history of a running session', async () => {
  const t = createTestVela({ responses: [fauxHang()] })
  const running = t.session.prompt('一直想')
  while (t.model.calls.length === 0) await Bun.sleep(1)
  await expect(t.session.resume()).rejects.toThrow()
  t.session.abort()
  await running.catch(() => {})
  expect(t.session.messages[0]).toMatchObject({
    role: 'user',
    content: '一直想',
  })
})

test('tool calls from sessions running at the same time are recorded in their own session', async () => {
  const big = (tag: string) => `${tag}\n${'x'.repeat(5000)}`
  // 两个会话并发，请求先后不确定：按请求里的用户消息决定读哪个文件
  const readOwn = (req: { lastUserText: string }) =>
    fauxToolCall('read_file', { path: `${req.lastUserText}.txt` })
  const t = createTestVela({
    files: { 'a.txt': big('AAA'), 'b.txt': big('BBB') },
    responses: [readOwn, readOwn, fauxText('读完了'), fauxText('读完了')],
  })
  const a = t.vela.session('a')
  const b = t.vela.session('b')

  await Promise.all([a.prompt('a'), b.prompt('b')])

  const recorded = async (id: string) => {
    let text = ''
    for await (const file of new Bun.Glob(`.sessions/${id}/**/*`).scan({
      cwd: t.vela.dataDir,
    }))
      text += await t.readData(file)
    return text
  }
  const inA = await recorded('a')
  const inB = await recorded('b')
  expect(inA).toContain('AAA')
  expect(inA).not.toContain('BBB')
  expect(inB).toContain('BBB')
  expect(inB).not.toContain('AAA')
})
