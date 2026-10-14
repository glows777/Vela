import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { z } from 'zod'
import type {
  IncomingMessage,
  OutgoingMessage,
} from '../../src/channels/types.ts'
import { createCliDispatcher } from '../../src/cli/dispatcher.ts'
import type { VelaExtension } from '../../src/extensions/types.ts'
import type { ProviderDefinition } from '../../src/models/index.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux.ts'
import { startTui, stopTuis } from '../support/terminal.ts'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

test('/status reports the session, model and context usage', async () => {
  const t = createTestVela({
    responses: [fauxText('ok', { usage: { input: 1000, output: 20 } })],
  })
  t.session.setName('refactor')
  await t.run('hi')

  const { output } = await captureConsole(() => {
    expect(t.dispatch('/status')).toBe(true)
    expect(t.dispatch('/status extra')).toBe(false)
  })
  const plain = stripTerminalSequences(output)
  expect(plain).toContain('[status]')
  expect(plain).toContain(`Session: refactor (${t.session.id})`)
  expect(plain).toContain(
    `Path: ${join(t.vela.dataDir, 'sessions', `${t.session.id}.jsonl`)}`,
  )
  expect(plain).toContain(`Cwd: ${t.vela.cwd}`)
  expect(plain).toContain(`Model: ${t.session.modelInfo.ref}`)
  expect(plain).toContain(`Thinking: ${t.session.thinkingLevel}`)
  expect(plain).toContain('Role: owner')
  expect(plain).toContain('Messages: 2')
  expect(plain).toMatch(
    new RegExp(`Context: .+ tokens \\(${t.session.usage.percent}% of .+\\)`),
  )
  expect(plain).toMatch(/Usage: ↑1\.0k ↓20 \(1 step\)/)
  expect(plain).not.toMatch(/Usage:.*\$/)
})

test('/status on a fresh session shows identity and omits usage totals', async () => {
  const t = createTestVela({ thinkingLevel: 'low' })
  t.session.channel = 'feishu'
  const { output } = await captureConsole(() => {
    expect(t.dispatch('/status')).toBe(true)
  })
  expect(output).toContain(`Session: ${t.session.id}\n`)
  expect(output).toContain('Thinking: low')
  expect(output).toContain('Role: owner')
  expect(output).toContain('Channel: feishu')
  expect(output).toContain('Messages: 0')
  expect(output).toContain('Context:')
  expect(output).not.toContain('Usage:')
  expect(output).not.toContain('Forked from:')
})

test('/status names a forked session and includes the cost of a priced model', async () => {
  const faux = createFauxModel({
    modelId: 'priced',
    responses: [fauxText('ok', { usage: { input: 1_000_000, output: 1000 } })],
  })
  const provider: ProviderDefinition = {
    models: [
      {
        id: 'priced',
        contextWindow: 200_000,
        cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      },
    ],
    createModel: () => faux,
  }
  const t = createTestVela({
    model: 'fake/priced',
    providers: { fake: provider },
  })
  await t.run('hi')
  const user = t.session
    .getEntries()
    .find((entry) => entry.type === 'message' && entry.message.role === 'user')
  if (!user) throw new Error('missing user entry')
  const forked = (await t.session.fork(user.id, { sessionId: 'copy' })).session
  if (!forked) throw new Error('fork failed')

  const { output } = await captureConsole(() => {
    expect(t.dispatch('/status')).toBe(true)
    expect(
      createCliDispatcher(t.vela)('/status', { ...t.ctx, session: forked }),
    ).toBe(true)
  })
  expect(output).toContain('Model: fake/priced')
  expect(output).toContain('Usage: ↑1.0M ↓1.0k $1.0050 (1 step)')
  expect(output).toContain('Session: copy')
  expect(output).toContain('Forked from: default')
  expect(output).toContain(`(${t.session.usage.percent}% of 200.0k)`)
})

test('/status reports an unavailable model instead of failing', async () => {
  const t = createTestVela({ model: 'missing/nope', providers: {} })
  const { output } = await captureConsole(() => {
    expect(t.dispatch('/status')).toBe(true)
  })
  expect(output).toContain(
    'Model: (unavailable: No provider named missing (available: none))',
  )
  expect(output).toContain('Context:')
  expect(output).toContain('Thinking:')
})

test('in the TUI, /status prints the session overview into the chat', async () => {
  const t = createTestVela({
    responses: [fauxText('ok', { usage: { input: 1000, output: 20 } })],
  })
  await t.run('hi')
  const tui = await startTui(t.vela, { sessionId: t.session.id })
  try {
    await tui.started
    tui.submit('/status')
    await tui.until('[status]')
    const screen = tui.screen()
    expect(screen).toContain(`Session: ${t.session.id}`)
    expect(screen).toContain('Model: faux/faux')
    expect(screen).toContain('Context:')
    expect(screen).toContain('Usage:')
    expect(screen).toContain('1 step')
  } finally {
    await stopTuis()
  }
})

test('/context and /usage report the conversation after a run', async () => {
  const t = createTestVela({
    responses: [fauxText('ok', { usage: { input: 1234, output: 56 } })],
  })
  await t.run('hi')

  const { output } = await captureConsole(async () => {
    expect(await t.command('/context')).toBe(true)
    expect(t.dispatch('/usage')).toBe(true)
  })
  expect(output).toContain('System prompt')
  expect(output).toContain('Usage Summary')
  expect(output).toContain('1 step total')
  expect(output).toMatch(/Input\s+1\.2k tokens/)
})

test('text without a leading / is never a command: the CLI dispatcher leaves it for the model', () => {
  const t = createTestVela()
  for (const text of [
    'status',
    'context',
    'usage',
    'sim',
    'defend',
    'cache on',
    'cache off',
    'skill list',
    'exit',
  ])
    expect(t.dispatch(text)).toBe(false)
})

test('in the TUI, bare words like exit and status are sent to the model', async () => {
  const t = createTestVela({
    responses: [fauxText('Not leaving'), fauxText('All good')],
  })
  const tui = await startTui(t.vela)
  try {
    await tui.started
    tui.submit('exit')
    await tui.until('Not leaving')
    tui.submit('status')
    await tui.until('All good')
    expect(tui.exited()).toBe(false)
    expect(t.model.calls.map((c) => c.lastUserText)).toEqual(['exit', 'status'])
  } finally {
    await stopTuis()
  }
})

test('/context counts the skills index and shows the real summary threshold as the autocompact buffer', async () => {
  const t = createTestVela({
    skills: [
      {
        name: 'deploy',
        description: 'Ship the app to production'.repeat(20),
        body: 'steps',
      },
    ],
    limits: { summaryThreshold: 100_000 },
  })
  const window =
    t.session.modelInfo.contextWindow ?? t.session.tracker.contextWindow
  const { output } = await captureConsole(() => t.command('/context'))
  const plain = stripTerminalSequences(output)
  // The skills index sits in the system prompt; it used to be reported as 0 (and the row hidden)
  expect(plain).toMatch(/◉ Skills: \d+ tokens/)
  // The buffer is the window above the summary threshold, not a fixed 5% of the window
  const buffer = window - 100_000
  expect(plain).toContain(
    `Autocompact buffer: ${(buffer / 1000).toFixed(1)}k (${((buffer / window) * 100).toFixed(1)}%)`,
  )
})

test('an extension registers tools the model can call, listed by /extensions', async () => {
  const db: VelaExtension = function db(vela) {
    vela.registerTool({
      name: 'list_tables',
      description: 'List the tables',
      inputSchema: z.object({}),
      execute: async () => 'users, posts',
    })
  }
  const t = createTestVela({
    extensions: [db],
    responses: [
      (req) => {
        expect(req.tools).toContain('db_list_tables')
        return fauxToolCall('db_list_tables', {})
      },
      (req) =>
        fauxText(
          req.toolResults[0]!.output.includes('users')
            ? 'There is a users table'
            : '?',
        ),
    ],
  })

  await t.run('Which tables are there?')
  expect(t.lastAssistantText()).toBe('There is a users table')

  const { output } = await captureConsole(() => t.dispatch('/extensions'))
  expect(output).toContain('db')
  expect(output).toContain('db_list_tables')
})

test('a message from a channel runs through the same model and tools, and the reply is sent back', async () => {
  const sent: OutgoingMessage[] = []
  let deliver!: (msg: IncomingMessage) => void
  const t = createTestVela({
    files: { 'faq.md': 'Opening hours: 9:00-18:00' },
    responses: [
      fauxToolCall('read_file', { path: 'faq.md' }),
      fauxText('We are open from 9 to 6'),
    ],
    extensions: [
      (vela) =>
        vela.registerChannel({
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
          // This sender is the owner and can read files; the default (no roleFor) is guest
          roleFor: () => 'owner',
        }),
    ],
  })

  await captureConsole(async () => {
    deliver({
      channelId: 'c1',
      senderId: 'u1',
      senderName: 'Wang',
      text: 'When are you open?',
    })
    while (sent.length === 0) await Bun.sleep(1)
  })

  expect(sent).toEqual([
    { channelId: 'c1', recipientId: 'u1', text: 'We are open from 9 to 6' },
  ])
  expect(t.eventsOf('tool_execution_start')[0]).toMatchObject({
    toolName: 'read_file',
  })
  // Channel sessions are separate from the CLI session
  expect(t.messages).toEqual([])
  const { output } = await captureConsole(() => t.dispatch('/channel list'))
  expect(output).toContain('fake — test channel')
})
