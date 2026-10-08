import { afterEach, expect, test } from 'bun:test'
import type { IncomingMessage, OutgoingMessage } from '../../src/channels/types.ts'
import { supabase } from '../../src/extensions/supabase.ts'
import { fauxText, fauxToolCall } from '../../src/testing/faux.ts'
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
    expect(t.dispatch('status')).toBe(true)
  })
  expect(output).toContain('System prompt')
  expect(output).toContain('Usage Summary')
  expect(output).toContain('1 step total')
  expect(output).toMatch(/Input\s+1\.2k tokens/)
  expect(output).toContain('[status] 2 messages')
})

test('the supabase extension registers tools the model can call, listed by /extensions', async () => {
  const t = createTestVela({
    extensions: [supabase()],
    responses: [
      (req) => {
        expect(req.tools).toContain('supabase_list_tables')
        return fauxToolCall('supabase_list_tables', {})
      },
      (req) =>
        fauxText(
          req.toolResults[0]!.output.includes('users') ? 'There is a users table' : '?',
        ),
    ],
  })

  await t.run('Which tables are there?')
  expect(t.lastAssistantText()).toBe('There is a users table')

  const { output } = await captureConsole(() => t.dispatch('/extensions'))
  expect(output).toContain('supabase')
  expect(output).toContain('supabase_list_tables')
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
