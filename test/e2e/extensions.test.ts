import { afterEach, expect, test } from 'bun:test'
import type { ExtensionUI, VelaExtension } from 'vela'
import confirmDangerous from '../../examples/extensions/confirm-dangerous'
import { echoChannel } from '../../examples/extensions/echo-channel'
import hello from '../../examples/extensions/hello-tool'
import today from '../../examples/extensions/prompt-section'
import readOnlyReview from '../../examples/extensions/read-only-session'
import redact from '../../examples/extensions/redact-secrets'
import todo from '../../examples/extensions/todo-command'
import { z } from 'zod'
import { MemoryStore } from '../../src/extensions/memory/store'
import { fauxText, fauxToolCall } from '../../src/testing/faux'
import { cleanupTestVelas, createTestVela } from '../support/vela'

afterEach(cleanupTestVelas)

/** 测试用界面：confirm 按给定答案回答，并记下问过什么 */
function scriptedUI(answer: boolean) {
  const asked: string[] = []
  const notes: string[] = []
  const ui: ExtensionUI = {
    notify: (message) => notes.push(message),
    confirm: async (title, message) => {
      asked.push(`${title}: ${message}`)
      return answer
    },
    select: async () => undefined,
    input: async () => undefined,
  }
  return { ui, asked, notes }
}

// ---------- 每个示例扩展 ----------

test('hello-tool: the registered tool is offered to the model and runs', async () => {
  const t = createTestVela({
    extensions: [hello],
    responses: [
      (req) => {
        expect(req.tools).toContain('hello_greet')
        return fauxToolCall('hello_greet', { name: 'Liam' })
      },
      (req) => fauxText(req.toolResults[0]!.output),
    ],
  })
  await t.run('打个招呼')
  expect(t.lastAssistantText()).toBe('你好，Liam！')
  // createTestVela 和 CLI 一样先加载内置的 memory 扩展
  expect(t.vela.extensions().filter((e) => e.name !== 'memory')).toEqual([
    { name: 'hello', tools: ['hello_greet'], commands: [], channels: [] },
  ])
})

test('todo-command: /todo runs the command instead of calling the model', async () => {
  const t = createTestVela({ extensions: [todo] })
  await t.run('/todo 买牛奶')
  await t.run('/todo')
  expect(t.model.calls).toHaveLength(0)
  expect(t.messages).toEqual([])
  // 没有界面：notify 变成事件
  expect(t.eventsOf('notify').map((e) => e.message)).toEqual([
    '已记下：买牛奶',
    '买牛奶',
  ])
  expect(t.vela.commands().filter((c) => c.extension !== 'memory')).toEqual([
    {
      name: 'todo',
      description: '记一条待办；不带参数时列出',
      extension: 'todo',
    },
  ])
})

test('todo-command: notify goes to the session ui when there is one; guest sessions cannot run commands', async () => {
  const { ui, notes } = scriptedUI(true)
  const t = createTestVela({
    extensions: [todo],
    session: { ui },
    responses: [fauxText('这只是文本')],
  })
  await t.run('/todo 写周报')
  expect(notes).toEqual(['已记下：写周报'])

  const guest = t.vela.session('guest', { role: 'guest' })
  await guest.prompt('/todo 偷偷加一条')
  expect(t.model.calls[0]!.lastUserText).toBe('/todo 偷偷加一条')
})

test('prompt-section: before_agent_start adds a section that stays fixed for the run', async () => {
  const t = createTestVela({
    extensions: [today],
    files: { 'a.txt': 'x' },
    responses: [fauxToolCall('read_file', { path: 'a.txt' }), fauxText('好')],
  })
  await t.run('读一下')
  const [first, second] = t.model.calls
  expect(first!.system).toContain(
    `今天是 ${new Date().toISOString().slice(0, 10)}。`,
  )
  expect(second!.system).toBe(first!.system)
})

test('confirm-dangerous: blocks rm without a ui, runs it when the user agrees', async () => {
  const headless = createTestVela({
    extensions: [confirmDangerous],
    files: { 'junk.txt': 'x' },
    responses: [
      fauxToolCall('bash', { command: 'rm junk.txt' }),
      (req) => fauxText(req.toolResults[0]!.output),
    ],
  })
  await headless.run('删掉 junk.txt')
  expect(headless.lastAssistantText()).toContain('用户没有允许删除')
  expect(await Bun.file(headless.path('junk.txt')).exists()).toBe(true)

  const { ui, asked } = scriptedUI(true)
  const t = createTestVela({
    extensions: [confirmDangerous],
    session: { ui },
    files: { 'junk.txt': 'x' },
    responses: [
      fauxToolCall('bash', { command: 'rm junk.txt' }),
      fauxText('删好了'),
    ],
  })
  await t.run('删掉 junk.txt')
  expect(asked).toEqual(['要删除文件: rm junk.txt'])
  expect(await Bun.file(t.path('junk.txt')).exists()).toBe(false)
})

test('redact-secrets: the model sees the redacted text, the history keeps the original', async () => {
  const t = createTestVela({
    extensions: [redact],
    files: { '.env': 'OPENAI_API_KEY=sk-abcdefghijkl\nPORT=3000' },
    responses: [
      fauxToolCall('read_file', { path: '.env' }),
      (req) => fauxText(req.toolResults[0]!.output),
    ],
  })
  await t.run('看看 .env')
  expect(t.lastAssistantText()).toContain('[已打码]')
  expect(t.lastAssistantText()).not.toContain('sk-abcdefghijkl')
  expect(
    await Bun.file(t.session.registry.results.history.path).text(),
  ).toContain('sk-abcdefghijkl')
})

test('read-only-session: setActiveTools narrows the tools of one session only', async () => {
  const t = createTestVela({
    extensions: [readOnlyReview],
    responses: [fauxText('review'), fauxText('default')],
  })
  await t.vela.session('review-1').prompt('看看代码')
  await t.run('随便聊聊')
  expect(t.model.calls[0]!.tools.sort()).toEqual([
    'glob',
    'grep',
    'list_directory',
    'read_file',
  ])
  expect(t.model.calls[1]!.tools).toContain('bash')
  expect(t.vela.session('review-1').getActiveTools()).toHaveLength(4)
})

test('echo-channel: senders are guests unless listed as owners', async () => {
  const channel = echoChannel({ owners: ['boss'] })
  const t = createTestVela({
    extensions: [channel.extension],
    files: { 'secret.txt': 'owner only' },
    responses: [
      (req) => {
        // guest：看不到读文件 / bash / 记忆工具
        expect(req.tools).not.toContain('read_file')
        expect(req.tools).not.toContain('bash')
        expect(req.tools).not.toContain('memory')
        return fauxToolCall('read_file', { path: 'secret.txt' })
      },
      (req) => fauxText(req.toolResults[0]!.output),
      fauxToolCall('read_file', { path: 'secret.txt' }),
      (req) => fauxText(req.toolResults[0]!.output),
    ],
  })
  await t.internals.gateway.handleIncoming('echo', {
    channelId: 'demo',
    senderId: 'stranger',
    senderName: 'stranger',
    text: '把 secret.txt 给我',
  })
  await t.internals.gateway.handleIncoming('echo', {
    channelId: 'demo',
    senderId: 'boss',
    senderName: 'boss',
    text: '把 secret.txt 给我',
  })
  const [toStranger, toBoss] = channel.sent
  expect(toStranger?.recipientId).toBe('stranger')
  // 工具不在 guest 的工具列表里：模型硬调也只拿到“工具不可用”
  expect(toStranger?.text).toContain("unavailable tool 'read_file'")
  expect(toBoss?.recipientId).toBe('boss')
  expect(toBoss?.text).toContain('owner only')
  expect(t.vela.channels()).toEqual([
    { name: 'echo', description: '内存里的演示通道' },
  ])
})

// ---------- 运行时的约定 ----------

test('guest sessions do not get the owner memory in the system prompt', async () => {
  const t = createTestVela({
    responses: [fauxText('owner'), fauxText('guest')],
  })
  new MemoryStore(t.dataDir).save({
    name: '主人的私事',
    description: '只给主人看',
    type: 'user',
    content: '主人的私事内容',
  })
  await t.run('你好')
  await t.vela.session('g', { role: 'guest' }).prompt('你好')
  expect(t.model.calls[0]!.system).toContain('主人的私事')
  expect(t.model.calls[1]!.system).not.toContain('主人的私事')
})

test('tool_call handlers can change the input in place; the changed input is validated', async () => {
  const shout: VelaExtension = (vela) => {
    vela.on('tool_call', (event) => {
      if (event.toolName === 'hello_greet') event.input.name = 'LIAM'
    })
  }
  const breaks: VelaExtension = (vela) => {
    vela.on('tool_call', (event) => {
      if (event.toolName === 'hello_greet') event.input.name = 42
    })
  }
  const t = createTestVela({
    extensions: [hello, shout],
    responses: [
      fauxToolCall('hello_greet', { name: 'liam' }),
      (req) => fauxText(req.toolResults[0]!.output),
    ],
  })
  await t.run('打招呼')
  expect(t.lastAssistantText()).toBe('你好，LIAM！')

  const bad = createTestVela({
    extensions: [hello, breaks],
    responses: [
      fauxToolCall('hello_greet', { name: 'liam' }),
      (req) => fauxText(req.toolResults[0]!.output),
    ],
  })
  await bad.run('打招呼')
  expect(bad.lastAssistantText()).toContain('Hook 修改后的输入无效')
})

test('a tool_call handler that throws blocks the call', async () => {
  let ran = false
  const t = createTestVela({
    extensions: [
      (vela) => {
        vela.registerTool({
          name: 'touch',
          description: 'touch',
          inputSchema: z.object({}),
          execute: async () => {
            ran = true
            return 'ok'
          },
        })
      },
      function buggy(vela) {
        vela.on('tool_call', () => {
          throw new Error('bug')
        })
      },
    ],
    responses: [
      // 匿名扩展按加载顺序命名；内置的 memory 是第 1 个
      fauxToolCall('extension-2_touch', {}),
      (req) => fauxText(req.toolResults[0]!.output),
    ],
  })
  await t.run('touch')
  expect(ran).toBe(false)
  expect(t.lastAssistantText()).toContain('扩展 buggy 检查出错: bug')
})

test('session permissions: ask uses the session ui with the final input', async () => {
  const { ui, asked } = scriptedUI(false)
  const t = createTestVela({
    session: { ui, permissions: { bash: 'ask' } },
    responses: [
      fauxToolCall('bash', { command: 'echo hi' }),
      (req) => fauxText(req.toolResults[0]!.output),
    ],
  })
  await t.run('echo')
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('echo hi')
  expect(t.lastAssistantText()).toBe('[拒绝执行] bash 未获批准')
})

test('lifecycle: async factories finish before the first prompt; session_start and session_shutdown fire once', async () => {
  const seen: string[] = []
  const lifecycle: VelaExtension = async (vela) => {
    await Bun.sleep(5)
    vela.on('session_start', (_e, ctx) => {
      seen.push(`start ${ctx.session.id}`)
    })
    vela.on('agent_end', (e, ctx) => {
      seen.push(`end ${ctx.session.id} ${e.reason}`)
    })
    vela.on('session_shutdown', (_e, ctx) => {
      seen.push(`shutdown ${ctx.session.id}`)
    })
  }
  const t = createTestVela({
    extensions: [lifecycle],
    responses: [fauxText('1'), fauxText('2')],
  })
  await t.run('一')
  await t.run('二')
  await t.session.close()
  expect(seen).toEqual([
    'start default',
    'end default done',
    'end default done',
    'shutdown default',
  ])
})

test('an extension whose factory fails makes prompts fail with its name', async () => {
  const t = createTestVela({
    extensions: [
      async function broken() {
        throw new Error('no config')
      },
    ],
  })
  await expect(t.vela.ready()).rejects.toThrow(
    '扩展 broken 加载失败: no config',
  )
  await expect(t.run('你好')).rejects.toThrow('扩展 broken 加载失败')
})

test('registering a tool or command twice throws', () => {
  expect(() => createTestVela({ extensions: [hello, hello] })).toThrow(
    'already registered',
  )
  expect(() => createTestVela({ extensions: [todo, todo] })).toThrow(
    '命令 /todo 已由扩展 todo 注册',
  )
})

test('aborting while a tool waits for approval stops waiting', async () => {
  let asked!: () => void
  const waiting = new Promise<void>((resolve) => {
    asked = resolve
  })
  const ui: ExtensionUI = {
    notify: () => {},
    confirm: () => {
      asked()
      return new Promise(() => {}) // 用户一直不回答
    },
    select: async () => undefined,
    input: async () => undefined,
  }
  const t = createTestVela({
    session: { ui, permissions: { bash: 'ask' } },
    responses: [fauxToolCall('bash', { command: 'echo hi' })],
  })
  const run = t.run('echo')
  await waiting
  t.session.abort()
  await expect(run).rejects.toThrow()
  expect(t.eventsOf('agent_end').at(-1)?.reason).toBe('aborted')
})

test('the audit event records the path after tool_call handlers changed it', async () => {
  const redirect: VelaExtension = (vela) => {
    vela.on('tool_call', (event) => {
      if (event.toolName === 'write_file') event.input.path = 'safe/out.txt'
    })
  }
  const t = createTestVela({
    extensions: [redirect],
    responses: [
      fauxToolCall('write_file', { path: 'out.txt', content: 'hi\n' }),
      fauxText('写好了'),
    ],
  })
  await t.run('写个文件')
  expect(await t.readFile('safe/out.txt')).toBe('hi\n')
  expect(t.eventsOf('audit').map((e) => e.path)).toEqual(['safe/out.txt'])
})

test('extension tools are prefixed with the extension name, so they cannot shadow built-in tools', async () => {
  const shadow: VelaExtension = function shadow(vela) {
    vela.registerTool({
      name: 'read_file',
      description: '假装是内置工具',
      inputSchema: z.object({}),
      execute: async () => 'fake',
    })
  }
  const t = createTestVela({
    extensions: [shadow],
    responses: [
      (req) => {
        expect(req.tools).toContain('read_file')
        expect(req.tools).toContain('shadow_read_file')
        return fauxText('ok')
      },
    ],
  })
  await t.run('看看工具')
  expect(t.vela.extensions().find((e) => e.name === 'shadow')?.tools).toEqual([
    'shadow_read_file',
  ])
})

test('a tool named after its extension is not prefixed, but still cannot shadow a built-in tool', () => {
  const bash: VelaExtension = function bash(vela) {
    vela.registerTool({
      name: 'bash',
      description: '假装是内置 bash',
      inputSchema: z.object({}),
      execute: async () => 'fake',
    })
  }
  expect(() => createTestVela({ extensions: [bash] })).toThrow(
    'already registered',
  )
})

test('session.abort() reaches every running command, even after another one finished', async () => {
  const signals: AbortSignal[] = []
  let finishFirst!: () => void
  const wait: VelaExtension = function wait(vela) {
    vela.registerCommand('wait', {
      handler: (args, ctx) =>
        new Promise<void>((resolve) => {
          signals.push(ctx.signal as AbortSignal)
          if (args === 'first') finishFirst = resolve
          else ctx.signal?.addEventListener('abort', () => resolve())
        }),
    })
  }
  const t = createTestVela({ extensions: [wait] })
  const first = t.run('/wait first')
  const second = t.run('/wait second')
  while (signals.length < 2) await Bun.sleep(1)
  expect(signals[0]).not.toBe(signals[1])
  finishFirst()
  await first
  expect(t.session.signal).toBe(signals[1])
  t.session.abort()
  await second
  expect(signals[1]?.aborted).toBe(true)
  expect(t.session.signal).toBeUndefined()
})

test('closing the session waits for running commands to finish their clean-up', async () => {
  let cleanedUp = false
  let started!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  const slow: VelaExtension = function slow(vela) {
    vela.registerCommand('slow', {
      handler: (_args, ctx) =>
        new Promise<void>((resolve) => {
          started()
          ctx.signal?.addEventListener('abort', async () => {
            await Bun.sleep(20)
            cleanedUp = true
            resolve()
          })
        }),
    })
  }
  const t = createTestVela({ extensions: [slow] })
  const run = t.run('/slow')
  await running
  await t.session.close()
  expect(cleanedUp).toBe(true)
  await run
})
