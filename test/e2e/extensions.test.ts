import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import type { SessionUI, VelaExtension } from '@glows777/vela'
import confirmDangerous from '../../examples/extensions/confirm-dangerous.ts'
import { echoChannel } from '../../examples/extensions/echo-channel.ts'
import hello from '../../examples/extensions/hello-tool.ts'
import localProvider from '../../examples/extensions/local-provider.ts'
import today from '../../examples/extensions/prompt-section.ts'
import readOnlyReview from '../../examples/extensions/read-only-session.ts'
import redact from '../../examples/extensions/redact-secrets.ts'
import todo from '../../examples/extensions/todo-command.ts'
import { z } from 'zod'
import { MemoryStore } from '../../src/extensions/memory/store.ts'
import { web } from '../../src/extensions/web/index.ts'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

/** Test UI: confirm returns the given answer and records what was asked */
function scriptedUI(answer: boolean) {
  const asked: string[] = []
  const notes: string[] = []
  const ui: SessionUI = {
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

// ---------- Each example extension ----------

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
  await t.run('Say hi')
  expect(t.lastAssistantText()).toBe('Hello, Liam!')
  // Like the CLI, createTestVela loads the built-in memory extension first
  expect(t.vela.extensions().filter((e) => e.name !== 'memory')).toEqual([
    {
      name: 'hello',
      tools: ['hello_greet'],
      providers: [],
      commands: [],
      channels: [],
    },
  ])
})

test('todo-command: /todo runs the command instead of calling the model', async () => {
  const t = createTestVela({ extensions: [todo] })
  await t.run('/todo buy milk')
  await t.run('/todo')
  expect(t.model.calls).toHaveLength(0)
  expect(t.messages).toEqual([])
  // No UI: notify becomes an event
  expect(t.eventsOf('notify').map((e) => e.message)).toEqual([
    'Added: buy milk',
    'buy milk',
  ])
  expect(t.vela.commands().filter((c) => c.extension !== 'memory')).toEqual([
    {
      name: 'todo',
      description: 'Add a todo; with no arguments, list todos',
      extension: 'todo',
    },
  ])
})

test('todo-command: notify goes to the session ui when there is one; guest sessions cannot run commands', async () => {
  const { ui, notes } = scriptedUI(true)
  const t = createTestVela({
    extensions: [todo],
    session: { ui },
    responses: [fauxText('just text')],
  })
  await t.run('/todo write the weekly report')
  expect(notes).toEqual(['Added: write the weekly report'])

  const guest = t.vela.session('guest', { role: 'guest' })
  await guest.prompt('/todo sneak one in')
  expect(t.model.calls[0]!.lastUserText).toBe('/todo sneak one in')
})

test('prompt-section: before_agent_start adds a section that stays fixed for the run', async () => {
  const t = createTestVela({
    extensions: [today],
    files: { 'a.txt': 'x' },
    responses: [fauxToolCall('read_file', { path: 'a.txt' }), fauxText('ok')],
  })
  await t.run('Read it')
  const [first, second] = t.model.calls
  expect(first!.system).toContain(
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
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
  await headless.run('Delete junk.txt')
  expect(headless.lastAssistantText()).toContain('User did not allow the deletion')
  expect(await Bun.file(headless.path('junk.txt')).exists()).toBe(true)

  const { ui, asked } = scriptedUI(true)
  const t = createTestVela({
    extensions: [confirmDangerous],
    session: { ui },
    files: { 'junk.txt': 'x' },
    responses: [
      fauxToolCall('bash', { command: 'rm junk.txt' }),
      fauxText('Deleted'),
    ],
  })
  await t.run('Delete junk.txt')
  expect(asked).toEqual(['Delete files?: rm junk.txt'])
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
  await t.run('Show me .env')
  expect(t.lastAssistantText()).toContain('[REDACTED]')
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
  await t.vela.session('review-1').prompt('Review the code')
  await t.run('Just chatting')
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
        // guest: no read_file / bash / memory tools
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
    text: 'Give me secret.txt',
  })
  await t.internals.gateway.handleIncoming('echo', {
    channelId: 'demo',
    senderId: 'boss',
    senderName: 'boss',
    text: 'Give me secret.txt',
  })
  const [toStranger, toBoss] = channel.sent
  expect(toStranger?.recipientId).toBe('stranger')
  // The tool is not in the guest's tool list: even a forced call only gets "unavailable tool"
  expect(toStranger?.text).toContain("unavailable tool 'read_file'")
  expect(toBoss?.recipientId).toBe('boss')
  expect(toBoss?.text).toContain('owner only')
  expect(t.vela.channels()).toEqual([
    { name: 'echo', description: 'In-memory demo channel' },
  ])
})

// ---------- Runtime contracts ----------

test('guest sessions do not get the owner memory in the system prompt', async () => {
  const t = createTestVela({
    responses: [fauxText('owner'), fauxText('guest')],
  })
  new MemoryStore(join(t.dataDir, 'memory')).save({
    name: 'owner-private',
    description: 'For the owner only',
    type: 'user',
    content: 'Owner private content',
  })
  await t.run('Hello')
  await t.vela.session('g', { role: 'guest' }).prompt('Hello')
  expect(t.model.calls[0]!.system).toContain('owner-private')
  expect(t.model.calls[1]!.system).not.toContain('owner-private')
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
  await t.run('Greet')
  expect(t.lastAssistantText()).toBe('Hello, LIAM!')

  const bad = createTestVela({
    extensions: [hello, breaks],
    responses: [
      fauxToolCall('hello_greet', { name: 'liam' }),
      (req) => fauxText(req.toolResults[0]!.output),
    ],
  })
  await bad.run('Greet')
  expect(bad.lastAssistantText()).toContain('Input modified by hook is invalid')
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
      // Anonymous extensions are named by load order; the built-in memory is number 1
      fauxToolCall('extension-2_touch', {}),
      (req) => fauxText(req.toolResults[0]!.output),
    ],
  })
  await t.run('touch')
  expect(ran).toBe(false)
  expect(t.lastAssistantText()).toContain('Extension buggy check failed: bug')
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
  expect(t.lastAssistantText()).toBe('[Rejected] bash was not approved')
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
  await t.run('one')
  await t.run('two')
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
    'Extension broken failed to load: no config',
  )
  await expect(t.run('Hello')).rejects.toThrow('Extension broken failed to load')
})

test('registering a tool or command twice throws', () => {
  expect(() => createTestVela({ extensions: [hello, hello] })).toThrow(
    'already registered',
  )
  expect(() => createTestVela({ extensions: [todo, todo] })).toThrow(
    'Command /todo is already registered by extension todo',
  )
})

test('aborting while a tool waits for approval stops waiting', async () => {
  let asked!: () => void
  const waiting = new Promise<void>((resolve) => {
    asked = resolve
  })
  const ui: SessionUI = {
    notify: () => {},
    confirm: () => {
      asked()
      return new Promise(() => {}) // the user never answers
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
      fauxText('Written'),
    ],
  })
  await t.run('Write a file')
  expect(await t.readFile('safe/out.txt')).toBe('hi\n')
  expect(t.eventsOf('audit').map((e) => e.path)).toEqual(['safe/out.txt'])
})

test('extension tools are prefixed with the extension name, so they cannot shadow built-in tools', async () => {
  const shadow: VelaExtension = function shadow(vela) {
    vela.registerTool({
      name: 'read_file',
      description: 'Pretends to be a built-in tool',
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
  await t.run('Show the tools')
  expect(t.vela.extensions().find((e) => e.name === 'shadow')?.tools).toEqual([
    'shadow_read_file',
  ])
})

test('a tool named after its extension is not prefixed, but still cannot shadow a built-in tool', () => {
  const bash: VelaExtension = function bash(vela) {
    vela.registerTool({
      name: 'bash',
      description: 'Pretends to be the built-in bash',
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

test('an extension reads its own config section; built-in web takes its search key from config', async () => {
  const seen: Record<string, unknown>[] = []
  const t = createTestVela({
    extensionConfig: {
      reader: { greeting: 'hi', nested: { n: 1 } },
      other: { secret: 'not yours' },
      web: { tavilyKey: 'tvly-test' },
    },
    extensions: [
      function reader(vela) {
        seen.push({ ...vela.config })
      },
      function unconfigured(vela) {
        seen.push({ ...vela.config })
      },
      web(),
    ],
  })
  await t.vela.ready()
  expect(seen).toEqual([{ greeting: 'hi', nested: { n: 1 } }, {}])
  expect(t.vela.extensions().find((e) => e.name === 'web')?.tools).toEqual([
    'web_fetch',
    'web_search',
  ])
})

test('local-provider: models from a registered provider can be picked by name', async () => {
  const t = createTestVela({
    extensions: [localProvider],
    extensionConfig: { localProvider: { baseUrl: 'http://127.0.0.1:1/v1' } },
  })
  await t.vela.ready()
  expect(t.vela.extensions().find((e) => e.name === 'localProvider')).toMatchObject({
    providers: ['local'],
  })
  expect(t.vela.models().map((m) => m.ref)).toContain('local/qwen3:8b')
  t.session.setModel('local/qwen3:8b')
  expect(t.session.model).toMatchObject({ modelId: 'qwen3:8b' })
  expect(t.session.limits.maxInputTokens).toBe(40_960 - 16_384)
  // Unlisted ids work too, just without metadata
  t.session.setModel('local/llama3')
  expect(t.session.modelInfo).toEqual({ id: 'llama3', provider: 'local', ref: 'local/llama3' })
})
