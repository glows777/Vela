import { expect, test } from 'bun:test'
import { formatChannelEvent } from '../../../src/cli/serve.ts'

const at = new Date(2026, 9, 26, 8, 5, 3)

test('a channel event becomes one timestamped line; other events have none', () => {
  expect(
    formatChannelEvent(
      {
        type: 'channel_message',
        channel: 'lark',
        senderId: 'ou_1',
        senderName: 'Ada',
        text: 'hello\nthere',
      },
      at,
    ),
  ).toBe('2026-10-26 08:05:03 channel_message lark Ada: hello there')
  expect(
    formatChannelEvent(
      {
        type: 'channel_reply',
        channel: 'lark',
        recipientId: 'ou_1',
        text: 'hi',
      },
      at,
    ),
  ).toBe('2026-10-26 08:05:03 channel_reply lark → hi')
  expect(
    formatChannelEvent({ type: 'agent_start', input: 'x' } as never, at),
  ).toBeUndefined()
})

test('long channel text is cut to one screen line, errors included', () => {
  const long = 'x'.repeat(100)
  expect(
    formatChannelEvent(
      {
        type: 'channel_message',
        channel: 'lark',
        senderId: 'ou_1',
        senderName: 'Ada',
        text: long,
      },
      at,
    ),
  ).toBe(`2026-10-26 08:05:03 channel_message lark Ada: ${'x'.repeat(80)}…`)
  expect(
    formatChannelEvent(
      {
        type: 'channel_error',
        channel: 'lark',
        senderId: 'ou_1',
        error: new Error(`${long}\nsecond line`),
        aborted: false,
      },
      at,
    ),
  ).toBe(
    `2026-10-26 08:05:03 channel_error lark ou_1: Turn stopped: ${'x'.repeat(80)}…`,
  )
  expect(
    formatChannelEvent(
      {
        type: 'channel_error',
        channel: 'lark',
        senderId: 'ou_1',
        error: new Error('ignored when aborted'),
        aborted: true,
      },
      at,
    ),
  ).toBe('2026-10-26 08:05:03 channel_error lark ou_1: Turn aborted')
})

test('terminal control sequences from chat text and names never reach the log', () => {
  // OSC 52 would write the operator's clipboard, and a CSI can repaint the terminal it logs to
  const clipboard = '\x1b]52;c;ZXZpbA==\x07'
  expect(
    formatChannelEvent(
      {
        type: 'channel_message',
        channel: 'lark',
        senderId: 'ou_1',
        senderName: `Ada${clipboard}`,
        text: `hi${clipboard}\x1b[31mred\x1b]0;PWNED\x07there\x00`,
      },
      at,
    ),
  ).toBe('2026-10-26 08:05:03 channel_message lark Ada: hiredthere')
})
