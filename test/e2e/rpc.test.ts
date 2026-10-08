import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tempDir } from '../support/vela.ts'

// `vela --mode rpc` child process: write JSONL commands to stdin, read responses / events / extension_ui_request from stdout

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
    /** Send a command and wait for its response */
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

  expect(await rpc.call({ type: 'prompt', message: 'Hello' })).toMatchObject({
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
    await rpc.call({ type: 'set_session_name', name: 'Test' }),
  ).toMatchObject({ success: true })
  const list = await rpc.call({ type: 'list_sessions' })
  expect((list.data as { sessions: unknown[] }).sessions).toEqual([
    expect.objectContaining({ id: sessionId, name: 'Test', messageCount: 2 }),
  ])
  const messages = await rpc.call({ type: 'get_messages' })
  expect((messages.data as { messages: unknown[] }).messages).toHaveLength(2)

  // Parse errors, unknown commands, bad arguments: success false, the process keeps going
  rpc.send({ nope: true } as Record<string, unknown>)
  expect(await rpc.waitFor((r) => r.command === 'parse')).toMatchObject({
    success: false,
  })
  expect(await rpc.call({ type: 'wat' })).toMatchObject({
    success: false,
    error: 'Unknown command: wat',
  })
  expect(
    await rpc.call({ type: 'set_steering_mode', mode: 'some' }),
  ).toMatchObject({ success: false })

  // New session: later events carry the new id
  const created = await rpc.call({ type: 'new_session' })
  expect((created.data as { sessionId: string }).sessionId).not.toBe(sessionId)
  expect(await rpc.call({ type: 'switch_session', sessionId })).toMatchObject({
    success: true,
  })
  expect((await rpc.call({ type: 'get_state' })).data).toMatchObject({
    sessionId,
    messageCount: 2,
    sessionName: 'Test',
  })

  expect(await rpc.close()).toBe(0)
})

test.concurrent('rpc: while running, prompt needs a streamingBehavior; queued messages can be cleared and abort waits', async () => {
  const rpc = startRpc(`faux:${scenario('hang')}`)

  await rpc.call({ type: 'prompt', message: 'Think slowly' })
  await rpc.waitFor((r) => r.type === 'text_delta')

  expect(await rpc.call({ type: 'prompt', message: 'Interject' })).toMatchObject({
    success: false,
  })
  expect(
    await rpc.call({
      type: 'prompt',
      message: 'Later',
      streamingBehavior: 'followUp',
    }),
  ).toMatchObject({
    data: { disposition: 'queued' },
  })
  expect(await rpc.call({ type: 'steer', message: 'Change course' })).toMatchObject({
    data: { disposition: 'queued' },
  })
  expect((await rpc.call({ type: 'get_state' })).data).toMatchObject({
    isStreaming: true,
    pendingMessageCount: 2,
  })
  expect(
    rpc.records.filter((r) => r.type === 'queue_update').at(-1),
  ).toMatchObject({
    steering: ['Change course'],
    followUp: ['Later'],
  })

  // Renaming while running: not saved separately (it would interleave with the loop's writes); saved when this run ends
  expect(
    await rpc.call({ type: 'set_session_name', name: 'Renamed while running' }),
  ).toMatchObject({ success: true })

  expect((await rpc.call({ type: 'clear_queue' })).data).toEqual({
    steering: ['Change course'],
    followUp: ['Later'],
  })
  expect(await rpc.call({ type: 'abort' })).toMatchObject({ success: true })
  // The abort response comes after the session has really stopped
  const abortIndex = rpc.records.findIndex((r) => r.command === 'abort')
  const settledIndex = rpc.records.findIndex((r) => r.type === 'agent_settled')
  expect(settledIndex).toBeGreaterThan(-1)
  expect(settledIndex).toBeLessThan(abortIndex)
  expect(rpc.records.find((r) => r.type === 'agent_end')).toMatchObject({
    reason: 'aborted',
  })
  const list = await rpc.call({ type: 'list_sessions' })
  expect((list.data as { sessions: unknown[] }).sessions).toEqual([
    expect.objectContaining({ name: 'Renamed while running', firstMessage: 'Think slowly' }),
  ])

  expect(await rpc.close()).toBe(0)
})

test.concurrent('rpc: a prompt that fails before the loop starts gets a failed response', async () => {
  // No model configured: prompt first answers started, then success:false once resolving the model fails (as in pi)
  const rpc = startRpc('')

  rpc.send({ id: 'p1', type: 'prompt', message: 'Hello' })
  expect(
    await rpc.waitFor((r) => r.id === 'p1' && r.success === true),
  ).toMatchObject({ data: { disposition: 'started' } })
  const failed = await rpc.waitFor((r) => r.id === 'p1' && r.success === false)
  expect(failed).toMatchObject({ type: 'response', command: 'prompt' })
  expect(String(failed.error)).not.toBe('')
  // Errors inside the loop are reported once in agent_end, not repeated as a response
  expect(rpc.records.some((r) => r.type === 'agent_start')).toBe(false)

  expect(await rpc.close()).toBe(0)
})

test.concurrent('rpc: extension ui dialogs round-trip through extension_ui_request / response', async () => {
  const rpc = startRpc(`faux:${scenario('hello')}`, [], {
    'extensions/ask.ts': `export default (vela) => vela.registerCommand('ask', {
  handler: async (_args, ctx) => {
    ctx.ui.setStatus('ask', 'Asking')
    const ok = await ctx.ui.confirm('Continue?', 'Keep going')
    const pick = await ctx.ui.select('Pick one', ['A', 'B'])
    ctx.ui.notify(\`ok=\${ok} pick=\${pick}\`)
  },
})`,
  })

  rpc.send({ id: 'cmd', type: 'prompt', message: '/ask' })
  const status = await rpc.waitFor((r) => r.method === 'setStatus')
  expect(status).toMatchObject({ statusKey: 'ask', statusText: 'Asking' })
  const confirm = await rpc.waitFor((r) => r.method === 'confirm')
  expect(confirm).toMatchObject({
    type: 'extension_ui_request',
    title: 'Continue?',
    message: 'Keep going',
  })
  rpc.send({ type: 'extension_ui_response', id: confirm.id, confirmed: true })
  const select = await rpc.waitFor((r) => r.method === 'select')
  expect(select.options).toEqual(['A', 'B'])
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
