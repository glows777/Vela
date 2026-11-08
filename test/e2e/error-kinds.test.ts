import { afterEach, expect, test } from 'bun:test'
import { APICallError } from '@ai-sdk/provider'
import type { OutgoingMessage } from '@glows777/vela-channels'
import { fauxError, fauxHang, fauxText } from '@glows777/vela-core/testing'
import { runPrintMode } from '../../packages/vela/src/cli/print-mode.ts'
import { KEYS, startTui, stopTuis } from '../support/terminal.ts'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
} from '../support/vela.ts'

afterEach(async () => {
  await stopTuis()
  await cleanupTestVelas()
})

const apiError = (
  statusCode: number | undefined,
  message: string,
  responseBody?: string,
  cause?: unknown,
) =>
  new APICallError({
    statusCode,
    message,
    responseBody,
    cause,
    url: 'https://provider.example/chat/completions',
    requestBodyValues: {},
  })

const cases = [
  {
    name: '401',
    error: apiError(401, 'Invalid key'),
    kind: 'auth',
    hint: 'Check your API key: /login or vela setup.',
    retries: 0,
  },
  {
    name: '403',
    error: apiError(403, 'Access denied'),
    kind: 'auth',
    hint: 'Check your API key: /login or vela setup.',
    retries: 0,
  },
  {
    name: '402',
    error: apiError(402, 'Payment required'),
    kind: 'billing',
    hint: 'Check your provider balance and billing limits.',
    retries: 0,
  },
  {
    name: 'balance body',
    error: apiError(
      400,
      'Request rejected',
      '{"error":{"message":"Insufficient Balance"}}',
    ),
    kind: 'billing',
    hint: 'Check your provider balance and billing limits.',
    retries: 0,
  },
  {
    name: '429 quota body',
    error: apiError(
      429,
      'Quota exhausted',
      '{"error":{"code":"insufficient_quota"}}',
    ),
    kind: 'billing',
    hint: 'Check your provider balance and billing limits.',
    retries: 1,
  },
  {
    name: '429 after retries',
    error: apiError(429, 'Too many requests'),
    kind: 'rate_limit',
    hint: 'Wait a moment and retry, or use another model.',
    retries: 1,
  },
  {
    name: 'network',
    error: new Error('fetch failed: ECONNRESET'),
    kind: 'network',
    hint: 'Check your connection and provider URL, then retry.',
    retries: 1,
  },
  {
    name: 'network cause',
    error: apiError(
      undefined,
      'Cannot connect',
      undefined,
      Object.assign(new Error('socket closed'), { code: 'EPIPE' }),
    ),
    kind: 'network',
    hint: 'Check your connection and provider URL, then retry.',
    retries: 0,
  },
  {
    name: 'context overflow',
    error: apiError(
      400,
      'Request too long',
      '{"error":{"code":"context_length_exceeded"}}',
    ),
    kind: 'context_overflow',
    hint: 'Shorten the conversation or start a new session.',
    retries: 0,
  },
  {
    name: 'Bedrock throttling is not context overflow',
    error: apiError(
      400,
      'Throttling error: Too many tokens, please wait before trying again.',
    ),
    kind: 'provider',
    hint: 'Check the provider status and model settings, then retry.',
    retries: 0,
  },
  {
    name: 'provider',
    error: apiError(503, 'Service unavailable'),
    kind: 'provider',
    hint: 'Check the provider status and model settings, then retry.',
    retries: 1,
  },
  {
    name: 'unknown',
    error: new Error('Unexpected failure'),
    kind: 'unknown',
    hint: 'Check the error above and retry; if it persists, report it.',
    retries: 0,
  },
] as const

for (const scenario of cases) {
  const fixture = () =>
    createTestVela({
      responses: Array.from({ length: scenario.retries + 1 }, () =>
        fauxError(scenario.error),
      ),
      limits: { maxRetries: 1 },
      session: { autoCompaction: false },
    })

  test(`${scenario.name}: SDK keeps the raw error and retry count and adds a kind`, async () => {
    const t = fixture()
    await expect(t.run('hello')).rejects.toBe(scenario.error)
    const end = t.eventsOf('agent_end').at(-1)
    expect(end).toMatchObject({ reason: 'error', errorKind: scenario.kind })
    expect(end?.error).toBe(scenario.error)
    expect(t.eventsOf('auto_retry_start')).toHaveLength(scenario.retries)
  })

  test(`${scenario.name}: print mode keeps the raw error and adds one hint`, async () => {
    const t = fixture()
    const { result, output } = await captureConsole(() =>
      runPrintMode({
        vela: t.vela,
        session: t.session,
        messages: ['hello'],
        mode: 'text',
      }),
    )
    expect(result).toBe(1)
    expect(output).toContain(scenario.error.message)
    expect(output.split(scenario.hint)).toHaveLength(2)
  })

  test(`${scenario.name}: channel reply keeps the raw error and adds one hint`, async () => {
    const t = fixture()
    const sent: OutgoingMessage[] = []
    t.internals.gateway.register({
      name: 'fake',
      description: 'test',
      start() {},
      stop() {},
      async send(message) {
        sent.push(message)
      },
    })
    t.vela.session('fake-c1', { autoCompaction: false })
    await t.internals.gateway.handleIncoming('fake', {
      channelId: 'c1',
      senderId: 'u1',
      senderName: 'User',
      text: 'hello',
    })
    const reply = sent.find((message) =>
      message.text.startsWith('Task failed:'),
    )
    expect(reply?.text).toContain(scenario.error.message)
    expect(reply?.text.split(scenario.hint)).toHaveLength(2)
    expect(t.eventsIn('fake-c1')).toContainEqual(
      expect.objectContaining({ type: 'agent_end', errorKind: scenario.kind }),
    )
  })

  test(`${scenario.name}: TUI keeps the raw error and displays the hint`, async () => {
    const t = fixture()
    const tui = await startTui(t.vela, { sessionId: 'default' })
    await tui.started
    tui.terminal.type('hello')
    tui.terminal.press(KEYS.enter)
    await tui.until(() => t.eventsOf('agent_settled').length > 0)
    expect(tui.screen()).toContain(scenario.error.message)
    expect(tui.screen()).toContain(scenario.hint)
  })
}

test('successful and aborted runs do not acquire an error kind', async () => {
  const t = createTestVela({ responses: [fauxText('ok'), fauxHang('Waiting')] })
  await t.run('hello')
  const running = t.run('stop')
  const deadline = Date.now() + 2000
  while (!t.streamedText().includes('Waiting')) {
    if (Date.now() > deadline) throw new Error('Faux stream did not start')
    await Bun.sleep(1)
  }
  t.session.abort()
  await expect(running).rejects.toThrow()
  expect(t.eventsOf('agent_end').map((event) => event.reason)).toEqual([
    'done',
    'aborted',
  ])
  for (const end of t.eventsOf('agent_end'))
    expect(end).not.toHaveProperty('errorKind')
})

for (const followUpFails of [false, true]) {
  for (const surface of ['print', 'channel'] as const) {
    test(`${surface}: the first failure keeps its hint after a ${followUpFails ? 'failed' : 'successful'} queued follow-up`, async () => {
      const error = apiError(401, 'Original invalid key')
      const t = createTestVela({
        responses: [
          fauxError(error),
          followUpFails
            ? fauxError(apiError(402, 'Later billing error'))
            : fauxText('Follow-up done'),
        ],
      })
      const session =
        surface === 'print' ? t.session : t.vela.session('fake-c1')
      let queued = false
      session.subscribe((event) => {
        if (event.type === 'agent_start' && !queued) {
          queued = true
          session.followUp('Queued follow-up')
        }
      })
      let output: string
      if (surface === 'print') {
        const captured = await captureConsole(() =>
          runPrintMode({
            vela: t.vela,
            session,
            messages: ['hello'],
            mode: 'text',
          }),
        )
        expect(captured.result).toBe(1)
        output = captured.output
      } else {
        const sent: OutgoingMessage[] = []
        t.internals.gateway.register({
          name: 'fake',
          description: 'test',
          start() {},
          stop() {},
          async send(message) {
            sent.push(message)
          },
        })
        await t.internals.gateway.handleIncoming('fake', {
          channelId: 'c1',
          senderId: 'u1',
          senderName: 'User',
          text: 'hello',
        })
        output = sent.find((message) =>
          message.text.startsWith('Task failed:'),
        )!.text
      }
      expect(t.model.calls).toHaveLength(2)
      expect(output).toContain('Original invalid key')
      expect(output).toContain('Check your API key: /login or vela setup.')
      expect(output).not.toContain('Check your provider balance')
    })
  }
}
