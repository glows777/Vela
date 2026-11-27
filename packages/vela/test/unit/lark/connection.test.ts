import { afterEach, expect, test } from 'bun:test'
import * as sdk from '@larksuiteoapi/node-sdk'
import { silentLogger } from '../../../src/driver/index.ts'
import { LarkConnection } from '../../../src/lark/connection.ts'
import { createLarkChannelAdapter } from '../../../src/lark/runtime-adapter.ts'
import {
  type LarkTransport,
  larkTransport,
} from '../../../src/lark/transport.ts'
import type { ChannelAdapterContext } from '../../../src/runtime/channels.ts'

type Connection = { connected: boolean; error?: string }
type Callbacks = {
  onReconnected?: () => void
  onReady?: () => void
  onError?: (error: Error) => void
  onReconnecting?: () => void
}
const originalStart = sdk.WSClient.prototype.start
const originalClose = sdk.WSClient.prototype.close
const originalAdapter = sdk.defaultHttpInstance.defaults.adapter
const originalInfo = console.info
const sockets: Callbacks[] = []

function intercept() {
  console.info = () => {}
  sdk.WSClient.prototype.start = async function () {
    sockets.push(this as unknown as Callbacks)
  }
  sdk.WSClient.prototype.close = () => {}
  sdk.defaultHttpInstance.defaults.adapter = async (config) => ({
    data: config.url?.includes('tenant_access_token')
      ? { code: 0, tenant_access_token: 'test-token', expire: 7200 }
      : { code: 0, bot: { open_id: 'bot' } },
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  })
}

afterEach(() => {
  sdk.WSClient.prototype.start = originalStart
  sdk.WSClient.prototype.close = originalClose
  sdk.defaultHttpInstance.defaults.adapter = originalAdapter
  console.info = originalInfo
  sockets.length = 0
})

const noopCtx: ChannelAdapterContext = {
  async ingest() {},
}

function makeAdapter(transport?: LarkTransport) {
  return createLarkChannelAdapter({
    appId: 'connection-test',
    appSecret: 'private-secret',
    owners: [],
    logger: silentLogger,
    transport,
  })
}

test('real SDK start resolution is not readiness; lifecycle callbacks update and clear safe connection errors', async () => {
  intercept()
  const conn = new LarkConnection()
  const states: Connection[] = []
  const unsubscribe = conn.subscribe((value) => states.push(value))
  const { report, transport } = conn.begin({
    appId: 'connection-test',
    appSecret: 'private-secret',
  })
  expect(transport).toBeDefined()
  await transport!.start(
    () => {},
    () => ({ toast: { type: 'info', content: '' } }),
  )
  expect(states.at(-1)).toEqual({ connected: false })
  const socket = sockets[0]!
  expect(socket.onReady).toBeFunction()
  expect(socket.onError).toBeFunction()
  expect(socket.onReconnecting).toBeFunction()
  socket.onReady!()
  expect(states.at(-1)).toEqual({ connected: true })
  socket.onError!(new Error('private-secret https://provider/?token=private'))
  expect(states.at(-1)).toEqual({
    connected: false,
    error: 'Lark connection failed',
  })
  socket.onReady!()
  expect(states.at(-1)).toEqual({ connected: true })
  socket.onReconnecting!()
  expect(states.at(-1)).toEqual({
    connected: false,
    error: 'Lark connection lost; reconnecting',
  })
  socket.onReconnected!()
  expect(states.at(-1)).toEqual({ connected: true })
  conn.stop()
  expect(states.at(-1)).toEqual({ connected: false })
  const count = states.length
  socket.onReady!()
  socket.onError!(new Error('late'))
  expect(states).toHaveLength(count)
  report({ connected: true })
  expect(states).toHaveLength(count)
  unsubscribe()
})

test('callbacks from a replaced real connection cannot change the current connection', async () => {
  intercept()
  const conn = new LarkConnection()
  const states: Connection[] = []
  conn.subscribe((value) => states.push(value))
  const firstRun = conn.begin({
    appId: 'connection-test',
    appSecret: 'private-secret',
  })
  await firstRun.transport!.start(
    () => {},
    () => ({ toast: { type: 'info', content: '' } }),
  )
  const first = sockets[0]!
  const secondRun = conn.begin({
    appId: 'connection-test',
    appSecret: 'private-secret',
  })
  await secondRun.transport!.start(
    () => {},
    () => ({ toast: { type: 'info', content: '' } }),
  )
  sockets[1]!.onReady!()
  first.onError!(new Error('old connection'))
  first.onReconnecting!()
  expect(states.at(-1)).toEqual({ connected: true })
  conn.stop()
})

test('quiet setup retains ready, error, reconnect callbacks and ignores callbacks after stop', async () => {
  intercept()
  const errors: Error[] = []
  let ready = 0
  const transport = larkTransport(
    'setup-test',
    'secret',
    true,
    (error) => errors.push(error),
    () => ready++,
  )
  await transport.start(
    () => {},
    () => ({ toast: { type: 'info', content: 'ignored' } }),
  )
  const socket = sockets[0]!
  const error = new Error('setup failed')
  socket.onReady!()
  socket.onError!(error)
  socket.onReconnecting!()
  expect(ready).toBe(1)
  expect(errors[0]).toBe(error)
  expect(errors[1]?.message).toBe('Lark connection dropped; retry setup')
  transport.stop()
  socket.onReady!()
  socket.onReconnected!()
  expect(ready).toBe(1)
})

test('custom transports use start success/failure fallback and ignore completion after stop', async () => {
  const transport = {
    getBotId: async () => 'bot',
    start: async () => {},
    stop() {},
  } as unknown as LarkTransport
  const adapter = makeAdapter(transport)
  await adapter.start(noopCtx)
  expect(adapter.status()).toEqual({ connected: true })
  transport.start = async () => {
    throw new Error('private-secret')
  }
  await expect(adapter.start(noopCtx)).rejects.toThrow('private-secret')
  expect(adapter.status()).toEqual({
    connected: false,
    error: 'Lark connection failed',
  })
  let finish!: () => void
  let started!: () => void
  const hasStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  transport.start = () =>
    new Promise<void>((resolve) => {
      finish = resolve
      started()
    })
  const starting = adapter.start(noopCtx)
  await hasStarted
  await adapter.stop()
  finish()
  await starting
  expect(adapter.status()).toEqual({ connected: false })
})

test('real SDK text create, reply and topic requests receive stable outbox UUIDs', async () => {
  intercept()
  const adapter = makeAdapter()
  await adapter.start(noopCtx)
  const requests: { url: string; data: Record<string, unknown> }[] = []
  sdk.defaultHttpInstance.defaults.adapter = async (config) => {
    requests.push({
      url: config.url ?? '',
      data:
        typeof config.data === 'string' ? JSON.parse(config.data) : config.data,
    })
    return {
      data: {
        code: 0,
        data: {
          message_id: 'sent',
          create_time: '123',
          root_id: 'root',
          thread_id: 'thread',
        },
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }
  }
  try {
    await adapter.deliver({
      outboxId: 'create-stable-id',
      channel: 'lark',
      externalChatId: 'chat',
      text: 'new message',
    })
    await adapter.deliver({
      outboxId: 'reply-stable-id',
      channel: 'lark',
      externalChatId: 'chat',
      replyToMessageId: 'incoming',
      text: 'reply',
    })
    await adapter.deliver({
      outboxId: 'topic-stable-id',
      kind: 'topic_start',
      channel: 'lark',
      externalChatId: 'chat',
      replyToMessageId: 'incoming',
      title: 'topic title',
      text: 'topic title',
    })
    await adapter.deliver({
      outboxId: 'create-stable-id',
      channel: 'lark',
      externalChatId: 'chat',
      text: 'new message',
    })
    expect(requests.map((request) => request.data.uuid)).toEqual([
      'create-stable-id:send',
      'reply-stable-id:reply',
      'topic-stable-id:topic',
      'create-stable-id:send',
    ])
    expect(requests[0]).toMatchObject({
      url: expect.stringContaining('/im/v1/messages'),
      data: {
        receive_id: 'chat',
        msg_type: 'text',
        content: JSON.stringify({ text: 'new message' }),
      },
    })
    expect(requests[1]?.url).toContain('/im/v1/messages/incoming/reply')
    expect(requests[2]).toMatchObject({
      url: expect.stringContaining('/im/v1/messages/incoming/reply'),
      data: {
        reply_in_thread: true,
        content: JSON.stringify({ text: 'topic title' }),
      },
    })
  } finally {
    await adapter.stop()
  }
})

test('SDK token request errors keep credential payloads out of console output', async () => {
  const secret = crypto.randomUUID()
  const printed: string[] = []
  const originalLog = console.log
  const originalError = console.error
  const originalWarn = console.warn
  const capture = (...args: unknown[]) => {
    printed.push(Bun.inspect(args))
  }
  intercept()
  console.log = capture
  console.error = capture
  console.warn = capture
  sdk.defaultHttpInstance.defaults.adapter = async () => {
    throw new Error(`Rejected request body: ${secret}`)
  }
  try {
    const transport = larkTransport(crypto.randomUUID(), secret)
    await expect(transport.getBotId()).rejects.toThrow()
    expect(printed.some((line) => line.includes(secret))).toBe(false)
  } finally {
    console.log = originalLog
    console.error = originalError
    console.warn = originalWarn
  }
})

test('stop() while start() is awaiting the lazy Lark SDK does not start a socket', async () => {
  intercept()
  const transport = larkTransport('app', 'secret')
  const pending = transport.start(
    () => {},
    () => ({ toast: { type: 'info', content: '' } }),
  )
  transport.stop()
  await pending
  expect(sockets).toHaveLength(0)
})
