import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tempDir } from '../support/vela'

// `vela --mode rpc` 子进程：stdin 写 JSONL 命令，stdout 读 response / 事件 / extension_ui_request

const ROOT = resolve(import.meta.dir, '../..')
const ENTRY = join(ROOT, 'src/cli/main.ts')
const scenario = (name: string) =>
  join(ROOT, 'test/fixtures/scenarios', `${name}.json`)

setDefaultTimeout(30_000)

const dirs: { cleanup(): void }[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

type RpcRecord = { type: string; [key: string]: unknown }

function startRpc(
  model: string,
  args: string[] = [],
  files: Record<string, string> = {},
) {
  const cwd = tempDir('vela-rpc-')
  const home = tempDir('vela-home-')
  dirs.push(cwd, home)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(home.path, path)), { recursive: true })
    writeFileSync(join(home.path, path), content)
  }
  const proc = Bun.spawn(['bun', ENTRY, '--mode', 'rpc', ...args], {
    cwd: cwd.path,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home.path,
      VELA_DIR: home.path,
      VELA_MODEL: model,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const records: RpcRecord[] = []
  let waiters: (() => void)[] = []
  void (async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        records.push(JSON.parse(buffer.slice(0, newline)))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      for (const wake of waiters.splice(0)) wake()
    }
    for (const wake of waiters.splice(0)) wake()
  })()
  const waitFor = async (
    match: (r: RpcRecord) => boolean,
  ): Promise<RpcRecord> => {
    for (;;) {
      const found = records.find(match)
      if (found) return found
      if (proc.exitCode !== null)
        throw new Error(
          `vela exited:\n${await new Response(proc.stderr).text()}`,
        )
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
  }
  let next = 0
  return {
    records,
    waitFor,
    send(command: Record<string, unknown>) {
      proc.stdin.write(`${JSON.stringify(command)}\n`)
      proc.stdin.flush()
    },
    /** 发一条命令并等它的 response */
    async call(command: Record<string, unknown>) {
      const id = `req-${++next}`
      this.send({ id, ...command })
      return waitFor((r) => r.type === 'response' && r.id === id)
    },
    async close() {
      proc.stdin.end()
      waiters = []
      return proc.exited
    },
  }
}

test.concurrent('rpc: prompt is accepted, events stream with the session id, state and messages are queryable', async () => {
  const rpc = startRpc(`faux:${scenario('hello')}`)

  expect(await rpc.call({ type: 'prompt', message: '你好' })).toMatchObject({
    command: 'prompt',
    success: true,
    data: { disposition: 'started' },
  })
  const settled = await rpc.waitFor((r) => r.type === 'agent_settled')
  const sessionId = settled.sessionId as string
  expect(rpc.records.find((r) => r.type === 'text_delta')).toMatchObject({
    sessionId,
  })

  const state = await rpc.call({ type: 'get_state' })
  expect(state.data).toMatchObject({
    sessionId,
    isStreaming: false,
    thinkingLevel: 'medium',
    messageCount: 2,
    pendingMessageCount: 0,
    steeringMode: 'one-at-a-time',
  })
  expect(
    await rpc.call({ type: 'set_session_name', name: '测试' }),
  ).toMatchObject({ success: true })
  const list = await rpc.call({ type: 'list_sessions' })
  expect((list.data as { sessions: unknown[] }).sessions).toEqual([
    expect.objectContaining({ id: sessionId, name: '测试', messageCount: 2 }),
  ])
  const messages = await rpc.call({ type: 'get_messages' })
  expect((messages.data as { messages: unknown[] }).messages).toHaveLength(2)

  // 解析失败、未知命令、参数错误：success false，进程继续
  rpc.send({ nope: true } as Record<string, unknown>)
  expect(await rpc.waitFor((r) => r.command === 'parse')).toMatchObject({
    success: false,
  })
  expect(await rpc.call({ type: 'wat' })).toMatchObject({
    success: false,
    error: '未知命令: wat',
  })
  expect(
    await rpc.call({ type: 'set_steering_mode', mode: 'some' }),
  ).toMatchObject({ success: false })

  // 新会话：后续事件带新的 id
  const created = await rpc.call({ type: 'new_session' })
  expect((created.data as { sessionId: string }).sessionId).not.toBe(sessionId)
  expect(await rpc.call({ type: 'switch_session', sessionId })).toMatchObject({
    success: true,
  })
  expect((await rpc.call({ type: 'get_state' })).data).toMatchObject({
    sessionId,
    messageCount: 2,
    sessionName: '测试',
  })

  expect(await rpc.close()).toBe(0)
})

test.concurrent('rpc: while running, prompt needs a streamingBehavior; queued messages can be cleared and abort waits', async () => {
  const rpc = startRpc(`faux:${scenario('hang')}`)

  await rpc.call({ type: 'prompt', message: '慢慢想' })
  await rpc.waitFor((r) => r.type === 'text_delta')

  expect(await rpc.call({ type: 'prompt', message: '插一句' })).toMatchObject({
    success: false,
  })
  expect(
    await rpc.call({
      type: 'prompt',
      message: '之后',
      streamingBehavior: 'followUp',
    }),
  ).toMatchObject({
    data: { disposition: 'queued' },
  })
  expect(await rpc.call({ type: 'steer', message: '改方向' })).toMatchObject({
    data: { disposition: 'queued' },
  })
  expect((await rpc.call({ type: 'get_state' })).data).toMatchObject({
    isStreaming: true,
    pendingMessageCount: 2,
  })
  expect(
    rpc.records.filter((r) => r.type === 'queue_update').at(-1),
  ).toMatchObject({
    steering: ['改方向'],
    followUp: ['之后'],
  })

  expect((await rpc.call({ type: 'clear_queue' })).data).toEqual({
    steering: ['改方向'],
    followUp: ['之后'],
  })
  expect(await rpc.call({ type: 'abort' })).toMatchObject({ success: true })
  // abort 的 response 在会话真正停下之后
  const abortIndex = rpc.records.findIndex((r) => r.command === 'abort')
  const settledIndex = rpc.records.findIndex((r) => r.type === 'agent_settled')
  expect(settledIndex).toBeGreaterThan(-1)
  expect(settledIndex).toBeLessThan(abortIndex)
  expect(rpc.records.find((r) => r.type === 'agent_end')).toMatchObject({
    reason: 'aborted',
  })

  expect(await rpc.close()).toBe(0)
})

test.concurrent('rpc: a prompt that fails before the loop starts gets a failed response', async () => {
  // 没有配置任何模型：prompt 先回 started，解析模型失败后再回一条 success:false（同 pi）
  const rpc = startRpc('')

  rpc.send({ id: 'p1', type: 'prompt', message: '你好' })
  expect(
    await rpc.waitFor((r) => r.id === 'p1' && r.success === true),
  ).toMatchObject({ data: { disposition: 'started' } })
  const failed = await rpc.waitFor((r) => r.id === 'p1' && r.success === false)
  expect(failed).toMatchObject({ type: 'response', command: 'prompt' })
  expect(String(failed.error)).not.toBe('')
  // loop 里的错误只在 agent_end 里报一次，不再重复回响应
  expect(rpc.records.some((r) => r.type === 'agent_start')).toBe(false)

  expect(await rpc.close()).toBe(0)
})

test.concurrent('rpc: extension ui dialogs round-trip through extension_ui_request / response', async () => {
  const rpc = startRpc(`faux:${scenario('hello')}`, [], {
    'extensions/ask.ts': `export default (vela) => vela.registerCommand('ask', {
  handler: async (_args, ctx) => {
    ctx.ui.setStatus('ask', '问一下')
    const ok = await ctx.ui.confirm('继续吗？', '要继续')
    const pick = await ctx.ui.select('选一个', ['甲', '乙'])
    ctx.ui.notify(\`ok=\${ok} pick=\${pick}\`)
  },
})`,
  })

  rpc.send({ id: 'cmd', type: 'prompt', message: '/ask' })
  const status = await rpc.waitFor((r) => r.method === 'setStatus')
  expect(status).toMatchObject({ statusKey: 'ask', statusText: '问一下' })
  const confirm = await rpc.waitFor((r) => r.method === 'confirm')
  expect(confirm).toMatchObject({
    type: 'extension_ui_request',
    title: '继续吗？',
    message: '要继续',
  })
  rpc.send({ type: 'extension_ui_response', id: confirm.id, confirmed: true })
  const select = await rpc.waitFor((r) => r.method === 'select')
  expect(select.options).toEqual(['甲', '乙'])
  rpc.send({ type: 'extension_ui_response', id: select.id, cancelled: true })
  expect(await rpc.waitFor((r) => r.method === 'notify')).toMatchObject({
    message: 'ok=true pick=undefined',
    notifyType: 'info',
  })
  expect(await rpc.waitFor((r) => r.id === 'cmd')).toMatchObject({
    data: { disposition: 'handled' },
  })

  expect(await rpc.close()).toBe(0)
})
