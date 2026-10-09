import { afterEach, expect, test } from 'bun:test'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { z } from 'zod'
import type {
  IncomingMessage,
  OutgoingMessage,
} from '../../src/channels/types.ts'
import type { VelaExtension } from '../../src/extensions/types.ts'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
import { startTui, stopTuis } from '../support/terminal.ts'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
} from '../support/vela.ts'

afterEach(cleanupTestVelas)

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
  expect(t.eventsOf('tool_call')[0]).toMatchObject({ toolName: 'read_file' })
  // Channel sessions are separate from the CLI session
  expect(t.messages).toEqual([])
  const { output } = await captureConsole(() => t.dispatch('/channel list'))
  expect(output).toContain('fake — test channel')
})
